import { test } from "node:test";
import assert from "node:assert/strict";
import { amount, byDay, dayKey, entries, entryDay, fieldUse, hoursSetting, hoursText, hoursWiql, logged, loggedLog, notHours, notLog, weeks } from "./hours.js";

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
    'The Hours field Custom.WorkLog doesn\'t hold a number (e.g. [{"_id":1,"activityType":"Coding","start…): use a number field, leave it empty for Completed Work, or name a work log\'s keys (Custom.WorkLog | date: startDate | amount: daysSpent)');
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

test("the Hours field setting: a field, or a work log with its entries' keys", () => {
  assert.deepEqual(hoursSetting(""), { field: "Microsoft.VSTS.Scheduling.CompletedWork", log: null, problem: "" });
  assert.deepEqual(hoursSetting(" Custom.Hours "), { field: "Custom.Hours", log: null, problem: "" });
  assert.deepEqual(hoursSetting("Custom.WorkLogData | date: startDate | amount: daysSpent"), { field: "Custom.WorkLogData", log: { date: "startDate", amount: "daysSpent" }, problem: "" });
  assert.deepEqual(hoursSetting("Custom.WorkLogData|Amount:daysSpent|DATE:startDate").log, { date: "startDate", amount: "daysSpent" });
  assert.match(hoursSetting("Custom.WorkLogData | date: startDate").problem, /names no amount key for Custom\.WorkLogData's entries/);
  assert.match(hoursSetting("Custom.WorkLogData | day: startDate | amount: daysSpent").problem, /"day: startDate" isn't "date: <key>" or "amount: <key>"/);
  assert.match(hoursSetting("Custom.WorkLogData | date: | amount: daysSpent").problem, /"date:" isn't/);
  assert.match(hoursSetting("| date: startDate | amount: daysSpent").problem, /no field/);
});

test("a work log's query: IS NOT EMPTY (a long text field can't be compared with 0 or '')", () => {
  assert.equal(hoursWiql({ field: "Custom.WorkLogData", since: "2026-10-01", compare: false, log: true }),
    "SELECT [System.Id] FROM WorkItems WHERE [System.ChangedBy] EVER @Me AND [Custom.WorkLogData] IS NOT EMPTY AND [System.ChangedDate] >= '2026-10-01' ORDER BY [System.ChangedDate] DESC");
});

// One org's real shape: an html field, its quotes as &quot;
const LOG = { date: "startDate", amount: "daysSpent" };
const entry = (id, day, days, activityType = "Coding") => ({ _id: id, activityType, startDate: `${day}T00:00:00.000Z`, endDate: `${day}T00:00:00.000Z`, daysSpent: days });
const html = (list) => JSON.stringify(list).replace(/"/g, "&quot;");
const wl = (by, at, from, to) => ({ revisedBy: { uniqueName: by }, fields: { "System.ChangedDate": { newValue: at }, "Custom.WorkLogData": { oldValue: from && html(from), newValue: to && html(to) } } });
const perDay = (list) => Object.fromEntries([...byDay(list)].map(([k, d]) => [k, d.hours]));

test("a work log's entries: the JSON list in the value, entities decoded", () => {
  assert.deepEqual(entries(html([entry(1, "2026-10-15", 0.5)])), [entry(1, "2026-10-15", 0.5)]);
  assert.deepEqual(entries(`<div>${html([entry(1, "2026-10-15", 0.5)])}</div>`), [entry(1, "2026-10-15", 0.5)]);
  assert.deepEqual(entries(""), []);
  assert.deepEqual(entries(undefined), []);
  assert.equal(entries("4"), null);
  assert.equal(entries("[{&quot;_id&quot;:1,"), null);
  assert.equal(entries('{"_id":1}'), null);
});

test("a work log: an entry added counts on its own day, in days", () => {
  const a = entry(1, "2026-10-14", 0.5);
  const b = entry(2, "2026-10-15", 0.25, "Review");
  const got = loggedLog([wl("me@x.test", "2026-10-14T16:00:00Z", undefined, [a]), wl("me@x.test", "2026-10-15T16:00:00Z", [a], [a, b])], "me@x.test", "Custom.WorkLogData", LOG, 8);
  assert.deepEqual(got, [{ at: "2026-10-14T12:00:00", hours: 4 }, { at: "2026-10-15T12:00:00", hours: 2 }]);
});

test("a work log: a backdated entry lands on its date, not the revision's", () => {
  const a = entry(1, "2026-10-09", 0.25, "Meeting");
  assert.deepEqual(perDay(loggedLog([wl("me@x.test", "2026-10-12T17:00:00Z", [], [a])], "me@x.test", "Custom.WorkLogData", LOG, 8)), { "2026-10-09": 2 });
});

test("a work log: an edit and a removal correct the entries' days", () => {
  const a = entry(1, "2026-10-12", 1);
  const b = entry(2, "2026-10-13", 0.25, "Meeting");
  const a2 = { ...a, daysSpent: 0.75 };
  const moved = { ...b, startDate: "2026-10-14T00:00:00.000Z" };
  const updates = [
    wl("me@x.test", "2026-10-12T16:00:00Z", undefined, [a]),
    wl("me@x.test", "2026-10-13T16:00:00Z", [a], [a, b]),
    wl("me@x.test", "2026-10-13T17:00:00Z", [a, b], [a2, b]), // edited
    wl("me@x.test", "2026-10-15T09:00:00Z", [a2, b], [a2]), // taken out
  ];
  assert.deepEqual(perDay(loggedLog(updates, "me@x.test", "Custom.WorkLogData", LOG, 8)), { "2026-10-12": 6, "2026-10-13": 0 });
  // moved to another day: off the one, on the other
  const move = loggedLog([wl("me@x.test", "2026-10-15T09:00:00Z", [a, b], [a, moved])], "me@x.test", "Custom.WorkLogData", LOG, 8);
  assert.deepEqual(perDay(move), { "2026-10-13": -2, "2026-10-14": 2 });
  // the same entries in another order, or with their keys in another order: nothing changed
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  assert.deepEqual(loggedLog([wl("me@x.test", "2026-10-15T09:00:00Z", [a, b], [b, reordered])], "me@x.test", "Custom.WorkLogData", LOG), []);
  // two entries just alike (a multiset): one taken out counts once
  assert.deepEqual(loggedLog([wl("me@x.test", "2026-10-15T09:00:00Z", [a, a], [a])], "me@x.test", "Custom.WorkLogData", LOG), [{ at: "2026-10-12T12:00:00", hours: -1 }]);
});

test("a work log: someone else's revision isn't yours", () => {
  const a = entry(1, "2026-10-08", 0.5);
  const ann = entry(2, "2026-10-08", 1, "Testing");
  const updates = [wl("me@x.test", "2026-10-08T16:00:00Z", [], [a]), wl("ann@x.test", "2026-10-08T17:00:00Z", [a], [a, ann])];
  assert.deepEqual(perDay(loggedLog(updates, "ME@x.test", "Custom.WorkLogData", LOG, 8)), { "2026-10-08": 4 });
});

test("a work log: a value that isn't a JSON list skips that revision, and nothing fails", () => {
  const a = entry(1, "2026-10-08", 0.5);
  const b = entry(2, "2026-10-09", 0.5);
  const broken = { revisedBy: { uniqueName: "me@x.test" }, fields: { "Custom.WorkLogData": { oldValue: html([a]), newValue: "[{&quot;_id&quot;:2," } } };
  const updates = [wl("me@x.test", "2026-10-08T16:00:00Z", [], [a]), broken, wl("me@x.test", "2026-10-09T16:00:00Z", [a], [a, b])];
  assert.deepEqual(perDay(loggedLog(updates, "me@x.test", "Custom.WorkLogData", LOG)), { "2026-10-08": 0.5, "2026-10-09": 0.5 });
  // an entry without its day or amount: not counted
  assert.deepEqual(loggedLog([wl("me@x.test", "2026-10-09T16:00:00Z", [], [{ _id: 3, daysSpent: 1 }, { _id: 4, startDate: "2026-10-09" }])], "me@x.test", "Custom.WorkLogData", LOG), []);
});

test("a work log's first value: its keys checked, not whether it's a number", () => {
  const v = html([entry(1, "2026-10-15", 0.5)]);
  assert.equal(notLog(v, "Custom.WorkLogData", LOG), "");
  assert.equal(notLog("[]", "Custom.WorkLogData", LOG), "");
  assert.match(notLog(v, "Custom.WorkLogData", { date: "start", amount: "daysSpent" }), /^The entries in the Hours field Custom\.WorkLogData have no "start" \(e\.g\. \{"_id":1,/);
  assert.match(notLog(v, "Custom.WorkLogData", { date: "start", amount: "days" }), /have no "start" or "days"/);
  assert.match(notLog("4", "Custom.WorkLogData", LOG), /doesn't hold a JSON list of entries \(e\.g\. 4\)/);
});

test("a work log entry's day: a date or midnight as it is; a time of day where you are", () => {
  assert.equal(entryDay("2026-10-15"), "2026-10-15T12:00:00");
  assert.equal(entryDay("2026-10-15T00:00:00.000Z"), "2026-10-15T12:00:00");
  assert.equal(entryDay("2026-10-15T00:00:00+00:00"), "2026-10-15T12:00:00");
  assert.equal(entryDay("2026-10-15T00:00"), "2026-10-15T12:00:00");
  const late = "2026-10-15T23:30:00Z";
  assert.equal(entryDay(late), `${dayKey(new Date(late))}T12:00:00`, "the day it is here");
  assert.equal(entryDay("2026-10-15T23:30:00"), "2026-10-15T12:00:00", "no zone: already local");
  assert.equal(entryDay("not a date"), "");
  assert.equal(entryDay(""), "");
});
