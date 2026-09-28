<script>
  // Setting up a Logs tab for a project: where the logs are, how lines are read, and
  // (optionally) what marks a section. The tab's setup_page: thumbdeck shows it in its setup
  // dialog (with Cancel and Remove), and it saves with thumbdeck.setup.save.
  const td = window.thumbdeck;

  // Edited as text: one folder / start / end per line, field names separated by commas
  const lines = (list) => (list ?? []).join("\n");
  const unlines = (text) => text.split("\n").map((s) => s.trim()).filter(Boolean);
  const commas = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);

  let loaded = $state(false);
  let title = $state("");
  let folders = $state("");
  let pattern = $state("");
  let blocks = $state([]);
  let fields = $state({ message: "", level: "", time: "" });
  let linePattern = $state("");
  let advanced = $state(false);
  let problems = $state([]);
  let saving = $state(false);

  function toRow(b) {
    const a = b.alias;
    return {
      name: b.name, kind: b.kind, start: lines(b.start), end: lines(b.end),
      alias: a?.type ?? "",
      value: a ? (a.type === "replace" ? a.value.from : a.value) : "",
      to: a?.type === "replace" ? a.value.to : "",
    };
  }

  function fromRow(r) {
    let alias = null;
    if (r.alias === "replace") alias = { type: "replace", value: { from: r.value, to: r.to } };
    else if (r.alias) alias = { type: r.alias, value: r.value };
    return { name: r.name.trim() || "section", kind: r.kind, start: unlines(r.start), end: unlines(r.end), alias };
  }

  td.setup.get().then((s) => {
    title = s.title ?? "";
    folders = lines(s.folders);
    pattern = s.pattern ?? "*.log";
    blocks = (s.blocks ?? []).map(toRow);
    fields = { message: lines(s.fields?.message).replaceAll("\n", ", "), level: lines(s.fields?.level).replaceAll("\n", ", "), time: lines(s.fields?.time).replaceAll("\n", ", ") };
    linePattern = s.line_pattern ?? "";
    advanced = linePattern !== "";
    loaded = true;
  });
  let titleEl = $state(null);
  // The title, ready to type in (again when the dialog gives this page the focus)
  const focusTitle = () => {
    titleEl?.focus();
    titleEl?.select();
  };
  $effect(() => {
    if (titleEl) focusTitle();
  });
  window.addEventListener("focus", focusTitle, { once: true });

  const current = $derived({
    title: title.trim() || "Logs",
    folders: unlines(folders),
    pattern: pattern.trim() || "*.log",
    blocks: blocks.map(fromRow),
    fields: { message: commas(fields.message), level: commas(fields.level), time: commas(fields.time) },
    line_pattern: linePattern,
  });

  // Check the setup as it's edited
  $effect(() => {
    const s = $state.snapshot(current);
    if (!loaded) return;
    const timer = setTimeout(async () => {
      try {
        problems = await td.backend.call("check", { setup: s });
      } catch (err) {
        problems = [err.message];
      }
    }, 200);
    return () => clearTimeout(timer);
  });

  async function save(e) {
    e.preventDefault();
    if (problems.length || saving) return;
    saving = true;
    try {
      await td.setup.save($state.snapshot(current));
    } catch (err) {
      problems = [err.message];
      saving = false;
    }
  }

  const newBlock = () => ({ name: "", kind: "index", start: "", end: "", alias: "", value: "", to: "" });
  const aliasHelp = {
    "": "the start line itself",
    regex: "the first (group) of this regex",
    rewrite: "always this text",
    replace: "the line, with one text replaced",
    prefix: "the line, with this before it",
  };
</script>

{#if loaded}
  <form onsubmit={save}>
    <div class="cols">
      <label>Tab title <input bind:this={titleEl} bind:value={title} placeholder="Logs" /></label>
      <label>Log files <input bind:value={pattern} placeholder="*.log" /></label>
    </div>
    <label>Folders <span class="sub">one per line: in the project ("." is the project itself), or a full path</span>
      <textarea bind:value={folders} rows="3" placeholder="."></textarea>
    </label>

    <div class="head">Sections <span class="sub">optional</span></div>
    <p class="hint">Fold a log into parts (a request, a test, a deploy step…): a section starts at a line whose
      message contains a start text and ends at the next line with an end text (or at the end of the file).
      <b>◆ top</b> sections hold <b>▸ inner</b> ones.</p>
    <div class="blocks">
      {#each blocks as b, i}
        <fieldset>
          <div class="cols">
            <label>Name <input bind:value={b.name} placeholder="request" /></label>
            <label>Kind
              <select bind:value={b.kind}>
                <option value="bookmark">◆ top</option>
                <option value="index">▸ inner</option>
              </select>
            </label>
            <button type="button" class="icon" title="Remove this section" onclick={() => blocks.splice(i, 1)}>×</button>
          </div>
          <div class="cols">
            <label>Starts at <span class="sub">one text per line</span><textarea bind:value={b.start} rows="2"></textarea></label>
            <label>Ends at <span class="sub">one text per line</span><textarea bind:value={b.end} rows="2"></textarea></label>
          </div>
          <div class="cols">
            <label>Title
              <select bind:value={b.alias}>
                <option value="">start line</option>
                <option value="regex">regex</option>
                <option value="rewrite">fixed text</option>
                <option value="replace">replace</option>
                <option value="prefix">prefix</option>
              </select>
            </label>
            {#if b.alias}
              <label>{b.alias === "replace" ? "Replace" : b.alias === "regex" ? "Regex" : "Text"}
                <input bind:value={b.value} /></label>
            {/if}
            {#if b.alias === "replace"}<label>With <input bind:value={b.to} /></label>{/if}
          </div>
          <p class="hint">Title: {aliasHelp[b.alias]}</p>
        </fieldset>
      {:else}
        <p class="hint">None: the log is one list of lines.</p>
      {/each}
      <button type="button" class="add" onclick={() => blocks.push(newBlock())}>+ section</button>
    </div>

    <button type="button" class="fold" onclick={() => (advanced = !advanced)}>
      <span class="caret">{advanced ? "▾" : "▸"}</span>Advanced: how lines are read
    </button>
    {#if advanced}
      <p class="hint">JSON lines: the field names to read, first found wins.</p>
      <div class="cols">
        <label>Message <input bind:value={fields.message} /></label>
        <label>Level <input bind:value={fields.level} /></label>
        <label>Time <input bind:value={fields.time} /></label>
      </div>
      <label>Plain-text lines <span class="sub">empty: read automatically (a time at the start, a level word
        like ERROR or level=warn). Or a regex with the groups time, level and message; lines that don't match
        belong to the one before.</span>
        <input bind:value={linePattern} placeholder="automatic" />
      </label>
    {/if}

    {#each problems as p}<p class="problem">{p}</p>{/each}
    <div class="buttons">
      <button type="submit" class="primary" disabled={problems.length > 0 || saving}>Save</button>
    </div>
  </form>
{/if}

<style>
  :global(body) { padding: 4px 2px; }
  form { display: flex; flex-direction: column; gap: 10px; }
  label { display: flex; flex-direction: column; gap: 6px; font: 12px var(--mono); color: var(--grey); }
  textarea { resize: vertical; }
  .cols { display: flex; gap: 10px; align-items: flex-end; }
  .cols > label { flex: 1; }
  .sub { color: var(--grey-dim); font-size: 11px; }
  .head { font: 12px var(--mono); color: var(--grey); }
  .hint { margin: 0; color: var(--grey); font-size: 12px; }
  .blocks { display: flex; flex-direction: column; gap: 8px; }
  fieldset { border: 1px solid var(--bg2); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 8px; margin: 0; }
  .icon { width: 26px; height: 30px; padding: 0; }
  .add, .fold { align-self: flex-start; }
  .fold { border: 0; background: none; color: var(--grey); padding: 4px 0; }
  .fold:hover { color: var(--fg); }
  .caret { display: inline-block; width: 12px; }
  .problem { margin: 0; color: var(--red); font: 12px var(--mono); }
  .buttons { display: flex; justify-content: flex-end; }
</style>
