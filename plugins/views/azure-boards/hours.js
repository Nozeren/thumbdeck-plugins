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
 *  "Custom.WorkLogData | date: startDate | amount: daysSpent". { field, log: { date, amount }
 *  or null, problem } */
export function hoursSetting(text) {
  const [name, ...parts] = String(text ?? "").split("|").map((p) => p.trim());
  const field = name || HOURS_FIELD;
  if (!parts.length) return { field, log: null, problem: "" };
  const keys = {};
  for (const p of parts) {
    const m = p.match(/^(date|amount)\s*:\s*(\S.*)$/i);
    if (!m) return { field, log: null, problem: `The Hours field setting's "${p}" isn't "date: <key>" or "amount: <key>" (e.g. Custom.WorkLogData | date: startDate | amount: daysSpent)` };
    keys[m[1].toLowerCase()] = m[2].trim();
  }
  const missing = ["date", "amount"].filter((k) => !keys[k]);
  if (missing.length) return { field, log: null, problem: `The Hours field setting names no ${missing.join(" or ")} key for ${field}'s entries (e.g. ${field} | date: startDate | amount: daysSpent)` };
  if (!name) return { field, log: null, problem: "The Hours field setting names keys but no field (e.g. Custom.WorkLogData | date: startDate | amount: daysSpent)" };
  return { field, log: { date: keys.date, amount: keys.amount }, problem: "" };
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

/** An entry's day, as a moment on that day where you are: its date's YYYY-MM-DD (a day kept as
 *  midnight UTC is that day everywhere), at noon. None: "" */
function entryDay(v) {
  const m = String(v ?? "").match(/^(\d{4}-\d\d-\d\d)/);
  if (m) return `${m[1]}T12:00:00`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : `${dayKey(d)}T12:00:00`;
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
