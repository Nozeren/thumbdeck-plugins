<script>
  // The Logs tab: the project's log files (each with its activity), then one log with a timeline
  // of when things happened, levels, search, error jumps, live tail, folded repeats, optional
  // sections, one request's lines (=), and the highlighted line's entry beside it. Keys come
  // from thumbdeck as actions (plugin.toml: [keys.files], [keys.log], [keys.levels], [keys.entry]).
  import { tick } from "svelte";
  import { age, ancestors, copyText, extraFields, findLine, histogram, jsonRows, lineOf, parentIndex, requestOf, rows } from "./tree.js";

  const td = window.thumbdeck;
  const say = (text, error = false) => td.ui.say(text, { error });

  const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"];
  const ROW = 21; // px per row (keep in sync with .row height)

  let setup = $state({ title: "Logs", folders: [], pattern: "*.log", blocks: [], fields: {}, line_pattern: "" });
  let active = $state(false);
  let visible = $state(true);
  let ready = $state(false);

  // ------------------------------------------------------------ file list
  let files = $state([]);
  let missing = $state([]);
  let listed = $state(false);
  let listCursor = $state(0);
  let summary = $state(null); // a summary, or { error }
  let summaryFor = "";
  /** Every file's summary (its activity graph and counts in the list), by path and change */
  let summaries = $state({});
  async function loadSummaries() {
    for (const f of files) {
      const key = `${f.path}:${f.mtime}`;
      if (summaries[key]) continue;
      try {
        summaries[key] = await td.backend.call("summary", { file: f.path, setup: $state.snapshot(setup) });
      } catch {
        summaries[key] = { error: true };
      }
    }
  }

  async function refreshList() {
    let res;
    try {
      res = await td.backend.call("list", { setup: $state.snapshot(setup) });
    } catch (err) {
      say(err.message, true);
      return;
    }
    const selected = files[listCursor]?.path;
    files = res.files;
    missing = res.missing;
    listed = true;
    const i = files.findIndex((f) => f.path === selected);
    listCursor = i >= 0 ? i : Math.min(listCursor, Math.max(0, files.length - 1));
    loadSummary();
    loadSummaries();
  }

  async function loadSummary() {
    const f = files[listCursor];
    const key = f ? `${f.path}:${f.mtime}` : "";
    if (key === summaryFor) return;
    summaryFor = key;
    summary = null;
    if (!f) return;
    try {
      const s = await td.backend.call("summary", { file: f.path, setup: $state.snapshot(setup) });
      if (summaryFor === key) summary = s;
    } catch (err) {
      if (summaryFor === key) summary = { error: err.message };
    }
  }

  function moveList(to) {
    if (!files.length) return;
    listCursor = Math.max(0, Math.min(files.length - 1, to));
    loadSummary();
    document.getElementById(`log-file-${listCursor}`)?.scrollIntoView({ block: "nearest" });
  }

  // The list refreshes every 3s while shown, so a run's new log shows up by itself
  $effect(() => {
    if (log || !ready || !visible) return;
    refreshList();
    const timer = setInterval(refreshList, 3000);
    return () => clearInterval(timer);
  });

  // ------------------------------------------------------------ one log
  let file = $state(null);
  let log = $state(null);
  let opened = $state(new Set());
  let hidden = $state(new Set());
  let cursorKey = $state(null);
  let cursorLine = 0; // where the cursor was, for when its row goes away (a level hidden)
  let tailing = $state(false);
  let status = $state(""); // search status
  let searching = $state(false);
  let query = $state("");
  let matches = [];
  let matchIndex = -1;
  let scroller = $state(null);
  let scrollTop = $state(0);
  let height = $state(400);
  let searchEl = $state(null);

  /** Repeats (the same line again but for its time) as one row with ×n; c turns it off */
  let fold = $state(true);
  /** Only one request's lines (=): [field, value], or null */
  let only = $state(null);
  /** The entry pane beside the log (i hides it) */
  let pane = $state(true);
  const list = $derived(log ? rows(log.outline, log.lines, opened, hidden, {
    fold,
    only: only ? (l) => String(l.data?.[only[0]] ?? "") === only[1] : null,
  }) : []);
  const timeline = $derived(log ? histogram(log.lines, 90) : null);
  const counts = $derived.by(() => {
    const c = { DEBUG: 0, INFO: 0, WARNING: 0, ERROR: 0 };
    for (const l of log?.lines ?? []) if (l.level in c) c[l.level]++;
    return c;
  });
  const parentsOf = $derived(log ? ancestors(log.outline) : new Map());
  const cursor = $derived.by(() => {
    const i = list.findIndex((r) => r.key === cursorKey);
    if (i >= 0) return i;
    const next = list.findIndex((r) => lineOf(r) >= cursorLine);
    return next >= 0 ? next : Math.max(0, list.length - 1);
  });
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - 10));
  const shown = $derived(list.slice(first, first + Math.ceil(height / ROW) + 20));

  /** Read a log; the avatar in the top bar reads along */
  let reading = 0;
  async function readLog(path) {
    if (reading++ === 0) td.ui.mood("reading", true);
    try {
      return await td.backend.call("open", { file: path, setup: $state.snapshot(setup) });
    } finally {
      if (--reading === 0) td.ui.mood("reading", null);
    }
  }

  async function openLog(f) {
    try {
      const loaded = await readLog(f.path);
      file = f;
      log = loaded;
      opened = new Set();
      hidden = new Set();
      cursorKey = null;
      cursorLine = 0;
      tailing = false;
      status = "";
      matches = [];
      only = null;
      await tick();
      if (scroller) scroller.scrollTop = 0;
    } catch (err) {
      say(err.message, true);
    }
  }

  function backToList() {
    log = null;
    file = null;
    detail = null;
    tailing = false;
    only = null;
  }

  /** Read the file again, keeping what's open and where the cursor is */
  async function reload() {
    if (!file) return;
    const atEnd = list.length > 0 && cursor === list.length - 1;
    try {
      log = await readLog(file.path);
    } catch (err) {
      say(err.message, true);
      return;
    }
    if (atEnd && tailing) setCursor(list.length - 1); // follow the end while tailing
  }

  function setCursor(i) {
    if (!list.length) return;
    i = Math.max(0, Math.min(list.length - 1, i));
    cursorKey = list[i].key;
    cursorLine = lineOf(list[i]);
    if (!scroller) return;
    if (i * ROW < scroller.scrollTop) scroller.scrollTop = i * ROW;
    else if ((i + 1) * ROW > scroller.scrollTop + height) scroller.scrollTop = (i + 1) * ROW - height;
  }

  /** Open the blocks around a line, then put the cursor on it */
  async function reveal(line) {
    const keys = parentsOf.get(line) ?? [];
    if (keys.some((k) => !opened.has(k))) opened = new Set([...opened, ...keys]);
    await tick();
    const i = list.findIndex((r) => r.type === "line" && r.line === line);
    if (i >= 0) setCursor(i);
  }

  function toggle(r) {
    if (r.type !== "block") return;
    const next = new Set(opened);
    if (next.has(r.key)) next.delete(r.key);
    else next.add(r.key);
    opened = next;
  }

  function jumpTo(direction, match, none) {
    if (!log?.lines.length) return;
    const from = list[cursor] ? lineOf(list[cursor]) : direction > 0 ? -1 : 0;
    const found = findLine(log.lines, from, direction, hidden, match);
    if (found === null) say(none);
    else reveal(found);
  }

  function toggleLevel(level) {
    const next = new Set(hidden);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    hidden = next;
    say(`${level} lines ${next.has(level) ? "hidden" : "visible"}`);
  }

  // Search: Enter jumps to the first match, then n / N go through them
  let marked = $state(""); // the search's words, marked in the rows
  function submitSearch() {
    const q = query.trim().toLowerCase();
    marked = q;
    searching = false;
    matches = [];
    matchIndex = -1;
    if (q && log) {
      matches = log.lines.flatMap((l, i) => (!hidden.has(l.level) && l.message.toLowerCase().includes(q) ? [i] : []));
    }
    if (!q) status = "";
    else if (!matches.length) status = `no matches for '${q}'`;
    else goToMatch(1);
  }

  function goToMatch(direction) {
    if (!matches.length) return;
    matchIndex = (matchIndex + direction + matches.length) % matches.length;
    reveal(matches[matchIndex]);
    status = `match ${matchIndex + 1}/${matches.length}`;
  }

  function searchKey(e) {
    if (e.key === "Enter") submitSearch();
    else if (e.key === "Escape") (searching = false), (status = ""), (marked = "");
    else return;
    e.preventDefault();
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      say(`copied ${what}`);
    } catch {
      say("couldn't copy to the clipboard", true);
    }
  }

  // Live tail: read the file again when it grows (every 2s)
  let lastSize = -1;
  $effect(() => {
    if (!tailing || !file) return;
    const f = file.path;
    lastSize = log?.size ?? -1;
    const timer = setInterval(async () => {
      const size = await td.backend.call("size", { file: f });
      if (size !== null && size !== lastSize) {
        lastSize = size;
        reload();
      }
    }, 2000);
    return () => clearInterval(timer);
  });

  // ------------------------------------------------------------ detail view (one entry)
  let detail = $state(null); // line number, while the entry pane has the keyboard
  let detailCursor = $state(0);
  let detailClosed = $state(new Set());
  let detailOpened = $state(new Set());
  /** The line the pane shows: the one it has the keyboard on, else the highlighted one */
  const paneLine = $derived(detail ?? (list[cursor]?.type === "line" ? list[cursor].line : null));
  const detailRows = $derived(paneLine !== null && log ? jsonRows(log.lines[paneLine].data, detailClosed, detailOpened) : []);
  /** The highlighted line's request, and that request's lines */
  const request = $derived(paneLine !== null && log ? requestOf(log.lines[paneLine].data) : null);
  const requestLines = $derived(request && log ? log.lines.flatMap((l, i) => (String(l.data?.[request[0]] ?? "") === request[1] ? [i] : [])).slice(0, 60) : []);
  // The selected value in full, when the row can't show it (long, or several lines: a traceback)
  const fullValue = $derived.by(() => {
    const v = detail === null ? (detailRows.find((r) => typeof r.value === "string" && r.value.includes("\n"))?.value ?? null) : detailRows[detailCursor]?.value;
    return typeof v === "string" && (v.length > 80 || v.includes("\n")) ? v : null;
  });

  function showDetail(line) {
    detail = line;
    pane = true;
    detailCursor = 0;
    detailClosed = new Set();
    detailOpened = new Set();
  }

  function toggleDetail(i) {
    const r = detailRows[i];
    if (!r?.container) return;
    if (r.depth === 0) {
      const next = new Set(detailClosed);
      if (r.open) next.add(r.path);
      else next.delete(r.path);
      detailClosed = next;
    } else {
      const next = new Set(detailOpened);
      if (r.open) next.delete(r.path);
      else next.add(r.path);
      detailOpened = next;
    }
  }

  function detailAction(action, key) {
    const r = detailRows[detailCursor];
    const move = (i) => {
      detailCursor = Math.max(0, Math.min(detailRows.length - 1, i));
      document.getElementById(`log-detail-${detailCursor}`)?.scrollIntoView({ block: "nearest" });
    };
    switch (action) {
      case "down": return move(detailCursor + 1);
      case "up": return move(detailCursor - 1);
      case "first": return move(0);
      case "last": return move(detailRows.length - 1);
      case "open": return toggleDetail(detailCursor);
      case "close": {
        if (r?.container && r.open) return toggleDetail(detailCursor);
        const depth = r?.depth ?? 0;
        for (let i = detailCursor - 1; i >= 0; i--) if (detailRows[i].depth < depth) return move(i);
        return;
      }
      case "copy":
        if (key === "Y") {
          if (detail !== null && log) copy(JSON.stringify(log.lines[detail].data, null, 2), "the full entry");
        } else if (r) copy(copyText(r.value), `the value of '${r.key}'`);
        return;
      case "leave":
        detail = null;
        return;
    }
  }

  // ------------------------------------------------------------ keys
  /** f was pressed: the next key picks a level */
  let levels = $state(false);

  // The keys follow what's shown: the files, a log, a line's entry, or picking levels
  $effect(() => td.keys.use(detail !== null ? "entry" : !log ? "files" : levels ? "levels" : "log"));

  function onAction(action, key) {
    if (detail !== null) return detailAction(action, key);
    if (!log) return listAction(action);
    if (levels) {
      levels = false;
      if (action === "all") (hidden = new Set()), say("all levels visible");
      else if (action !== "leave") toggleLevel(action);
      return;
    }

    const r = list[cursor];
    const page = Math.max(1, Math.floor(height / ROW));
    switch (action) {
      case "down": return setCursor(cursor + 1);
      case "up": return setCursor(cursor - 1);
      case "first": return log.lines.length && reveal(0);
      case "last": return log.lines.length && reveal(log.lines.length - 1);
      case "page-down": return setCursor(cursor + Math.trunc(page / 2));
      case "page-up": return setCursor(cursor - Math.trunc(page / 2));
      case "full-down": return setCursor(cursor + page);
      case "full-up": return setCursor(cursor - page);
      case "open":
        if (r?.type === "block") toggle(r);
        else if (r) showDetail(r.line);
        return;
      case "close":
        if (r?.type === "block" && r.open) return toggle(r);
        {
          const p = parentIndex(list, cursor);
          if (p !== null) setCursor(p);
        }
        return;
      case "error": return jumpTo(key === "E" ? -1 : 1, (l) => l.level === "ERROR", "no ERROR lines");
      case "search":
        searching = true;
        query = "";
        tick().then(() => searchEl?.focus());
        return;
      case "match": return goToMatch(key === "N" ? -1 : 1);
      case "tail":
        tailing = !tailing;
        return say(`live tail ${tailing ? "on" : "off"}`);
      case "levels":
        levels = true;
        return;
      case "copy":
        if (key === "Y") {
          if (r?.type === "line") copy(JSON.stringify(log.lines[r.line].data), "the JSON");
        } else if (r?.type === "line") copy(log.lines[r.line].message, "the message");
        else if (r) copy(r.node.name, "the title");
        return;
      case "refresh": return reload();
      case "fold":
        fold = !fold;
        return say(fold ? "repeats folded" : "every line");
      case "request": {
        const req = r?.type === "line" ? requestOf(log.lines[r.line].data) : null;
        if (only) (only = null), say("every request");
        else if (req) (only = req), say(`only ${req[0]}=${req[1]}`);
        else say("this line has no request id (req, request_id, trace_id…)");
        return;
      }
      case "pane": pane = !pane; return;
      case "back": return backToList();
      case "leave":
        if (only) return void ((only = null), say("every request"));
        if (!status && !marked) td.keys.release(); // nothing to close: give the keyboard back
        status = "";
        marked = "";
        return;
    }
  }

  function listAction(action) {
    switch (action) {
      case "down": return moveList(listCursor + 1);
      case "up": return moveList(listCursor - 1);
      case "first": return moveList(0);
      case "last": return moveList(files.length - 1);
      case "open": return files[listCursor] && openLog(files[listCursor]);
      case "refresh": return refreshList();
    }
  }

  td.on("key", ({ action, key }) => onAction(action, key));
  td.on("keyboard", (has) => (active = has));
  td.on("shown", () => (visible = true));
  td.on("hidden", () => (visible = false));
  td.on("setup", (s) => {
    setup = s;
    summaryFor = "";
    if (log) reload();
    else refreshList();
  });
  td.setup.get().then((s) => {
    setup = s;
    ready = true;
  });

  const levelColor = (level) => ({ DEBUG: "grey", INFO: "blue", WARNING: "yellow", ERROR: "red" })[level] ?? "fg";
  const LEVEL_NAMES = { DEBUG: "Debug", INFO: "Info", WARNING: "Warn", ERROR: "Error" };
  const shortTime = (t) => (/(\d\d:\d\d:\d\d)/.exec(t ?? "")?.[1] ?? "");
  const fieldsOf = (l) => extraFields(l.data, setup.fields);
  /** The message with the search's words marked (escaped first) */
  function markedHtml(text) {
    const esc = window.thumbdeck.escape(text);
    if (!marked) return esc;
    const m = window.thumbdeck.escape(marked).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return esc.replace(new RegExp(m, "gi"), (x) => `<mark>${x}</mark>`);
  }
  /** Bars of a timeline or activity graph: [debug, info, warning, error] per stretch, as SVG rectangles */
  function bars(bins, width, height) {
    const max = Math.max(1, ...bins.map((b) => b[0] + b[1] + b[2] + b[3]));
    const w = width / bins.length;
    const colours = ["var(--bg3)", "var(--blue)", "var(--yellow)", "var(--red)"];
    return bins.flatMap((b, i) => {
      let y = height;
      return b.flatMap((n, k) => {
        if (!n) return [];
        const h = (n / max) * (height - 1);
        y -= h;
        return [{ x: i * w + 0.5, y, w: Math.max(0.6, w - 1), h, fill: colours[k] }];
      });
    });
  }
  const timelineBars = $derived(timeline ? bars(timeline.bins.map((b) => [b.DEBUG + b.other, b.INFO, b.WARNING, b.ERROR]), 1000, 34) : []);
  /** The part of the log on screen, framed on the timeline */
  const frame = $derived.by(() => {
    if (!timeline || !list.length) return null;
    const firstRow = list[Math.min(list.length - 1, Math.floor(scrollTop / ROW))];
    const lastRow = list[Math.min(list.length - 1, Math.floor((scrollTop + height) / ROW))];
    const t = (r) => timeline.times[lineOf(r)];
    const [a, b] = [t(firstRow), t(lastRow)];
    if (a == null || b == null) return null;
    const x = (v) => ((v - timeline.t0) / Math.max(1, timeline.t1 - timeline.t0)) * 1000;
    return { x: Math.min(x(a), x(b)), w: Math.max(3, Math.abs(x(b) - x(a))) };
  });
  /** Clicking the timeline goes to the line nearest that moment */
  function clickTimeline(e) {
    if (!timeline || !log) return;
    const box = e.currentTarget.getBoundingClientRect();
    const at = timeline.t0 + ((e.clientX - box.left) / box.width) * (timeline.t1 - timeline.t0);
    let best = -1;
    timeline.times.forEach((t, i) => t !== null && !hidden.has(log.lines[i].level) && (best < 0 || Math.abs(t - at) < Math.abs(timeline.times[best] - at)) && (best = i));
    if (best >= 0) reveal(best);
  }
  /** The marks on the log's right edge: where its errors and warnings are */
  const marks = $derived.by(() => {
    if (!log || !list.length) return [];
    const n = list.length;
    return list.flatMap((r, i) => (r.type === "line" && (log.lines[r.line].level === "ERROR" || log.lines[r.line].level === "WARNING") ? [{ top: (i / n) * 100, error: log.lines[r.line].level === "ERROR" }] : []));
  });
  const activityOf = (f) => summaries[`${f.path}:${f.mtime}`];
  const kindLabel = (k) => (k === "string" ? "str" : k);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="viewer" class:active>
  {#if !log}
    <header class="bar">
      <strong>{setup.title || "Logs"}</strong>
      <span class="dim">{setup.folders.filter((f) => f.trim()).join(", ")} · {setup.pattern}</span>
      <span class="spacer"></span>
      <button class="tool" title="Set up this tab (S)" onclick={() => td.setup.edit()}>⚙ setup <kbd>S</kbd></button>
    </header>
    {#if listed && !files.length && missing.length}
      <p class="note">not found: {missing.join(", ")}. Check the folders in ⚙ setup.</p>
    {/if}
    <div class="picker">
      <ul class="files">
        {#each files as f, i (f.path)}
          {@const a = activityOf(f)}
          <li id="log-file-{i}">
            <button class="file" class:cursor={i === listCursor} onclick={() => moveList(i)} ondblclick={() => openLog(f)}>
              <span class="fl1"><span class="dot" class:err={f.error}>●</span><span class="fname">{f.name}</span><span class="dim">{age(f.mtime)}</span></span>
              {#if a?.activity}
                <svg class="spark" viewBox="0 0 200 20" preserveAspectRatio="none">{#each bars(a.activity, 200, 20) as b}<rect x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} />{/each}</svg>
              {/if}
              {#if a && !a.error}
                <span class="fl2 dim"><span>{a.total} lines</span>{#if a.span}<span>{a.span[0]}–{a.span[1]}</span>{/if}
                  {#if a.levels.find(([l]) => l === "ERROR")?.[1]}<span class="err">{a.levels.find(([l]) => l === "ERROR")[1]} ✗</span>{/if}
                  {#if a.levels.find(([l]) => l === "WARNING")?.[1]}<span class="warn">{a.levels.find(([l]) => l === "WARNING")[1]} ⚠</span>{/if}</span>
              {/if}
            </button>
          </li>
        {:else}
          <li class="dim empty">{listed ? `No ${setup.pattern} files here yet.` : "Looking…"}</li>
        {/each}
      </ul>
      <aside class="preview">
        {#if files[listCursor]}
          <strong>{files[listCursor].name}</strong>
          {#if summary && "error" in summary}
            <p class="err">{summary.error}</p>
          {:else if summary}
            <p>{summary.total} lines{summary.duration ? ` · ${summary.duration}` : ""}{summary.blocks ? ` · ${summary.blocks} sections` : ""}</p>
            {#if summary.activity}
              <svg class="spark big" viewBox="0 0 400 48" preserveAspectRatio="none">{#each bars(summary.activity, 400, 48) as b}<rect x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} />{/each}</svg>
              {#if summary.span}<p class="dim axis"><span>{summary.span[0]}</span><span>{summary.span[1]}</span></p>{/if}
            {/if}
            <p class="chips">
              {#each summary.levels as [level, n]}
                {#if n}<span class="td-chip" style="--c: var(--{levelColor(level)})">{LEVEL_NAMES[level] ?? level} <b>{n}</b></span>{/if}
              {/each}
            </p>
            {#if summary.first_error}
              <p class="dim">first error</p>
              <p class="err first-error">{summary.first_error}</p>
            {/if}
            <p class="dim">Open it <kbd>Enter</kbd></p>
          {:else}
            <p class="dim">…</p>
          {/if}
        {/if}
      </aside>
    </div>
  {:else if file}
    <header class="bar">
      <button class="tool" title="Back to the files (-)" onclick={backToList}>‹ {setup.title || "Logs"}</button>
      {#if searching || levels}<span class="mode" class:search={searching}>{searching ? "SEARCH" : "LEVELS"}</span>{/if}
      <strong class="fname">{file.name}</strong>
      <span class="levels">
        {#each LEVELS as level}
          <button class="td-chip" class:off={hidden.has(level)} style="--c: var(--{levelColor(level)})"
                  title="Show / hide {level} (f, then {level[0]})" onclick={() => toggleLevel(level)}>{LEVEL_NAMES[level]} <b>{counts[level]}</b></button>
        {/each}
        <kbd>f</kbd>
      </span>
      <span class="spacer"></span>
      {#if status}<span class="dim">{status}</span>{/if}
      <button class="tool" class:on={!fold} title="Fold repeats (c)" onclick={() => (fold = !fold)}>{fold ? "×n" : "all"} <kbd>c</kbd></button>
      <button class="tool" class:follow={tailing} title="Live tail (t)" onclick={() => onAction("tail")}>{tailing ? "● Following" : "Follow"} <kbd>t</kbd></button>
      <span class="dim">{list[cursor] ? `${lineOf(list[cursor]) + 1}/${log.lines.length}` : `${log.lines.length} lines`}</span>
    </header>
    {#if searching}
      <input class="search" bind:this={searchEl} bind:value={query} onkeydown={searchKey}
             placeholder="Search messages… (Enter jumps, then n / N)" />
    {/if}
    {#if timeline}
      <div class="timeline" title="When things happened (click: go there)" onclick={clickTimeline}>
        <svg viewBox="0 0 1000 34" preserveAspectRatio="none">
          {#each timelineBars as b}<rect x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} />{/each}
          {#if frame}<rect class="frame" x={frame.x} y="0" width={frame.w} height="34" />{/if}
        </svg>
        <div class="axis dim"><span>{new Date(timeline.t0).toISOString().slice(11, 19)}</span><span>{new Date((timeline.t0 + timeline.t1) / 2).toISOString().slice(11, 19)}</span><span>{new Date(timeline.t1).toISOString().slice(11, 19)}</span></div>
      </div>
    {/if}
    {#if only}
      <div class="only">Only {only[0]}={only[1]} · {list.length} line{list.length === 1 ? "" : "s"}<span class="spacer"></span><span class="dim">every line <kbd>=</kbd></span></div>
    {/if}
    <div class="body" class:with-pane={pane}>
      <div class="rowsbox">
        <div class="rows" bind:this={scroller} bind:clientHeight={height} onscroll={() => (scrollTop = scroller?.scrollTop ?? 0)}>
          <div style="height: {list.length * ROW}px; position: relative">
            {#each shown as r, j (r.key)}
              {@const i = first + j}
              {@const l = r.type === "line" ? log.lines[r.line] : null}
              <div class="row" class:cursor={i === cursor} class:error={l?.level === "ERROR"}
                   class:same={l && request && !only && i !== cursor && String(l.data?.[request[0]] ?? "") === request[1]}
                   style="top: {i * ROW}px; padding-left: {8 + r.depth * 16}px"
                   onclick={() => setCursor(i)}
                   ondblclick={() => (r.type === "block" ? toggle(r) : showDetail(r.line))}>
                {#if r.type === "block"}
                  <button class="caret" onclick={(e) => { e.stopPropagation(); setCursor(i); toggle(r); }}>{r.open ? "▾" : "▸"}</button>
                  <span class:err={r.node.has_error} class:ok={!r.node.has_error}>{r.node.kind === "bookmark" ? "◆" : "▸"}</span>
                  <strong>{r.node.name}</strong>
                  <span class="dim">({r.node.last_line - r.node.first_line + 1} lines)</span>
                {:else if l}
                  <span class="time">{shortTime(l.time)}</span>
                  <span class="pill {l.level}">{l.level === "WARNING" ? "WARN" : l.level === "UNKNOWN" ? "·" : l.level}</span>
                  <span class="msg">{@html markedHtml(l.message)}{#each fieldsOf(l) as [k, v]}<span class="field">{`  ${k}=`}<b>{v}</b></span>{/each}{#if r.count}<span class="rep">×{r.count}</span>{/if}</span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
        <div class="map" aria-hidden="true">
          {#each marks as m}<i class:error={m.error} style="top: {m.top}%"></i>{/each}
          <i class="view" style="top: {list.length ? (Math.floor(scrollTop / ROW) / list.length) * 100 : 0}%; height: {list.length ? Math.min(100, (height / ROW / list.length) * 100) : 100}%"></i>
        </div>
      </div>
      {#if pane && paneLine !== null}
        {@const pl = log.lines[paneLine]}
        <aside class="pane" class:keys={detail !== null}>
          <header class="phead">
            <span class="pill {pl.level}">{pl.level === "WARNING" ? "WARN" : pl.level}</span><strong>line {paneLine + 1}</strong>
            <span class="spacer"></span><span class="dim">{shortTime(pl.time)}</span>
          </header>
          <div class="json">
            {#each detailRows as d, i (d.path)}
              <div id="log-detail-{i}" class="drow" class:cursor={detail !== null && i === detailCursor} style="padding-left: {8 + d.depth * 14}px"
                   onclick={() => { detail = paneLine; detailCursor = i; toggleDetail(i); }}>
                {#if d.container}<span class="caret">{d.open ? "▾" : "▸"}</span>{/if}
                <span class="key" class:container={d.container}>{d.key}</span>{#if !d.container}:{/if}
                <span class="v {kindLabel(d.kind)}">{d.display}</span>
              </div>
            {/each}
          </div>
          {#if fullValue !== null}<pre class="full">{fullValue}</pre>{/if}
          {#if request && requestLines.length > 1}
            <section class="req">
              <h5>{request[0]} {request[1]} · {requestLines.length} lines</h5>
              {#each requestLines as li}
                {@const x = log.lines[li]}
                <div class="rq" class:me={li === paneLine} onclick={() => reveal(li)}><span class="time">{shortTime(x.time)}</span><span class="pill {x.level}">{x.level.slice(0, 4)}</span><span class="msg">{x.message}</span></div>
              {/each}
              <button class="tool" onclick={() => onAction("request")}>{only ? "Every line" : "Only this request"} <kbd>=</kbd></button>
            </section>
          {/if}
          <p class="dim hint">{detail !== null ? "j k move · l open · y copy · Esc back to the log" : "Enter: move into it · y copies · i hides this"}</p>
        </aside>
      {/if}
    </div>
  {/if}
</div>

<style>
  :global(#app) { height: 100%; display: flex; }
  .viewer { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; font: 12.5px var(--mono); }
  .bar { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--bg2); white-space: nowrap; }
  .spacer { flex: 1; }
  .dim { color: var(--grey); }
  .err { color: var(--red); } .ok { color: var(--green); }
  .note { margin: 6px 12px; color: var(--orange); }
  .tool { padding: 2px 8px; border: 0; background: none; border-radius: 6px; color: var(--grey); font: 12px var(--mono); }
  .tool:hover { background: var(--bg2); color: var(--fg); }
  .mode { padding: 0 6px; border-radius: 4px; background: var(--bg2); color: var(--aqua); font-weight: 700; }
  .mode.search { color: var(--orange); }
  .fname { overflow: hidden; text-overflow: ellipsis; }
  .levels { display: flex; gap: 2px; }
  /* the chips (td-chip) and key badges (kbd) come from thumbdeck's kit */
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .tool.on { color: var(--fg); }
  .tool.follow { color: var(--green); }
  .warn { color: var(--yellow); }
  .search { margin: 6px 12px; border-color: var(--orange); }

  .picker { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); }
  .files { list-style: none; margin: 0; padding: 6px; overflow: auto; border-right: 1px solid var(--bg2); }
  .file { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 7px 8px; border: 0; background: none; border-radius: 8px;
          text-align: left; font: 12.5px var(--mono); color: var(--fg); }
  .file .fl1, .file .fl2 { display: flex; gap: 8px; align-items: center; }
  .file .fl2 { font-size: 11px; }
  .file .fname { flex: 1; font-weight: 600; }
  .spark { display: block; width: 100%; height: 20px; }
  .spark.big { height: 48px; margin-top: 8px; }
  .axis { display: flex; justify-content: space-between; font-size: 10.5px; margin: 2px 0 0 !important; }
  .file.cursor { background: var(--bg2); }
  .viewer.active .file.cursor { outline: 1px solid var(--cursor, var(--orange)); }
  .dot { color: var(--green); } .dot.err { color: var(--red); }
  .empty { padding: 8px; }
  .preview { padding: 10px 14px; overflow: auto; }
  .preview p { margin: 6px 0; }
  .first-error { white-space: pre-wrap; word-break: break-word; }

  /* when things happened: lines per stretch by level, the part on screen framed */
  .timeline { padding: 6px 12px 2px; border-bottom: 1px solid var(--bg2); cursor: pointer; }
  .timeline svg { display: block; width: 100%; height: 34px; }
  .timeline .frame { fill: color-mix(in srgb, var(--fg) 10%, transparent); stroke: color-mix(in srgb, var(--fg) 50%, transparent); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .only { display: flex; gap: 8px; align-items: center; padding: 4px 12px; color: var(--purple); background: color-mix(in srgb, var(--purple) 7%, transparent); border-bottom: 1px solid var(--bg2); }
  .body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
  .body.with-pane { grid-template-columns: minmax(0, 1fr) minmax(240px, 34%); }
  .rowsbox { display: flex; min-height: 0; min-width: 0; }
  .rows { flex: 1; min-height: 0; overflow: auto; }
  .row { position: absolute; left: 0; right: 0; height: 21px; line-height: 21px; display: flex; gap: 8px; align-items: center;
         white-space: pre; overflow: hidden; cursor: default; padding-right: 8px; }
  .row.error { background: color-mix(in srgb, var(--red) 8%, transparent); }
  .row.same { background: color-mix(in srgb, var(--blue) 6%, transparent); }
  .time { flex: none; color: var(--grey-dim); font-variant-numeric: tabular-nums; }
  .pill { flex: none; width: 46px; text-align: center; border-radius: 4px; font: 600 9.5px/16px var(--mono); letter-spacing: 0.03em; }
  .pill.DEBUG { color: var(--grey); background: color-mix(in srgb, var(--grey) 12%, transparent); }
  .pill.INFO { color: var(--blue); background: color-mix(in srgb, var(--blue) 12%, transparent); }
  .pill.WARNING { color: var(--yellow); background: color-mix(in srgb, var(--yellow) 14%, transparent); }
  .pill.ERROR { color: var(--bg-dim); background: var(--red); }
  .pill.UNKNOWN { color: var(--grey); }
  .msg { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .msg :global(mark) { background: color-mix(in srgb, var(--yellow) 35%, transparent); color: inherit; border-radius: 2px; }
  .field { color: var(--grey-dim); } .field b { color: var(--aqua); font-weight: 400; }
  .rep { margin-left: 6px; padding: 0 6px; border-radius: 8px; background: var(--grey); color: var(--bg-dim); font-size: 10px; }
  /* where the errors and warnings are, and the part on screen */
  .map { position: relative; width: 10px; flex: none; border-left: 1px solid var(--bg2); }
  .map i { position: absolute; left: 1px; right: 1px; height: 2px; background: var(--yellow); }
  .map i.error { background: var(--red); height: 3px; }
  .map i.view { left: 0; right: 0; height: auto; background: color-mix(in srgb, var(--fg) 10%, transparent); border: 1px solid color-mix(in srgb, var(--fg) 30%, transparent); }
  .row:hover { background: var(--bg1); }
  .row.cursor { background: var(--bg2); }
  .viewer.active .row.cursor { box-shadow: inset 2px 0 var(--cursor, var(--orange)); }
  .caret { width: 12px; padding: 0; border: 0; background: none; color: var(--grey); font: 12px var(--mono); }

  /* the highlighted line's entry, beside the log */
  .pane { border-left: 1px solid var(--bg2); display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: auto; }
  .pane.keys { box-shadow: inset 0 0 0 1px var(--cursor, var(--orange)); }
  .phead { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--bg2); }
  .json { flex: none; padding: 4px 0; }
  .drow { display: flex; gap: 6px; align-items: baseline; padding: 1px 8px; cursor: default; white-space: nowrap; overflow: hidden; }
  .drow:hover { background: var(--bg1); }
  .drow.cursor { background: var(--bg2); box-shadow: inset 2px 0 var(--cursor, var(--orange)); }
  .req { padding: 8px 10px; border-top: 1px solid var(--bg2); display: flex; flex-direction: column; gap: 2px; }
  .req h5 { margin: 0 0 4px; font: 600 10.5px var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--grey); }
  .rq { display: flex; gap: 6px; align-items: baseline; padding: 1px 4px; border-radius: 4px; font-size: 11.5px; white-space: nowrap; overflow: hidden; cursor: pointer; }
  .rq:hover { background: var(--bg1); } .rq.me { background: var(--bg2); }
  .rq .pill { width: 38px; }
  .req .tool { align-self: flex-start; margin-top: 4px; }
  .hint { margin: 0; padding: 8px 10px; font-size: 11px; }
  @media (max-width: 600px) { .body.with-pane { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); } .pane { border-left: 0; border-top: 1px solid var(--bg2); } }
  .key { color: var(--blue); font-weight: 700; }
  .key.container { color: var(--purple); }
  .v { overflow: hidden; text-overflow: ellipsis; }
  .v.str { color: var(--yellow); } .v.number { color: var(--aqua); } .v.bool, .v.null { color: var(--purple); }
  .v.container { color: var(--grey); }
  .full { flex: none; margin: 0 10px 8px; padding: 8px 10px; border-radius: 6px; background: var(--bg-dim); color: var(--red);
          white-space: pre-wrap; word-break: break-word; font: 11.5px/1.45 var(--mono); }
</style>
