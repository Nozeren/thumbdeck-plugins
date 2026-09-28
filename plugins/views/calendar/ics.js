// Reading iCal (.ics) calendars: events, with repeating ones expanded into the days asked for.
// Covers what calendar apps' iCal links contain: time zones (by IANA name), all-day events,
// RRULE (daily, weekly, monthly, yearly; INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY), EXDATE,
// moved or cancelled occurrences (RECURRENCE-ID). Tested with `node --test` (ics.test.js).

/** Lines with their folded continuations joined back */
function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

/** "DTSTART;TZID=Europe/Athens:20260928T100000" -> { name, params, value } */
function property(line) {
  let quoted = false;
  let at = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const [name, ...rest] = line.slice(0, at).split(";");
  const params = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(at + 1) };
}

const unescape = (s) => s.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

// ------------------------------------------------------------ time

/** Minutes a zone is ahead of UTC at a moment */
export function zoneOffset(ms, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const n = (t) => Number(parts.find((p) => p.type === t).value);
  return (Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - (ms - (ms % 1000))) / 60_000;
}

const knownZone = (zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** A wall-clock time ({y, mo, d, h, mi, s}) as ms since 1970: in a zone, in UTC, or local ("floating") */
export function toMs(w, zone) {
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  if (zone === "UTC") return asUtc;
  if (!zone) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
  let ms = asUtc - zoneOffset(asUtc, zone) * 60_000;
  ms = asUtc - zoneOffset(ms, zone) * 60_000; // once more: the offset right at that moment (DST)
  return ms;
}

/** A DTSTART-like property: its wall time, zone, and whether it's a whole day */
function when(prop) {
  if (!prop) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(prop.value.trim());
  if (!m) return null;
  const allDay = prop.params.VALUE === "DATE" || m[4] === undefined;
  const w = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  const tz = prop.params.TZID;
  const zone = allDay ? null : m[7] ? "UTC" : tz && knownZone(tz) ? tz : null;
  return { wall: w, zone, allDay };
}

/** "PT1H30M", "P1D", "P1W" as ms */
function duration(text) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text ?? "");
  if (!m) return null;
  const ms = (+(m[2] ?? 0) * 7 * 86400 + +(m[3] ?? 0) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

// Wall times are kept in a Date used as plain fields (its UTC ones): no zone gets in the way
const asDate = (w) => new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s));
const fromDate = (d) => ({ y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() });
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// ------------------------------------------------------------ parsing

/** A calendar's name and its events (as written: repeating ones not expanded yet) */
export function parse(text) {
  let name = "";
  const events = [];
  let ev = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      ev = { props: {}, exdates: [] };
      continue;
    }
    if (line === "END:VEVENT") {
      if (ev) events.push(ev);
      ev = null;
      continue;
    }
    const p = property(line);
    if (!p) continue;
    if (!ev) {
      if (p.name === "X-WR-CALNAME") name = unescape(p.value);
      continue;
    }
    if (p.name === "EXDATE") {
      for (const v of p.value.split(",")) ev.exdates.push(when({ ...p, value: v }));
    } else ev.props[p.name] ??= p;
  }
  return {
    name,
    events: events
      .map((e) => {
        const text = (k) => (e.props[k] ? unescape(e.props[k].value) : "");
        const start = when(e.props.DTSTART);
        if (!start) return null;
        const end = when(e.props.DTEND);
        const length = end
          ? toMs(end.wall, end.zone) - toMs(start.wall, start.zone)
          : (duration(e.props.DURATION?.value) ?? (start.allDay ? 86_400_000 : 0));
        return {
          uid: text("UID"),
          title: text("SUMMARY") || "(no title)",
          location: text("LOCATION"),
          description: text("DESCRIPTION"),
          url: text("URL"),
          cancelled: text("STATUS").toUpperCase() === "CANCELLED",
          start,
          length,
          rrule: e.props.RRULE?.value ?? null,
          exdates: e.exdates.filter(Boolean).map((x) => toMs(x.wall, x.allDay ? null : x.zone ?? start.zone)),
          recurrenceId: e.props["RECURRENCE-ID"] ? when(e.props["RECURRENCE-ID"]) : null,
        };
      })
      .filter(Boolean),
  };
}

// ------------------------------------------------------------ repeating events

/** The start times (ms) of an event's occurrences between from and to (ms) */
export function occurrences(ev, from, to) {
  const first = toMs(ev.start.wall, ev.start.zone);
  if (!ev.rrule) return first + ev.length >= from && first < to ? [first] : [];
  const rule = Object.fromEntries(ev.rrule.split(";").map((p) => p.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const until = rule.UNTIL ? (() => {
    const u = when({ params: {}, value: rule.UNTIL });
    return u ? toMs(u.wall, u.zone ?? ev.start.zone) : Infinity;
  })() : Infinity;
  const byDay = rule.BYDAY ? rule.BYDAY.split(",").map((x) => /^([+-]?\d+)?([A-Z]{2})$/.exec(x)).filter(Boolean).map((m) => ({ n: m[1] ? Number(m[1]) : null, day: DAYS.indexOf(m[2]) })) : [];
  const byMonthDay = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(",").map(Number) : [];
  const start = asDate(ev.start.wall);
  const out = [];
  let made = 0;
  const take = (d) => {
    if (d < start) return true;
    const ms = toMs(fromDate(d), ev.start.zone);
    if (ms > until || made >= count) return false;
    made++;
    if (ms + ev.length >= from && ms < to && !ev.exdates.includes(ms)) out.push(ms);
    return ms < to;
  };
  const withTime = (y, mo, d) => new Date(Date.UTC(y, mo, d, start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()));
  // The days of a month that a BYDAY with a number picks (2TU: the second Tuesday; -1FR: the last Friday)
  const monthDays = (y, mo) => {
    const days = [];
    const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    if (byDay.length) {
      for (const b of byDay) {
        const matching = [];
        for (let d = 1; d <= last; d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === b.day) matching.push(d);
        if (b.n === null) days.push(...matching);
        else if (b.n > 0 && matching[b.n - 1]) days.push(matching[b.n - 1]);
        else if (b.n < 0 && matching[matching.length + b.n]) days.push(matching[matching.length + b.n]);
      }
    } else for (const d of byMonthDay.length ? byMonthDay : [start.getUTCDate()]) days.push(d < 0 ? last + d + 1 : d);
    return [...new Set(days)].filter((d) => d >= 1 && d <= last).sort((a, b) => a - b);
  };

  // Without a COUNT, start near the window instead of walking from a start years ago
  let skip = 0;
  if (count === Infinity && from > first) {
    const days = (from - first) / 86_400_000;
    const per = { DAILY: interval, WEEKLY: interval * 7, MONTHLY: interval * 28, YEARLY: interval * 365 }[rule.FREQ] ?? 1;
    skip = Math.max(0, Math.floor(days / per) - 2);
    if (rule.FREQ === "MONTHLY") skip = Math.max(0, Math.floor(days / (interval * 31)) - 2);
  }
  for (let step = skip; step < skip + 5000; step++) {
    let batch = [];
    if (rule.FREQ === "DAILY") {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + step * interval);
      batch = [d];
    } else if (rule.FREQ === "WEEKLY") {
      const weekStart = new Date(start);
      weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7) + step * interval * 7); // Monday
      const days = byDay.length ? byDay.map((b) => b.day) : [start.getUTCDay()];
      batch = days
        .map((day) => {
          const d = new Date(weekStart);
          d.setUTCDate(d.getUTCDate() + ((day + 6) % 7));
          return d;
        })
        .sort((a, b) => a - b);
    } else if (rule.FREQ === "MONTHLY") {
      const y = start.getUTCFullYear();
      const mo = start.getUTCMonth() + step * interval;
      batch = monthDays(y, mo).map((d) => withTime(y, mo, d));
    } else if (rule.FREQ === "YEARLY") {
      const y = start.getUTCFullYear() + step * interval;
      const d = withTime(y, start.getUTCMonth(), start.getUTCDate());
      batch = d.getUTCMonth() === start.getUTCMonth() ? [d] : []; // Feb 29 only in leap years
    } else return out; // a frequency it doesn't know: none rather than wrong ones
    for (const d of batch) if (!take(d)) return out;
  }
  return out;
}

// ------------------------------------------------------------ what the view shows

/** The first link that looks like a meeting (Meet, Zoom, Teams, …), else the first link */
export function meetingLink(ev) {
  const text = [ev.url, ev.location, ev.description].filter(Boolean).join(" ");
  const links = text.match(/https?:\/\/[^\s<>"')]+/g) ?? [];
  return links.find((l) => /meet\.google|zoom\.us|teams\.microsoft|webex|whereby|jitsi/.test(l)) ?? links[0] ?? null;
}

/** Every occurrence between from and to, from several calendars, in order:
 *  { id, title, start, end, allDay, location, description, link, calendar } */
export function agenda(calendars, from, to) {
  const out = [];
  for (const cal of calendars) {
    const moved = cal.events.filter((e) => e.recurrenceId);
    for (const ev of cal.events.filter((e) => !e.recurrenceId)) {
      for (const start of occurrences(ev, from, to)) {
        // An occurrence that was moved or cancelled has its own event with a RECURRENCE-ID
        const override = moved.find((m) => m.uid === ev.uid && toMs(m.recurrenceId.wall, m.recurrenceId.zone ?? ev.start.zone) === start);
        if (!override && !ev.cancelled) out.push(item(ev, start, cal.name));
      }
    }
    for (const m of moved) {
      const start = toMs(m.start.wall, m.start.zone);
      if (!m.cancelled && start + m.length >= from && start < to) out.push(item(m, start, cal.name));
    }
  }
  return out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}

function item(ev, start, calendar) {
  return {
    id: `${ev.uid}@${start}`,
    title: ev.title,
    start,
    end: start + ev.length,
    allDay: ev.start.allDay,
    location: ev.location,
    description: ev.description.slice(0, 4000),
    link: meetingLink(ev),
    calendar,
  };
}

/** "in 12m", "in 2h 5m", "now" */
export function until(ms, now = Date.now()) {
  const m = Math.round((ms - now) / 60_000);
  if (m <= 0) return "now";
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `in ${h}h ${m % 60}m` : `in ${h}h`;
}
