// The Calendar backend: reads the iCal links in the plugin's settings, keeps the coming days'
// events, says what's next (the Plugins pane's status), and reminds you before an event.
// It starts with thumbdeck, so reminders come without the view open.
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../../packages/backend/index.js";
import { agenda, parse, until } from "./ics.js";

const DAY = 86_400_000;
let calendars = []; // [{ name, events }] as read
let problems = []; // one line per link that couldn't be read
let updated = null;
let reminded = new Set(); // event ids already reminded of
let settings = { calendars: [], remind_minutes: 5, days: 7, refresh_minutes: 15 };

/** Read every link (webcal:// is https://) */
async function refresh(tb) {
  const read = [];
  const bad = [];
  for (const link of settings.calendars.map((l) => l.trim()).filter(Boolean)) {
    const url = link.replace(/^webcal:\/\//i, "https://");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`the server said ${res.status}`);
      const cal = parse(await res.text());
      read.push({ ...cal, name: cal.name || new URL(url).hostname });
    } catch (e) {
      // The link is private (a secret address): only its host goes in the message
      let host = link;
      try {
        host = new URL(url).hostname;
      } catch {}
      bad.push(`${host}: ${e.message}`);
    }
  }
  calendars = read;
  problems = bad;
  updated = Date.now();
  tb.event("updated", { updated, problems });
  tick(tb);
}

/** The events from yesterday to `days` days ahead */
function upcoming() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return agenda(calendars, today.getTime() - DAY, today.getTime() + (settings.days + 1) * DAY);
}

/** What's next: the pane's status, reminders, the avatar */
function tick(tb) {
  const now = Date.now();
  const soon = upcoming().filter((e) => !e.allDay && e.end > now);
  const next = soon.find((e) => e.start > now - 60_000);
  tb.status(next && next.start - now < 12 * 3_600_000 ? `${next.title} ${until(next.start, now)}` : null);
  const lead = settings.remind_minutes * 60_000;
  for (const e of soon) {
    if (e.start - now <= lead && e.start - now > -60_000 && !reminded.has(e.id)) {
      reminded.add(e.id);
      tb.notify(`${e.title} ${until(e.start, now)}`, [e.location, e.link ? "o in the Calendar view opens the meeting" : ""].filter(Boolean).join(" · "));
    }
  }
  // The avatar waits with you from the reminder until a few minutes after the start
  const starting = soon.find((e) => e.start - now <= lead && now - e.start < 5 * 60_000);
  tb.mood("waiting", starting ? `${starting.title} (${until(starting.start, now)})` : null);
  if (reminded.size > 500) reminded = new Set([...reminded].slice(-200));
}

let timer = null;
function schedule(tb) {
  clearInterval(timer);
  timer = setInterval(() => refresh(tb), Math.max(1, settings.refresh_minutes) * 60_000);
}

serve({
  initialize(info, tb) {
    settings = { ...settings, ...info.settings };
    refresh(tb);
    schedule(tb);
    setInterval(() => tick(tb), 20_000);
  },
  settings(s, tb) {
    settings = { ...settings, ...s };
    refresh(tb);
    schedule(tb);
  },
  /** For the view: the coming events, and whatever went wrong */
  list: () => ({ events: upcoming(), problems, updated, links: settings.calendars.filter((l) => l.trim()).length }),
  /** Read the links again now */
  async refresh(_p, tb) {
    await refresh(tb);
    return { updated, problems };
  },
});
