// Env check: reading .env files and comparing one with its example. Pure functions, tested
// with `node --test` (env.test.js); tab.js does the reading and the showing.

/** The examples it looks for, first found wins */
export const EXAMPLES = [".env.example", ".env.sample", ".env.template", ".env.dist", "example.env"];

/** KEY=value lines (with `export`, quotes, comments) in order: { key, value, line } */
export function parse(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const line = i + 1;
    const q = value[0];
    if (q === '"' || q === "'" || q === "`") {
      // A quoted value can go on over several lines
      let rest = value.slice(1);
      while (!rest.includes(q) && i + 1 < lines.length) rest += `\n${lines[++i]}`;
      value = rest.slice(0, rest.indexOf(q) >= 0 ? rest.indexOf(q) : rest.length);
      if (q === '"') value = value.replace(/\\n/g, "\n");
    } else value = value.replace(/\s+#.*$/, "").trim();
    out.push({ key: m[1], value, line });
  }
  return out;
}

/** What each key is like in the env file, against the example:
 *  missing (in the example only), empty, example (still the example's value), extra (not in
 *  the example), ok. The example's order first, then the extras. */
export function compare(example, env) {
  const have = new Map(env.map((e) => [e.key, e]));
  const wanted = new Map(example.map((e) => [e.key, e]));
  const rows = [];
  for (const ex of wanted.values()) {
    const e = have.get(ex.key);
    const status = !e ? "missing" : e.value === "" && ex.value !== "" ? "empty" : ex.value !== "" && e.value === ex.value && looksLikePlaceholder(ex.value) ? "example" : "ok";
    rows.push({ key: ex.key, status, value: e?.value ?? null, example: ex.value, line: e?.line ?? null, exampleLine: ex.line });
  }
  for (const e of have.values()) {
    if (!wanted.has(e.key)) rows.push({ key: e.key, status: "extra", value: e.value, example: null, line: e.line, exampleLine: null });
  }
  return rows;
}

/** An example value that's meant to be replaced ("changeme", "your-key-here", "<token>", "xxx") */
export function looksLikePlaceholder(v) {
  return /change.?me|your[-_ ]|replace|<[^>]+>|^x{3,}$|^\.\.\.$|todo|secret-?here|example/i.test(v);
}

/** A value to show without giving it away: its first letters for a URL or a short word,
 *  dots for the rest */
export function mask(value) {
  if (value == null) return "";
  if (value === "") return "(empty)";
  if (/^(true|false|\d+(\.\d+)?|localhost|development|production|test|debug|info|warn|error)$/i.test(value)) return value;
  const url = value.match(/^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/]*@)?([^/?#:]+)/i);
  if (url) return `${url[1]}${url[2]}…`;
  return "•".repeat(Math.min(12, Math.max(4, value.length)));
}

/** Lines to add to the env file for its missing keys, with the example's values */
export function missingLines(rows) {
  return rows.filter((r) => r.status === "missing").map((r) => `${r.key}=${/[\s#"'\n]/.test(r.example) ? JSON.stringify(r.example) : r.example}`);
}
