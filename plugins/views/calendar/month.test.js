import { test } from "node:test";
import assert from "node:assert/strict";
import { dayStart, monthDays, onDay, shiftDays, shiftMonth, weekdayNames } from "./month.js";

const d = (ms) => { const x = new Date(ms); return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`; };

test("the month's weeks", () => {
  // September 2026 starts on a Tuesday
  const mon = monthDays(2026, 8, 1);
  assert.equal(mon.length, 35);
  assert.equal(d(mon[0]), "2026-8-31");
  assert.equal(d(mon[1]), "2026-9-1");
  assert.equal(d(mon.at(-1)), "2026-10-4");
  const sun = monthDays(2026, 8, 0);
  assert.equal(d(sun[0]), "2026-8-30");
  // February 2027 starts on a Monday: four whole weeks
  assert.equal(monthDays(2027, 1, 1).length, 28);
  // March 2026 across the clocks going forward: every day once
  const march = monthDays(2026, 2, 1).map(d);
  assert.equal(new Set(march).size, march.length);
});

test("moving by days and months", () => {
  const jan31 = new Date(2026, 0, 31).getTime();
  assert.equal(d(shiftMonth(jan31, 1)), "2026-2-28");
  assert.equal(d(shiftMonth(jan31, -2)), "2025-11-30");
  assert.equal(d(shiftDays(jan31, 1)), "2026-2-1");
  assert.equal(d(shiftDays(new Date(2026, 2, 28).getTime(), 2)), "2026-3-30");
  assert.equal(dayStart(new Date(2026, 4, 3, 15, 20).getTime()), new Date(2026, 4, 3).getTime());
});

test("the events on a day", () => {
  const day = new Date(2026, 8, 28).getTime();
  const at = (h) => day + h * 3600_000;
  const events = [
    { title: "standup", start: at(9.5), end: at(9.75), allDay: false },
    { title: "trip", start: shiftDays(day, -1), end: shiftDays(day, 2), allDay: true },
    { title: "late", start: at(23), end: at(25), allDay: false },
    { title: "tomorrow", start: at(24), end: at(25), allDay: false },
    { title: "ended at midnight", start: at(-2), end: day, allDay: false },
    { title: "a moment", start: at(12), end: at(12), allDay: false },
  ];
  assert.deepEqual(onDay(events, day).map((e) => e.title), ["trip", "standup", "a moment", "late"]);
});

test("week day names", () => {
  assert.deepEqual(weekdayNames(1, "en-US"), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.equal(weekdayNames(0, "en-US")[0], "Sun");
});
