// Clipboard history: the list and what each item looks like. Pure functions, tested with
// `node --test` (clip.test.js); backend.js watches the clipboard, view.js shows the list.

/** Bigger copies aren't kept (a whole log file, a huge JSON) */
export const MAX_SIZE = 100_000;

/** The list after copying `text`: new at the top, a copy seen before moves back to the top,
 *  pinned ones never drop off the end */
export function add(items, text, now, keep = 100) {
  if (!text.trim() || text.length > MAX_SIZE) return items;
  const old = items.find((i) => i.text === text);
  const rest = items.filter((i) => i !== old);
  const next = [{ id: old?.id ?? `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, at: now, pinned: old?.pinned ?? false }, ...rest];
  let unpinned = 0;
  return next.filter((i) => i.pinned || ++unpinned <= keep);
}

/** Pinned first, then newest first; only the ones with all the words */
export function shown(items, words = "") {
  const w = words.toLowerCase().split(/\s+/).filter(Boolean);
  return items
    .filter((i) => w.every((x) => i.text.toLowerCase().includes(x)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at);
}

/** One line for the list */
export function line(text, width = 120) {
  const one = text.trim().replace(/\s*\n\s*/g, " ⏎ ").replace(/\s+/g, " ");
  return one.length > width ? `${one.slice(0, width - 1)}…` : one;
}

/** What it is, in a word (a badge in the list) */
export function kind(text) {
  const t = text.trim();
  if (/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*$/.test(t)) return "jwt";
  if (/^https?:\/\/\S+$/.test(t)) return "url";
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(t)) return "email";
  if (/^#[0-9a-f]{3,8}$/i.test(t) || /^rgba?\(/i.test(t)) return "color";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return "uuid";
  if (/^-?\d+(\.\d+)?$/.test(t)) return "number";
  if (/^(~|\.{0,2})\/[^\s]*$/.test(t)) return "path";
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return "json";
    } catch {}
  }
  if (t.includes("\n")) return `${t.split("\n").length} lines`;
  return "";
}

/** "now", "5m", "3h", "2d" */
export function age(at, now) {
  const s = Math.max(0, (now - at) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

/** Clipboard types a password manager marks its copies with (they aren't kept) */
export const SECRET_TYPES = ["x-kde-passwordManagerHint", "org.nspasteboard.ConcealedType"];
export const isSecret = (types) => types.some((t) => SECRET_TYPES.includes(t.trim()));
