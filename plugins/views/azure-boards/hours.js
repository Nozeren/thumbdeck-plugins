// The hours you logged, day by day: what you added to a work item's completed work (its
// history says when, and by whom), counted on the day you added it; a correction down, taken
// off that day; in days (Settings), a day's worth of hours each. Or a field that keeps a work
// log (a JSON list of entries, each with its day and amount): the entries you added, on their
// own days, and the ones you changed or took out, taken off theirs. For the calendar (view.js),
// and what the backend asks Azure DevOps for.
import { decode } from "./markdown.js";

export const HOURS_FIELD = "Microsoft.VSTS.Scheduling.CompletedWork";
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const same = (who, me) => !!who && !!me && String(who).toLowerCase() === String(me).toLowerCase();

/** How a field's type (/_apis/wit/fields) can hold hours: "number", "text" (a number as it), or
 *  null (it can't: a date, a person…) */
export function fieldUse(type) {
  const t = String(type ?? "").toLowerCase();
  if (["integer", "double", "picklistinteger", "picklistdouble"].includes(t)) return "number";
  if (["string", "plaintext", "html", "pickliststring"].includes(t)) return "text";
  return null;
}

/** The Hours field setting: a field's reference name, or a work log's, with its entries' keys:
 *  "Custom.WorkLogData | date: startDate | amount: daysSpent", and the ones a new entry gets
 *  too, if its entries have them: "| end: endDate | id: _id | activity: activityType".
 *  { field, log: { date, amount, end?, id?, activity? } or null, problem } */
export function hoursSetting(text) {
  const [name, ...parts] = String(text ?? "").split("|").map((p) => p.trim());
  const field = name || HOURS_FIELD;
  if (!parts.length) return { field, log: null, problem: "" };
  const keys = {};
  for (const p of parts) {
    const m = p.match(/^(date|amount|end|id|activity)\s*:\s*(\S.*)$/i);
    if (!m) return { field, log: null, problem: `The Hours field setting's "${p}" isn't "date: <key>" or "amount: <key>" (or end, id, activity) (e.g. Custom.WorkLogData | date: startDate | amount: daysSpent)` };
    keys[m[1].toLowerCase()] = m[2].trim();
  }
  const missing = ["date", "amount"].filter((k) => !keys[k]);
  if (missing.length) return { field, log: null, problem: `The Hours field setting names no ${missing.join(" or ")} key for ${field}'s entries (e.g. ${field} | date: startDate | amount: daysSpent)` };
  if (!name) return { field, log: null, problem: "The Hours field setting names keys but no field (e.g. Custom.WorkLogData | date: startDate | amount: daysSpent)" };
  const log = { date: keys.date, amount: keys.amount };
  for (const k of ["end", "id", "activity"]) if (keys[k]) log[k] = keys[k];
  return { field, log, problem: "" };
}

/** The query for the work items you may have logged hours on since a day (YYYY-MM-DD).
 *  compare: only the ones with some (a number field; Azure DevOps can't compare text with 0).
 *  log: only the ones with a work log (a long text field can only be asked if it's empty) */
export function hoursWiql({ field = HOURS_FIELD, since, projects = [], compare = true, log = false }) {
  const having = log ? `[${field}] IS NOT EMPTY` : compare && `[${field}] > 0`;
  const where = [`[System.ChangedBy] EVER @Me`, having, `[System.ChangedDate] >= ${quote(since)}`].filter(Boolean);
  const only = projects.filter(Boolean);
  if (only.length) where.push(`[System.TeamProject] IN (${only.map(quote).join(", ")})`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
}

/** A field's value as text: its tags and entities gone, trimmed */
const plain = (v) => decode(String(v ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** A field's value as a number: a number, or text (or HTML) that is one and nothing else ("4",
 *  "2.5", "2,5"); empty: 0. Anything else (JSON, words around it…): null, it holds no hours */
export function amount(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const t = plain(v);
  if (!t) return 0;
  return /^-?\d+(?:[.,]\d+)?$/.test(t) ? Number(t.replace(",", ".")) : null;
}

/** Why a field's value can't be hours ("" if it can): for the first work item with one, before
 *  any history is read (a field of JSON would count its first number on every work item) */
export function notHours(v, field) {
  if (amount(v) !== null) return "";
  const t = plain(v);
  return `The Hours field ${field} doesn't hold a number (e.g. ${t.length > 40 ? `${t.slice(0, 40)}…` : t}): use a number field, leave it empty for Completed Work, or name a work log's keys (${field} | date: startDate | amount: daysSpent)`;
}

/** What you logged on a work item, from its revisions (backend.js updates): [{ at, hours }].
 *  scale: the hours in one of the field's units (in days: the hours in a working day) */
export function logged(updates, me, field = HOURS_FIELD, scale = 1) {
  const out = [];
  for (const u of updates ?? []) {
    const f = u.fields ?? {};
    const c = f[field];
    if (!c || !same(u.revisedBy?.uniqueName, me)) continue;
    const to = amount(c.newValue);
    const from = amount(c.oldValue);
    if (to === null || from === null) continue; // a change that isn't hours
    const hours = round((to - from) * scale);
    const at = f["System.ChangedDate"]?.newValue;
    if (hours && at) out.push({ at, hours });
  }
  return out;
}

/** A work log's entries: the JSON list in a field's value (its entities decoded; in HTML, its
 *  tags gone if that's what it takes); empty: none. Not a JSON list: null */
export function entries(v) {
  if (Array.isArray(v)) return v;
  if (v == null || !String(v).trim()) return [];
  const raw = String(v);
  for (const t of [decode(raw).trim(), plain(raw)]) {
    if (!t) return [];
    try {
      const list = JSON.parse(t);
      if (Array.isArray(list)) return list;
    } catch {} // the next try, or none
  }
  return null;
}

/** An entry as text that's the same for the same entry, whatever its keys' order */
const key = (e) => JSON.stringify(e && typeof e === "object" && !Array.isArray(e) ? Object.fromEntries(Object.entries(e).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : e);

/** An entry's day, as a moment on that day where you are, at noon. A date alone, or a day kept
 *  as midnight (UTC or not): that date, everywhere. A time of day: the day it is where you are
 *  (23:30 UTC is the next day east of UTC). None: "" */
export function entryDay(v) {
  const m = String(v ?? "").trim().match(/^(\d{4}-\d\d-\d\d)(?:[T ]00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)?)?$/i);
  if (m) return `${m[1]}T12:00:00`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : `${dayKey(d)}T12:00:00`;
}

/** A day (YYYY-MM-DD) written as a work log writes its dates, from one of them (sample): a date
 *  alone; midnight UTC ("2026-10-15T00:00:00.000Z": the day where you are, at UTC midnight), as
 *  precise as it; a time of day: that day's noon where you are. No sample: midnight UTC */
export function dateLike(sample, day) {
  const s = String(sample ?? "").trim();
  if (/^\d{4}-\d\d-\d\d$/.test(s)) return day;
  const midnight = s.match(/^\d{4}-\d\d-\d\d([T ])00:00(:00(?:\.0+)?)?(Z|[+-]00:?00)?$/i);
  if (midnight) return `${day}${midnight[1]}00:00${midnight[2] ?? ""}${midnight[3] ?? ""}`;
  if (!s || Number.isNaN(Date.parse(s))) return `${day}T00:00:00.000Z`;
  const [y, m, d] = day.split("-").map(Number);
  const noon = new Date(y, m - 1, d, 12).toISOString();
  return /\.\d+/.test(s) ? noon : noon.replace(/\.\d+Z$/, "Z");
}

/** A work log's entries as the page shows them: [{ n (its place in the list), day, activity,
 *  hours, key (to tell it's still the same) }], the newest day first */
export function logRows(list, log, scale = 1) {
  const rows = (list ?? []).map((e, n) => ({ e, n })).filter(({ e }) => e && typeof e === "object").map(({ e, n }) => {
    const v = typeof e[log.amount] === "number" ? e[log.amount] : amount(e[log.amount]);
    return { n, day: entryDay(e[log.date]).slice(0, 10), activity: log.activity ? String(e[log.activity] ?? "") : "", hours: round((v ?? 0) * scale), key: key(e) };
  });
  rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.n - b.n));
  return rows;
}

/** The activities in a work log's entries (none named in the setting: none) */
export const activitiesIn = (list, log) => (log.activity ? [...new Set((list ?? []).map((e) => e?.[log.activity]).filter((a) => typeof a === "string" && a.trim()))] : []);

/** A change to a work log's list: { add: { day, hours, activity } } | { change: n, to: { day,
 *  hours, activity }, was } | { remove: n, was } (was: the entry's key, from logRows: it must
 *  still be the one at n). A new entry is written like the ones there: its keys in their order,
 *  its date as theirs, the end its date, the id the highest + 1; an edited one keeps its other
 *  keys. hours: in hours (scale: the hours in one of the field's units). The new list */
export function applyLog(list, change, log, scale = 1) {
  const out = [...(list ?? [])];
  const units = (h) => {
    const n = Number(h);
    if (!Number.isFinite(n) || n <= 0) throw new Error("the hours: a number over 0");
    return Math.round((n / scale) * 10000) / 10000;
  };
  const isDay = (d) => /^\d{4}-\d\d-\d\d$/.test(String(d)) && !Number.isNaN(Date.parse(d));
  const at = (n) => {
    if (!Number.isInteger(n) || !out[n] || typeof out[n] !== "object") throw new Error("that entry isn't there any more: look again (r)");
    if (change.was != null && key(out[n]) !== change.was) throw new Error("Someone changed it meanwhile: look again (r) and redo it");
    return out[n];
  };
  if (change.add) {
    const { day, hours, activity } = change.add;
    if (!isDay(day)) throw new Error("the day: YYYY-MM-DD");
    const like = [...out].reverse().find((e) => e && typeof e === "object" && log.date in e);
    const date = dateLike(like?.[log.date], day);
    const values = { [log.date]: date, [log.amount]: units(hours) };
    if (log.end) values[log.end] = date;
    if (log.activity) values[log.activity] = String(activity ?? "").trim();
    if (log.id) {
      const ids = out.map((e) => Number(e?.[log.id])).filter(Number.isFinite);
      values[log.id] = (ids.length ? Math.max(...ids) : 0) + 1;
    }
    // Their keys' order (an organization's tool may read them in order), then the rest
    const order = [...Object.keys(like ?? {}).filter((k) => k in values), ...[log.id, log.activity, log.date, log.end, log.amount].filter((k) => k && k in values)];
    out.push(Object.fromEntries([...new Set(order)].map((k) => [k, values[k]])));
  } else if (change.change != null) {
    const e = at(change.change);
    const { day, hours, activity } = change.to ?? {};
    const next = { ...e };
    if (day != null) {
      if (!isDay(day)) throw new Error("the day: YYYY-MM-DD");
      next[log.date] = dateLike(e[log.date], day);
      if (log.end && log.end in e) next[log.end] = next[log.date];
    }
    if (hours != null) next[log.amount] = typeof e[log.amount] === "string" ? String(units(hours)) : units(hours);
    if (activity != null && log.activity) next[log.activity] = String(activity).trim();
    out[change.change] = next;
  } else if (change.remove != null) {
    at(change.remove);
    out.splice(change.remove, 1);
  } else throw new Error("no change");
  return out;
}

/** A work log's list as its field keeps it, in the form it was read (raw): HTML-escaped quotes
 *  (&quot;) if it had them, in the tags around it if it had some. Empty: escaped if html */
export function logValue(raw, list, { html = false } = {}) {
  const r = String(raw ?? "");
  const [, before = "", , after = ""] = r.match(/^(\s*(?:<[a-z][^>]*>\s*)*)([\s\S]*?)((?:\s*<\/[a-z][^>]*>)*\s*)$/i) ?? [];
  const escaped = r.trim() ? /&quot;|&#34;|&#x22;/i.test(r) : html;
  const json = JSON.stringify(list);
  const body = escaped ? json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") : json;
  return `${before}${body}${after}`;
}

/** Why a work log's entries can't be counted ("" if they can): for the first value with
 *  entries, before any history is read. None of the values a JSON list: said too */
export function notLog(v, field, log) {
  const list = entries(v);
  if (list === null) {
    const t = plain(v);
    return `The Hours field ${field} doesn't hold a JSON list of entries (e.g. ${t.length > 40 ? `${t.slice(0, 40)}…` : t}): check the Hours field setting`;
  }
  const e = list.find((x) => x && typeof x === "object");
  if (!e) return "";
  const missing = [log.date, log.amount].filter((k) => !(k in e));
  if (!missing.length) return "";
  const t = JSON.stringify(e);
  return `The entries in the Hours field ${field} have no ${missing.map((k) => `"${k}"`).join(" or ")} (e.g. ${t.length > 60 ? `${t.slice(0, 60)}…` : t}): check the Hours field setting's keys`;
}

/** What you logged in a work log, from a work item's revisions: [{ at, hours }]. Each revision's
 *  entries against the ones before (as a multiset): one that's new, +its amount on its day; one
 *  that's gone (taken out, or changed: the old one goes, the new one comes), -its amount on its
 *  day. A value that isn't a JSON list: that revision isn't counted */
export function loggedLog(updates, me, field, log, scale = 1) {
  const out = [];
  const count = (e, sign) => {
    if (!e || typeof e !== "object") return;
    const n = typeof e[log.amount] === "number" ? e[log.amount] : amount(e[log.amount]);
    const at = entryDay(e[log.date]);
    const hours = round(sign * (n ?? 0) * scale);
    if (hours && at) out.push({ at, hours });
  };
  for (const u of updates ?? []) {
    const c = u.fields?.[field];
    if (!c || !same(u.revisedBy?.uniqueName, me)) continue;
    const was = entries(c.oldValue);
    const now = entries(c.newValue);
    if (was === null || now === null) continue;
    const left = new Map();
    for (const e of was) left.set(key(e), [...(left.get(key(e)) ?? []), e]);
    for (const e of now) {
      const kept = left.get(key(e));
      if (kept?.length) kept.pop();
      else count(e, 1);
    }
    for (const gone of left.values()) for (const e of gone) count(e, -1);
  }
  return out;
}

/** A day as YYYY-MM-DD, where you are */
export const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};

/** The entries ({ at, hours, id, … }) by day: key -> { hours, items: [{ …the item, hours }] } */
export function byDay(entries) {
  const days = new Map();
  for (const e of entries ?? []) {
    const k = dayKey(e.at);
    const day = days.get(k) ?? { hours: 0, items: [] };
    day.hours += e.hours;
    const it = day.items.find((i) => i.id === e.id);
    if (it) it.hours += e.hours;
    else {
      const { at: _at, ...rest } = e;
      day.items.push(rest);
    }
    days.set(k, day);
  }
  for (const d of days.values()) {
    d.hours = round(d.hours);
    for (const i of d.items) i.hours = round(i.hours);
    d.items = d.items.filter((i) => i.hours).sort((a, b) => b.hours - a.hours);
  }
  return days;
}

const round = (h) => Math.round(h * 100) / 100;

/** Hours in words: 2.5h, 45m, 0h */
export const hoursText = (h) => {
  const n = round(h);
  return Math.abs(n) > 0 && Math.abs(n) < 1 ? `${Math.round(n * 60)}m` : `${n}h`;
};

/** A month's weeks, Monday first: [[Date × 7], …] (with the days around it that fill them) */
export function weeks(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  const out = [];
  for (let d = new Date(start); out.length < 6 && (out.length === 0 || d.getMonth() === month); ) {
    const week = [];
    for (let n = 0; n < 7; n++, d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) week.push(d);
    out.push(week);
  }
  return out;
}
