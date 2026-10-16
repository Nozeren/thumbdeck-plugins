// The hours you logged, day by day: what you added to a work item's completed work (its
// history says when, and by whom), counted on the day you added it; a correction down, taken
// off that day; in days (Settings), a day's worth of hours each. For the calendar (view.js),
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

/** The query for the work items you may have logged hours on since a day (YYYY-MM-DD).
 *  compare: only the ones with some (a number field; Azure DevOps can't compare text with 0) */
export function hoursWiql({ field = HOURS_FIELD, since, projects = [], compare = true }) {
  const where = [`[System.ChangedBy] EVER @Me`, compare && `[${field}] > 0`, `[System.ChangedDate] >= ${quote(since)}`].filter(Boolean);
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
  return `The Hours field ${field} doesn't hold a number (e.g. ${t.length > 40 ? `${t.slice(0, 40)}…` : t}): use a number field, or leave it empty for Completed Work`;
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
