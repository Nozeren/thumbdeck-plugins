import { test } from "node:test";
import assert from "node:assert/strict";
import { byDay, dayKey, hoursText, hoursWiql, logged, weeks } from "./hours.js";

test("the query: changed by you ever, with hours, since a day, in the projects", () => {
  assert.equal(hoursWiql({ since: "2026-09-28" }),
    "SELECT [System.Id] FROM WorkItems WHERE [System.ChangedBy] EVER @Me AND [Microsoft.VSTS.Scheduling.CompletedWork] > 0 AND [System.ChangedDate] >= '2026-09-28' ORDER BY [System.ChangedDate] DESC");
  assert.match(hoursWiql({ field: "Custom.Hours", since: "2026-09-28", projects: ["O'Brien"] }), /\[Custom\.Hours\] > 0 .* IN \('O''Brien'\)/);
});

const rev = (by, at, from, to) => ({ revisedBy: { uniqueName: by }, fields: { "System.ChangedDate": { newValue: at }, "Microsoft.VSTS.Scheduling.CompletedWork": { oldValue: from, newValue: to } } });

test("what you logged: your increases (and corrections), not others'", () => {
  const updates = [
    rev("ME@x.test", "2026-10-01T09:00:00Z", undefined, 2),
    rev("ann@x.test", "2026-10-01T10:00:00Z", 2, 5),
    rev("me@x.test", "2026-10-02T09:00:00Z", 5, 6.5),
    rev("me@x.test", "2026-10-02T11:00:00Z", 6.5, 6),
    { revisedBy: { uniqueName: "me@x.test" }, fields: { "System.State": { newValue: "Active" } } },
  ];
  assert.deepEqual(logged(updates, "me@x.test"), [
    { at: "2026-10-01T09:00:00Z", hours: 2 }, { at: "2026-10-02T09:00:00Z", hours: 1.5 }, { at: "2026-10-02T11:00:00Z", hours: -0.5 },
  ]);
  assert.deepEqual(logged(updates, ""), []);
});

test("by day: totals, and each work item's", () => {
  const a = { id: 1, title: "A" };
  const b = { id: 2, title: "B" };
  const days = byDay([
    { ...a, at: "2026-10-01T09:00:00", hours: 2 }, { ...b, at: "2026-10-01T15:00:00", hours: 3 }, { ...a, at: "2026-10-01T16:00:00", hours: 0.1 },
    { ...a, at: "2026-10-01T17:00:00", hours: 0.2 }, { ...b, at: "2026-10-02T09:00:00", hours: 1 }, { ...b, at: "2026-10-02T10:00:00", hours: -1 },
  ]);
  assert.deepEqual(days.get("2026-10-01"), { hours: 5.3, items: [{ id: 2, title: "B", hours: 3 }, { id: 1, title: "A", hours: 2.3 }] });
  assert.deepEqual(days.get("2026-10-02"), { hours: 0, items: [] }, "corrected away");
});

test("days and hours in words", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 30)), "2026-01-05");
  assert.equal(hoursText(2.5), "2.5h");
  assert.equal(hoursText(0.75), "45m");
  assert.equal(hoursText(0), "0h");
});

test("a month's weeks start on Monday, and cover it", () => {
  const oct = weeks(2026, 9); // October 2026: Thursday the 1st
  assert.equal(oct.length, 5);
  assert.equal(dayKey(oct[0][0]), "2026-09-28");
  assert.equal(dayKey(oct[4][6]), "2026-11-01");
  const feb = weeks(2027, 1); // February 2027: Monday the 1st, 28 days
  assert.equal(feb.length, 4);
  assert.equal(dayKey(feb[0][0]), "2027-02-01");
  assert.ok(weeks(2026, 7).length === 6, "August 2026 needs six");
});
