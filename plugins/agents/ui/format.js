// Small pure helpers for the Agents tab, tested with `node --test` (format.test.js).

/** 1234 -> "1.2k", 130264470 -> "130M" */
export function count(n) {
  if (n < 1000) return String(n);
  const [value, unit] = n < 1e6 ? [n / 1e3, "k"] : n < 1e9 ? [n / 1e6, "M"] : [n / 1e9, "B"];
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}${unit}`;
}

/** Tokens the model read (fresh or from cache) and wrote */
export const tokensLine = (t) => `${count(t.input + t.cache_read + t.cache_write)} in · ${count(t.output)} out`;

/** "claude-opus-5-5" -> "opus 5.5", "claude-haiku-4-5-20251001" -> "haiku 4.5" */
export function shortModel(model) {
  if (!model) return "";
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  return m ? `${m[1]} ${m[2]}${m[3] ? "." + m[3] : ""}` : model;
}

/** "$5.20" */
export const money = (usd) => (usd === null ? "" : usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);

/** "5m ago" from an ISO time */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** A tool call in one line: what it ran, read, searched, ... */
export function toolSummary(e) {
  const i = e.input ?? {};
  const pick = (...keys) => keys.map((k) => i[k]).find((v) => typeof v === "string" && v);
  const first = Object.values(i).find((v) => typeof v === "string");
  const text =
    e.name === "Agent" || e.name === "Task"
      ? [i.subagent_type, i.description].filter(Boolean).join(": ")
      : pick("command", "file_path", "path", "pattern", "url", "query", "description", "prompt") ?? first ?? "";
  return text.replace(/\s+/g, " ").trim();
}

/** How many subagent runs each agent type had, across the sessions */
export function uses(sessions) {
  const out = new Map();
  for (const s of sessions) for (const a of s.subagents) out.set(a.agent_type, (out.get(a.agent_type) ?? 0) + 1);
  return out;
}
