import { test } from "node:test";
import assert from "node:assert/strict";
import { amount, byDay, dayKey, fieldUse, hoursText, hoursWiql, logged, notHours, weeks } from "./hours.js";

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

test("a text field's query: no comparison with 0 (Azure DevOps refuses it: TF212023)", () => {
  const q = hoursWiql({ field: "Custom.Hours", since: "2026-09-28", compare: false });
  assert.equal(q, "SELECT [System.Id] FROM WorkItems WHERE [System.ChangedBy] EVER @Me AND [System.ChangedDate] >= '2026-09-28' ORDER BY [System.ChangedDate] DESC");
});

test("which fields can hold hours", () => {
  assert.equal(fieldUse("double"), "number");
  assert.equal(fieldUse("integer"), "number");
  assert.equal(fieldUse("picklistDouble"), "number");
  assert.equal(fieldUse("html"), "text");
  assert.equal(fieldUse("plainText"), "text");
  assert.equal(fieldUse("string"), "text");
  assert.equal(fieldUse("dateTime"), null);
  assert.equal(fieldUse("identity"), null);
  assert.equal(fieldUse(undefined), null);
});

test("a value as a number: a number, or text (or HTML) that is one and nothing else", () => {
  assert.equal(amount(2.5), 2.5);
  assert.equal(amount("3"), 3);
  assert.equal(amount("2,5"), 2.5);
  assert.equal(amount(" 2.5 "), 2.5);
  assert.equal(amount("<div>4</div>"), 4);
  assert.equal(amount("<div>1,5&nbsp;</div>"), 1.5);
  assert.equal(amount(""), 0);
  assert.equal(amount("<div>&nbsp;</div>"), 0);
  assert.equal(amount(undefined), 0);
  assert.equal(amount(NaN), 0);
  assert.equal(amount("none"), null);
  assert.equal(amount("about 4.25 hours"), null);
  assert.equal(amount("1.5 h"), null);
});

test("a JSON value is refused, not its first number", () => {
  const log = '[{"_id":1,"activityType":"Coding","startDate":"2026-10-01T09:00:00Z","daysSpent":0.5}]';
  assert.equal(amount(log), null);
  assert.equal(notHours(log, "Custom.WorkLog"),
    'The Hours field Custom.WorkLog doesn\'t hold a number (e.g. [{"_id":1,"activityType":"Coding","start…): use a number field, or leave it empty for Completed Work');
  assert.equal(notHours("<div>4</div>", "Custom.Hours"), "");
  assert.equal(notHours(2.5, "Custom.Hours"), "");
  const f = (from, to) => ({ revisedBy: { uniqueName: "me@x.test" }, fields: { "System.ChangedDate": { newValue: "2026-10-01T09:00:00Z" }, "Custom.WorkLog": { oldValue: from, newValue: to } } });
  assert.deepEqual(logged([f(undefined, log)], "me@x.test", "Custom.WorkLog"), [], "no 1h from its _id");
});

test("logged in days: a working day's hours each", () => {
  const updates = [rev("me@x.test", "2026-10-01T09:00:00Z", undefined, 0.5), rev("me@x.test", "2026-10-02T09:00:00Z", 0.5, 1.25)];
  assert.deepEqual(logged(updates, "me@x.test", undefined, 8), [{ at: "2026-10-01T09:00:00Z", hours: 4 }, { at: "2026-10-02T09:00:00Z", hours: 6 }]);
  assert.deepEqual(logged(updates, "me@x.test", undefined, 7.5).map((e) => e.hours), [3.75, 5.63], "rounded to 2 places");
});

test("logged in a text field", () => {
  const f = (from, to) => ({ revisedBy: { uniqueName: "me@x.test" }, fields: { "System.ChangedDate": { newValue: "2026-10-01T09:00:00Z" }, "Custom.Hours": { oldValue: from, newValue: to } } });
  assert.deepEqual(logged([f(undefined, "<div>2</div>"), f("<div>2</div>", "<div>3.5</div>")], "me@x.test", "Custom.Hours").map((e) => e.hours), [2, 1.5]);
});
