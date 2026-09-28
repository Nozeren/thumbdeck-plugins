// The month grid: which days it shows, and the events on each. Pure functions, tested with
// `node --test` (month.test.js).

/** The days of the weeks that hold the month (local midnights), weeks starting on Monday
 *  (1) or Sunday (0): 35 or 42 days, whole weeks */
export function monthDays(year, month, weekStart = 1) {
  const first = new Date(year, month, 1);
  const back = (first.getDay() - weekStart + 7) % 7;
  const last = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((back + last) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => new Date(year, month, 1 - back + i).getTime());
}

/** The same day in another month (the 31st becomes the month's last day) */
export function shiftMonth(ms, by) {
  const d = new Date(ms);
  const last = new Date(d.getFullYear(), d.getMonth() + by + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + by, Math.min(d.getDate(), last)).getTime();
}

/** Another day, n days away (by the calendar, so DST days count as one) */
export function shiftDays(ms, n) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

/** Local midnight of the day a time is on */
export function dayStart(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The events on a day (starting on it, or going on through it): all-day ones first, then by
 *  start */
export function onDay(events, day) {
  const end = shiftDays(day, 1);
  return events
    .filter((e) => e.start < end && (e.end > day || (e.end === e.start && e.start >= day)))
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
}

/** The week days' short names, in the grid's order */
export function weekdayNames(weekStart = 1, locale) {
  return Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 7 + weekStart + i).toLocaleDateString(locale, { weekday: "short" }));
}
