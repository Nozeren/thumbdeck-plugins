// The Calendar view: the coming days' events, the highlighted one's details beside them. The
// backend reads the calendars (backend.js); this only shows what it has.
import { until } from "./ics.js";

const td = window.thumbdeck;
const esc = td.escape;
const $ = (id) => document.getElementById(id);

let events = [];
let cursor = -1; // -1: put it on what's next
let data = { problems: [], updated: null, links: 0 };

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
  render();
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

  if (!data.links) {
    $("list").innerHTML = `<li class="empty">No calendars yet. Add a calendar's private iCal link in <b>Settings (,) › Plugins ›
      Calendar</b>: in Google Calendar, Settings › your calendar › <i>Secret address in iCal format</i>; in Outlook,
      Calendar settings › Shared calendars › <i>Publish a calendar</i> (the ICS link).</li>`;
    $("detail").innerHTML = "";
    return;
  }
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

function openLink() {
  const e = events[cursor];
  if (e?.link) td.ui.openUrl(e.link);
  else td.ui.say("This event has no link");
}

td.on("key", ({ action }) => {
  switch (action) {
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
  const row = e.target.closest("[data-i]");
  if (row) move(Number(row.dataset.i));
});
// Past and next shift with the clock
setInterval(render, 30_000);
load();
