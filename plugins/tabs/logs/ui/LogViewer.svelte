<script>
  // The Logs tab: the project's log files, then one log with levels, search, error jumps, live
  // tail, optional sections and a detail view of one entry. Keys come from thumbdeck as actions
  // (plugin.toml: [keys.files], [keys.log], [keys.levels], [keys.entry]).
  import { tick } from "svelte";
  import { age, ancestors, copyText, findLine, formatLine, jsonRows, lineOf, parentIndex, rows } from "./tree.js";

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

  const list = $derived(log ? rows(log.outline, log.lines, opened, hidden) : []);
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
  function submitSearch() {
    const q = query.trim().toLowerCase();
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
    else if (e.key === "Escape") (searching = false), (status = "");
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
  let detail = $state(null); // line number
  let detailCursor = $state(0);
  let detailClosed = $state(new Set());
  let detailOpened = $state(new Set());
  const detailRows = $derived(detail !== null && log ? jsonRows(log.lines[detail].data, detailClosed, detailOpened) : []);
  // The selected value in full, when the row can't show it (long, or several lines: a traceback)
  const fullValue = $derived.by(() => {
    const v = detailRows[detailCursor]?.value;
    return typeof v === "string" && (v.length > 80 || v.includes("\n")) ? v : null;
  });

  function showDetail(line) {
    detail = line;
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
      case "back": return backToList();
      case "leave":
        if (!status) td.keys.release(); // nothing to close: give the keyboard back
        status = "";
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

  const levelColor = (level) => ({ DEBUG: "blue", INFO: "aqua", WARNING: "orange", ERROR: "red" })[level] ?? "fg";
  const kindLabel = (k) => (k === "string" ? "str" : k);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="viewer" class:active>
  {#if !log}
    <header class="bar">
      <strong>{setup.title || "Logs"}</strong>
      <span class="dim">{setup.folders.filter((f) => f.trim()).join(", ")} · {setup.pattern}</span>
      <span class="spacer"></span>
      <button class="tool" title="Set up this tab (S)" onclick={() => td.setup.edit()}>⚙ setup</button>
    </header>
    {#if listed && !files.length && missing.length}
      <p class="note">not found: {missing.join(", ")}. Check the folders in ⚙ setup.</p>
    {/if}
    <div class="picker">
      <ul class="files">
        {#each files as f, i (f.path)}
          <li id="log-file-{i}">
            <button class="file" class:cursor={i === listCursor} onclick={() => moveList(i)} ondblclick={() => openLog(f)}>
              <span class="dot" class:err={f.error}>●</span>
              <span class="fname">{f.name}</span>
              <span class="dim">{age(f.mtime)}</span>
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
            <p>
              {#each summary.levels as [level, n]}
                {#if n}<span class="lvl" style="color: var(--{levelColor(level)})">{level} {n}</span>{/if}
              {/each}
            </p>
            {#if summary.first_error}
              <p class="dim">first error</p>
              <p class="err first-error">{summary.first_error}</p>
            {/if}
            <p class="dim">Enter or double-click opens it</p>
          {:else}
            <p class="dim">…</p>
          {/if}
        {/if}
      </aside>
    </div>
  {:else if file}
    <header class="bar">
      <button class="tool" title="Back to the files (-)" onclick={backToList}>‹ {setup.title || "Logs"}</button>
      <span class="mode" class:search={searching}>{searching ? "SEARCH" : levels ? "LEVELS" : "NORMAL"}</span>
      <strong class="fname">{file.name}</strong>
      <span class="levels">
        {#each LEVELS as level}
          <button class="lvl" class:off={hidden.has(level)} style="color: var(--{levelColor(level)})"
                  title="Show / hide {level} (f, then {level[0]})" onclick={() => toggleLevel(level)}>{level[0]}</button>
        {/each}
      </span>
      {#if tailing}<span class="tail" title="Live tail (t)">● tail</span>{/if}
      <span class="spacer"></span>
      <span class="dim">{status}</span>
      <span class="dim">{list[cursor] ? `line ${lineOf(list[cursor]) + 1} of ${log.lines.length}` : `${log.lines.length} lines`}</span>
    </header>
    {#if searching}
      <input class="search" bind:this={searchEl} bind:value={query} onkeydown={searchKey}
             placeholder="Search messages… (Enter jumps, then n / N)" />
    {/if}
    <div class="rows" bind:this={scroller} bind:clientHeight={height} onscroll={() => (scrollTop = scroller?.scrollTop ?? 0)}>
      <div style="height: {list.length * ROW}px; position: relative">
        {#each shown as r, j (r.key)}
          {@const i = first + j}
          <div class="row" class:cursor={i === cursor} style="top: {i * ROW}px; padding-left: {8 + r.depth * 16}px"
               onclick={() => setCursor(i)}
               ondblclick={() => (r.type === "block" ? toggle(r) : showDetail(r.line))}>
            {#if r.type === "block"}
              <button class="caret" onclick={(e) => { e.stopPropagation(); setCursor(i); toggle(r); }}>{r.open ? "▾" : "▸"}</button>
              <span class:err={r.node.has_error} class:ok={!r.node.has_error}>{r.node.kind === "bookmark" ? "◆" : "▸"}</span>
              <strong>{r.node.name}</strong>
              <span class="dim">({r.node.last_line - r.node.first_line + 1} lines)</span>
            {:else}
              {@const l = log.lines[r.line]}
              <span class="text" class:bold={l.level === "ERROR"} style="color: var(--{levelColor(l.level)})">{formatLine(l)}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if detail !== null && log}
    <div class="overlay">
      <header class="bar">
        <strong>line {detail + 1}: full entry</strong>
        <span class="spacer"></span>
        <span class="dim">y value · Y all · Esc close</span>
      </header>
      <div class="json">
        {#each detailRows as d, i (d.path)}
          <div id="log-detail-{i}" class="row static" class:cursor={i === detailCursor} style="padding-left: {8 + d.depth * 16}px"
               onclick={() => { detailCursor = i; toggleDetail(i); }}>
            {#if d.container}<span class="caret">{d.open ? "▾" : "▸"}</span>{/if}
            <span class="key" class:container={d.container}>{d.key}</span>{#if !d.container}:{/if}
            <span class="v {kindLabel(d.kind)}">{d.display}</span>
          </div>
        {/each}
      </div>
      {#if fullValue !== null}<pre class="full">{fullValue}</pre>{/if}
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
  .bold { font-weight: 700; }
  .note { margin: 6px 12px; color: var(--orange); }
  .tool { padding: 2px 8px; border: 0; background: none; border-radius: 6px; color: var(--grey); font: 12px var(--mono); }
  .tool:hover { background: var(--bg2); color: var(--fg); }
  .mode { padding: 0 6px; border-radius: 4px; background: var(--bg2); color: var(--aqua); font-weight: 700; }
  .mode.search { color: var(--orange); }
  .fname { overflow: hidden; text-overflow: ellipsis; }
  .levels { display: flex; gap: 2px; }
  .lvl { font: 700 12px var(--mono); padding: 0 3px; border: 0; background: none; }
  .lvl.off { opacity: 0.35; text-decoration: line-through; }
  .tail { color: var(--green); }
  .search { margin: 6px 12px; border-color: var(--orange); }

  .picker { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); }
  .files { list-style: none; margin: 0; padding: 6px; overflow: auto; border-right: 1px solid var(--bg2); }
  .file { width: 100%; display: flex; gap: 8px; align-items: center; padding: 3px 8px; border: 0; background: none; border-radius: 6px;
          text-align: left; font: 12.5px var(--mono); color: var(--fg); }
  .file .fname { flex: 1; }
  .file.cursor { background: var(--bg2); }
  .viewer.active .file.cursor { outline: 1px solid var(--cursor, var(--orange)); }
  .dot { color: var(--green); } .dot.err { color: var(--red); }
  .empty { padding: 8px; }
  .preview { padding: 10px 14px; overflow: auto; }
  .preview p { margin: 6px 0; }
  .preview .lvl { margin-right: 8px; }
  .first-error { white-space: pre-wrap; word-break: break-word; }

  .rows { flex: 1; min-height: 0; overflow: auto; }
  .row { position: absolute; left: 0; right: 0; height: 21px; line-height: 21px; display: flex; gap: 6px; align-items: center;
         white-space: pre; overflow: hidden; cursor: default; padding-right: 8px; }
  .row.static { position: static; }
  .row:hover { background: var(--bg1); }
  .row.cursor { background: var(--bg2); }
  .viewer.active .row.cursor { box-shadow: inset 2px 0 var(--cursor, var(--orange)); }
  .text { overflow: hidden; text-overflow: ellipsis; }
  .caret { width: 12px; padding: 0; border: 0; background: none; color: var(--grey); font: 12px var(--mono); }

  .overlay { position: absolute; inset: 0; background: var(--bg0); display: flex; flex-direction: column; z-index: 5; }
  .json { flex: 0 1 auto; min-height: 0; overflow: auto; padding: 4px 0; }
  .key { color: var(--blue); font-weight: 700; }
  .key.container { color: var(--purple); }
  .v { overflow: hidden; text-overflow: ellipsis; }
  .v.str { color: var(--yellow); } .v.number { color: var(--aqua); } .v.bool, .v.null { color: var(--purple); }
  .v.container { color: var(--grey); }
  .full { flex: 1 1 40%; min-height: 0; overflow: auto; margin: 0; padding: 10px 14px; border-top: 1px solid var(--bg2);
          border-radius: 0; background: none; white-space: pre-wrap; word-break: break-word; font: 12.5px/1.45 var(--mono); }
</style>
