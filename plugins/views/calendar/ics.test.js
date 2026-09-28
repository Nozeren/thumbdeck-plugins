import { test } from "node:test";
import assert from "node:assert/strict";
import { agenda, meetingLink, occurrences, parse, toMs, until, zoneOffset } from "./ics.js";

const cal = (...events) => `BEGIN:VCALENDAR\r\nX-WR-CALNAME:Work\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
const vevent = (lines) => `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT`;
const utc = (s) => Date.parse(s);

test("an event in a time zone, with folded lines and escapes", () => {
  const c = parse(cal(vevent([
    "UID:1", "SUMMARY:Standup\\, daily", "DTSTART;TZID=Europe/Athens:20260928T100000", "DTEND;TZID=Europe/Athens:20260928T101500",
    "DESCRIPTION:Join: https://meet.google.com/abc-defg-hij\\nor call", " in", "LOCATION:Room 1",
  ])));
  assert.equal(c.name, "Work");
  const e = c.events[0];
  assert.equal(e.title, "Standup, daily");
  assert.equal(e.description, "Join: https://meet.google.com/abc-defg-hij\nor callin", "a folded line joins the one before");
  assert.equal(toMs(e.start.wall, e.start.zone), utc("2026-09-28T07:00:00Z"), "Athens is UTC+3 in September");
  assert.equal(e.length, 15 * 60_000);
  assert.equal(meetingLink(e), "https://meet.google.com/abc-defg-hij");
});

test("time zones across a DST change, UTC and floating times", () => {
  assert.equal(zoneOffset(utc("2026-01-15T12:00:00Z"), "Europe/Athens"), 120);
  assert.equal(zoneOffset(utc("2026-07-15T12:00:00Z"), "America/New_York"), -240);
  const e = parse(cal(vevent(["UID:2", "DTSTART;TZID=America/New_York:20261030T090000", "RRULE:FREQ=WEEKLY", "SUMMARY:Sync"]))).events[0];
  const [a, b] = occurrences(e, utc("2026-10-29T00:00:00Z"), utc("2026-11-07T00:00:00Z"));
  assert.equal(a, utc("2026-10-30T13:00:00Z"), "9:00 EDT");
  assert.equal(b, utc("2026-11-06T14:00:00Z"), "still 9:00 on the wall, now EST");
  const z = parse(cal(vevent(["UID:3", "DTSTART:20260928T100000Z", "DURATION:PT1H30M"]))).events[0];
  assert.equal(toMs(z.start.wall, z.start.zone), utc("2026-09-28T10:00:00Z"));
  assert.equal(z.length, 90 * 60_000);
  const f = parse(cal(vevent(["UID:4", "DTSTART;TZID=Nowhere/Mars:20260928T100000"]))).events[0];
  assert.equal(toMs(f.start.wall, f.start.zone), new Date(2026, 8, 28, 10).getTime(), "an unknown zone: local time");
});

test("all-day events", () => {
  const e = parse(cal(vevent(["UID:5", "DTSTART;VALUE=DATE:20260928", "SUMMARY:Holiday"]))).events[0];
  assert.ok(e.start.allDay);
  assert.equal(e.length, 86_400_000, "no end: one day");
  const [a] = agenda([{ name: "", events: [e] }], new Date(2026, 8, 28).getTime(), new Date(2026, 8, 29).getTime());
  assert.equal(a.start, new Date(2026, 8, 28).getTime());
});

test("weekly on several days, with an interval, a count and an exception", () => {
  const e = parse(cal(vevent([
    "UID:6", "DTSTART:20260928T090000Z", "DTEND:20260928T093000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5",
    "EXDATE:20260930T090000Z",
  ]))).events[0];
  const got = occurrences(e, utc("2026-09-01T00:00:00Z"), utc("2026-12-31T00:00:00Z")).map((ms) => new Date(ms).toISOString().slice(0, 10));
  assert.deepEqual(got, ["2026-09-28", "2026-10-12", "2026-10-14", "2026-10-26"], "Mon + Wed every other week, 5 in all, one skipped");
});

test("daily until, monthly by weekday and by day, yearly", () => {
  const range = (rrule, start = "20260105T080000Z", to = "2027-06-01T00:00:00Z") =>
    occurrences(parse(cal(vevent(["UID:x", `DTSTART:${start}`, `RRULE:${rrule}`]))).events[0], utc("2026-01-01T00:00:00Z"), utc(to))
      .map((ms) => new Date(ms).toISOString().slice(0, 10));
  assert.deepEqual(range("FREQ=DAILY;UNTIL=20260108T080000Z"), ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"]);
  assert.deepEqual(range("FREQ=MONTHLY;BYDAY=-1FR;COUNT=3"), ["2026-01-30", "2026-02-27", "2026-03-27"], "the last Friday");
  assert.deepEqual(range("FREQ=MONTHLY;BYDAY=2TU;COUNT=2"), ["2026-01-13", "2026-02-10"], "the second Tuesday");
  assert.deepEqual(range("FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3", "20260131T080000Z"), ["2026-01-31", "2026-03-31", "2026-05-31"], "months without a 31st are skipped");
  assert.deepEqual(range("FREQ=YEARLY", "20240229T080000Z", "2029-01-01T00:00:00Z"), ["2028-02-29"], "Feb 29, only in leap years");
});

test("an event that started years ago still shows today", () => {
  const e = parse(cal(vevent(["UID:7", "DTSTART:20100104T090000Z", "RRULE:FREQ=DAILY"]))).events[0];
  const got = occurrences(e, utc("2026-09-28T00:00:00Z"), utc("2026-09-30T00:00:00Z"));
  assert.deepEqual(got.map((ms) => new Date(ms).toISOString()), ["2026-09-28T09:00:00.000Z", "2026-09-29T09:00:00.000Z"]);
});

test("a moved occurrence and a cancelled one", () => {
  const c = parse(cal(
    vevent(["UID:8", "SUMMARY:Retro", "DTSTART:20260928T150000Z", "DTEND:20260928T160000Z", "RRULE:FREQ=DAILY;COUNT=3"]),
    vevent(["UID:8", "SUMMARY:Retro (moved)", "RECURRENCE-ID:20260929T150000Z", "DTSTART:20260929T170000Z", "DTEND:20260929T180000Z"]),
    vevent(["UID:8", "RECURRENCE-ID:20260930T150000Z", "DTSTART:20260930T150000Z", "STATUS:CANCELLED"]),
    vevent(["UID:9", "SUMMARY:Gone", "DTSTART:20260928T120000Z", "STATUS:CANCELLED"]),
  ));
  const list = agenda([c], utc("2026-09-27T00:00:00Z"), utc("2026-10-02T00:00:00Z"));
  assert.deepEqual(list.map((e) => [e.title, new Date(e.start).toISOString().slice(5, 16)]), [
    ["Retro", "09-28T15:00"], ["Retro (moved)", "09-29T17:00"],
  ]);
  assert.equal(list[0].calendar, "Work");
});

test("links and countdowns", () => {
  assert.equal(meetingLink({ url: "", location: "https://example.com/room", description: "https://zoom.us/j/1" }), "https://zoom.us/j/1");
  assert.equal(meetingLink({ url: "", location: "Room 1", description: "" }), null);
  const now = utc("2026-09-28T10:00:00Z");
  assert.equal(until(now + 12 * 60_000, now), "in 12m");
  assert.equal(until(now + 125 * 60_000, now), "in 2h 5m");
  assert.equal(until(now - 1, now), "now");
});
