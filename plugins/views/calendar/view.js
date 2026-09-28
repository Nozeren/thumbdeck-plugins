// The Calendar view: the coming days' events, the highlighted one's details beside them. The
// backend reads the calendars (backend.js); this only shows what it has.
import { until } from "./ics.js";

import { dayStart, monthDays, onDay, shiftDays, shiftMonth, weekdayNames } from "./month.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);

let events = [];
let cursor = -1; // -1: put it on what's next
let data = { problems: [], updated: null, links: 0 };
// The month: on or off, the selected day, the events of the weeks shown
let month = false;
let selected = dayStart(Date.now());
let monthEvents = [];
let weekStart = 1;

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayKey = (ms) => new Date(ms).toDateString();
function dayName(ms) {
  const today = new Date();
  const d = new Date(ms);
  const diff = Math.round((new Date(d.toDateString()) - new Date(today.toDateString())) / 86_400_000);
  const name = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
  return diff === 0 ? `Today · ${name}` : diff === 1 ? `Tomorrow · ${name}` : diff === -1 ? `Yesterday · ${name}` : name;
}

async function load() {
  data = await td.backend.call("list");
  events = data.events;
  if (cursor < 0 || cursor >= events.length) cursor = next();
  if (month) await loadMonth();
  render();
}

/** The events of the weeks the selected day's month shows */
async function loadMonth() {
  const d = new Date(selected);
  const days = monthDays(d.getFullYear(), d.getMonth(), weekStart);
  monthEvents = await td.backend.call("range", { from: days[0], to: shiftDays(days.at(-1), 1) });
}

/** The meeting going on now or next (all-day ones only when there's no other) */
function next() {
  const now = Date.now();
  const timed = events.findIndex((e) => !e.allDay && e.end > now);
  const any = events.findIndex((e) => e.end > now);
  return timed >= 0 ? timed : any >= 0 ? any : Math.max(0, events.length - 1);
}

function render() {
  const now = Date.now();
  $("summary").textContent = data.links ? `${events.filter((e) => e.start > now && e.start - now < 86_400_000).length} in the next 24 hours` : "";
  $("updated").textContent = data.updated ? `read ${time(data.updated)}` : "";
  $("problems").hidden = !data.problems.length;
  $("problems").textContent = data.problems.map((p) => `couldn't read ${p}`).join("\n");

  $("modehint").textContent = data.links ? (month ? "· m: coming days" : "· m: month") : "";
  $("list").hidden = month;
  $("grid").hidden = !month;
  if (!data.links) {
    $("list").hidden = false;
    $("grid").hidden = true;
    $("list").innerHTML = `<li class="empty">No calendars yet. Add a calendar's private iCal link in <b>Settings (,) › Plugins ›
      Calendar</b>: in Google Calendar, Settings › your calendar › <i>Secret address in iCal format</i>; in Outlook,
      Calendar settings › Shared calendars › <i>Publish a calendar</i> (the ICS link).</li>`;
    $("detail").innerHTML = "";
    return;
  }
  if (month) return renderMonth();
  let html = "";
  let day = "";
  let drewNow = false;
  events.forEach((e, i) => {
    if (dayKey(e.start) !== day) {
      day = dayKey(e.start);
      html += `<li class="day${day === dayKey(now) ? " today" : ""}">${esc(dayName(e.start))}</li>`;
    }
    if (!drewNow && e.start > now && dayKey(e.start) === dayKey(now)) {
      drewNow = true;
      html += `<li class="nowline" title="now"></li>`;
    }
    const cls = ["ev", i === cursor ? "cursor" : "", e.end < now ? "past" : "", e.start <= now && e.end > now ? "now" : ""].join(" ");
    const when = e.allDay ? "all day" : `${time(e.start)}–${time(e.end)}`;
    html += `<li class="${cls}" data-i="${i}"><span class="time">${when}</span><span class="title">${esc(e.title)}</span>${e.link ? `<span class="link" title="has a link: o opens it">↗</span>` : ""}</li>`;
  });
  $("list").innerHTML = html || `<li class="empty">Nothing in the coming days.</li>`;
  $("list").querySelector(".cursor")?.scrollIntoView({ block: "nearest" });
  detail();
}

function detail() {
  const e = events[cursor];
  if (!e) return ($("detail").innerHTML = "");
  const now = Date.now();
  const when = e.allDay
    ? `${dayName(e.start)}, all day`
    : `${dayName(e.start)}, ${time(e.start)}–${time(e.end)} · ${e.end < now ? "over" : e.start <= now ? "now" : until(e.start, now)}`;
  $("detail").innerHTML = `<h2>${esc(e.title)}</h2><p class="when">${esc(when)}</p><dl>
    ${e.location ? `<dt>Where</dt><dd>${esc(e.location)}</dd>` : ""}
    ${e.link ? `<dt>Link</dt><dd><a href="#" id="open">${esc(e.link)}</a> <span class="td-muted">(o)</span></dd>` : ""}
    <dt>Calendar</dt><dd>${esc(e.calendar)}</dd></dl>
    ${e.description ? `<pre>${esc(e.description)}</pre>` : ""}`;
}

function move(to) {
  cursor = Math.max(0, Math.min(events.length - 1, to));
  render();
}

const monthName = (ms) => new Date(ms).toLocaleDateString([], { month: "long", year: "numeric" });

function renderMonth() {
  const d = new Date(selected);
  const today = dayStart(Date.now());
  const days = monthDays(d.getFullYear(), d.getMonth(), weekStart);
  const cells = days.map((day) => {
    const evs = onDay(monthEvents, day);
    const cls = ["cell", new Date(day).getMonth() !== d.getMonth() ? "other" : "", day === today ? "today" : "",
      day === selected ? "cursor" : "", day < today ? "past" : ""].join(" ");
    const shown = evs.slice(0, 3).map((e) => `<div class="mev${e.allDay ? " allday" : ""}">${e.allDay ? "" : `<span class="mtime">${time(e.start)}</span> `}${esc(e.title)}</div>`).join("");
    return `<div class="${cls}" data-day="${day}"><div class="num">${new Date(day).getDate()}</div>${shown}${evs.length > 3 ? `<div class="more">+${evs.length - 3} more</div>` : ""}</div>`;
  }).join("");
  $("grid").innerHTML = `<div class="mhead"><strong>${esc(monthName(selected))}</strong><span class="td-muted">[ ] or d u: months · t: today</span></div>
    <div class="weekdays">${weekdayNames(weekStart).map((n) => `<div>${esc(n)}</div>`).join("")}</div>
    <div class="cells" style="grid-template-rows: repeat(${days.length / 7}, minmax(0, 1fr))">${cells}</div>`;
  dayDetail();
}

/** The selected day's events, beside the month */
function dayDetail() {
  const evs = onDay(monthEvents, selected);
  const now = Date.now();
  $("detail").innerHTML = `<h2>${esc(dayName(selected))}</h2>` + (evs.length
    ? evs.map((e) => `<div class="dev${e.end < now ? " past" : ""}"><div class="when">${e.allDay ? "all day" : `${time(e.start)}–${time(e.end)}`}${e.link ? ` <span class="link" title="o opens it">↗</span>` : ""}</div>
        <div class="dtitle">${esc(e.title)}</div>${e.location ? `<div class="td-muted">${esc(e.location)}</div>` : ""}</div>`).join("")
    : `<p class="td-muted">Nothing on this day.</p>`);
}

async function select(day) {
  const before = new Date(selected);
  selected = dayStart(day);
  const after = new Date(selected);
  if (before.getMonth() !== after.getMonth() || before.getFullYear() !== after.getFullYear()) await loadMonth();
  render();
}

async function setMonth(on) {
  month = on;
  td.storage.set("month", on);
  if (on) {
    selected = dayStart(Date.now());
    await loadMonth();
  }
  render();
}

function openLink() {
  const now = Date.now();
  const day = onDay(monthEvents, selected);
  const e = month ? day.find((x) => x.link && x.end > now) ?? day.find((x) => x.link) : events[cursor];
  if (e?.link) td.ui.openUrl(e.link);
  else td.ui.say("This event has no link");
}

td.on("key", ({ action }) => {
  if (month) {
    const d = new Date(selected);
    switch (action) {
      case "down": return select(shiftDays(selected, 7));
      case "up": return select(shiftDays(selected, -7));
      case "left": return select(shiftDays(selected, -1));
      case "right": return select(shiftDays(selected, 1));
      case "page-down": return select(shiftMonth(selected, 1));
      case "page-up": return select(shiftMonth(selected, -1));
      case "first": return select(new Date(d.getFullYear(), d.getMonth(), 1).getTime());
      case "last": return select(new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime());
      case "now": return select(Date.now());
      case "month": return setMonth(false);
    }
  }
  switch (action) {
    case "month": return setMonth(true);
    case "page-down": return move(cursor + 10);
    case "page-up": return move(cursor - 10);
    case "down": return move(cursor + 1);
    case "up": return move(cursor - 1);
    case "first": return move(0);
    case "last": return move(events.length - 1);
    case "now": return move(next());
    case "outside": return openLink();
    case "refresh":
      td.ui.say("reading the calendars…");
      return td.backend.call("refresh").then(load);
  }
});
td.backend.on("updated", load);
document.addEventListener("click", (e) => {
  if (e.target.closest("#refresh")) return td.backend.call("refresh").then(load);
  if (e.target.closest("#open")) {
    e.preventDefault();
    return openLink();
  }
  const cell = e.target.closest("[data-day]");
  if (cell) return select(Number(cell.dataset.day));
  const row = e.target.closest("[data-i]");
  if (row) move(Number(row.dataset.i));
});
td.on("settings", (s) => {
  weekStart = s.week_starts === "sunday" ? 0 : 1;
  load();
});
// Past and next shift with the clock
setInterval(render, 30_000);
weekStart = (await td.settings.get()).week_starts === "sunday" ? 0 : 1;
month = (await td.storage.get("month")) === true;
load();
