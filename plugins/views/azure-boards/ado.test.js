import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  artifact, auth, branchName, changes, childIds, commentHtml, current, fieldSettings, gather, history, ids, item, orgUrl, page, patch, problem, rows, snapshot,
  sprintOnly, text, wiql, within,
} from "./ado.js";

const testdata = (f) => JSON.parse(readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8"));

test("the query follows the settings", () => {
  assert.equal(wiql({ show: "assigned", hidden_states: ["Closed", "Done"], projects: [] }),
    "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Done') ORDER BY [System.ChangedDate] DESC");
  const q = wiql({ show: "created", hidden_states: [], projects: ["Shop", "O'Brien"] });
  assert.match(q, /\[System\.CreatedBy\] = @Me AND \[System\.TeamProject\] IN \('Shop', 'O''Brien'\)/, "quotes doubled");
  assert.match(wiql({ show: "following" }), /IN \(@Follows\)/);
});

test("organizations, tokens and answers", () => {
  assert.equal(orgUrl("contoso"), "https://dev.azure.com/contoso");
  assert.equal(orgUrl("https://dev.azure.com/contoso/"), "https://dev.azure.com/contoso");
  assert.equal(orgUrl("https://contoso.visualstudio.com"), "https://contoso.visualstudio.com");
  assert.equal(auth(" abc "), `Basic ${Buffer.from(":abc").toString("base64")}`);
  assert.match(problem(401, "x"), /refused the token/);
  assert.match(problem(404, "x"), /no organization "x"/);
  assert.deepEqual(ids(testdata("wiql.json")), [4211, 4198, 4175, 3990]);
  assert.match(problem(403, "x", { writing: true }), /Read & write/);
  assert.match(problem(400, "x", { writing: true, message: "TF26071: This work item has been changed by someone else" }), /changed it meanwhile/);
  assert.equal(problem(400, "x", { message: "The field is read only" }), "Azure DevOps: The field is read only");
});

test("work items as the view shows them", () => {
  const [first] = testdata("workitems.json").value.map((w) => item(w, "contoso"));
  assert.deepEqual([first.id, first.type, first.state, first.project, first.priority], [4211, "Bug", "Active", "Shop", 1]);
  assert.deepEqual(first.tags, ["auth", "sso"]);
  assert.equal(first.assignedTo, "Me");
  assert.equal(first.url, "https://dev.azure.com/contoso/Shop/_workitems/edit/4211");
});

test("what's under your work items, yours or not, and what they're under", async () => {
  const all = testdata("workitems.json").value;
  assert.deepEqual(childIds(all.find((w) => w.id === 4198)), [4175, 4201, 4202]);
  const asked = [];
  const fetch = async (want) => (asked.push(want), all.filter((w) => want.includes(w.id)));
  const found = await gather(ids(testdata("wiql.json")), fetch, { hidden: ["Done"] });
  assert.deepEqual(found.map(({ w, mine, above }) => [w.id, mine, !!above]),
    [[4211, true, false], [4198, true, false], [4175, true, false], [3990, true, false], [4201, false, false], [4205, false, false], [4100, false, true]],
    "a grandchild found; a Done child left out; one already found isn't asked again; the feature above 4211");
  assert.deepEqual(asked, [[4211, 4198, 4175, 3990], [4201, 4202], [4205], [4100]], "not what else is under the feature");
  const it = item(all.find((w) => w.id === 4205), "contoso", false);
  assert.deepEqual([it.parent, it.mine, it.assignedTo], [4201, false, ""]);
  assert.equal(item({ id: 1, fields: {}, relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://x/_apis/wit/workItems/9" }] }, "x").parent, 9,
    "the parent from the relations without System.Parent");
});

test("the list as a tree", () => {
  const items = [
    { id: 1, title: "Story", parent: null }, { id: 2, title: "Task", parent: 1 }, { id: 3, title: "Bug", parent: 1 },
    { id: 4, title: "Subtask", parent: 3 }, { id: 5, title: "Alone", parent: 99 },
  ];
  const tree = (o) => rows(items, o).map((r) => `${" ".repeat(r.depth)}${r.it.id}${r.kids ? (r.open ? "-" : "+") : ""}`);
  assert.deepEqual(tree(), ["1-", " 2", " 3-", "  4", "5"], "a parent not in the list: at the top");
  assert.deepEqual(tree({ collapsed: new Set([3]) }), ["1-", " 2", " 3+", "5"]);
  assert.deepEqual(tree({ collapsed: new Set([3]), words: "subtask" }), ["1-", " 3-", "  4"], "a match shows with what's above it, open");
  assert.deepEqual(tree({ words: "4" }), ["1-", " 3-", "  4"], "by id");
  assert.deepEqual(rows([{ id: 1, title: "a", parent: 2 }, { id: 2, title: "b", parent: 1 }]), [], "a loop doesn't hang");
});

test("the most recently changed first; one above yours by what's under it", () => {
  const items = [
    { id: 1, title: "mine, older", parent: null, changed: "2026-09-02" },
    { id: 2, title: "an old feature above", parent: null, changed: "2026-01-01", above: true },
    { id: 3, title: "mine, newest", parent: 2, changed: "2026-09-05" },
    { id: 4, title: "mine, newer", parent: null, changed: "2026-09-03" },
  ];
  assert.deepEqual(rows(items).map((r) => r.it.id), [2, 3, 4, 1]);
});

test("a work item's page", () => {
  const w = testdata("workitems.json").value.find((x) => x.id === 4211);
  const p = page(w, "contoso");
  assert.deepEqual([p.reason, p.area, p.createdBy, p.changedBy], ["Approved", "Shop\\Accounts", "Ann", "Bob"]);
  assert.deepEqual(p.rich.map((r) => r.label), ["Description", "Repro steps", "System info"]);
  assert.deepEqual(p.planning.map((x) => [x.label, x.value]), [["Priority", 1], ["Severity", "2 - High"], ["Effort", 3]]);
  assert.deepEqual(p.other.map((x) => [x.label, x.value, x.format]), [
    ["Account manager", "Dana", "person"], ["Contract end", "2027-03-31T00:00:00Z", "text"], ["Customer impact", "Every SSO customer", "text"],
    ["Escalated", true, "text"], ["Workaround notes", "Until it's fixed:\n\n- sign in **without** SSO\n- or use `/login?sso=0`", "text"],
  ], "your organization's own fields, any prefix, guessed without their types; not the Kanban column");
  assert.deepEqual(p.related, [{ kind: "Parent", id: 4100 }, { kind: "Related", id: 4175 }]);
  assert.deepEqual(p.development, [
    { kind: "Branch", label: "feature/4211-login-redirects", url: "https://dev.azure.com/contoso/9b1c/_git/a7e2?version=GBfeature%2F4211-login-redirects" },
    { kind: "Pull request", label: "!311", url: "https://dev.azure.com/contoso/9b1c/_git/a7e2/pullrequest/311" },
  ]);
  assert.deepEqual(p.links, [{ label: "The incident", url: "https://status.example.test/incidents/77" }]);
  assert.deepEqual(p.attachments.map((a) => [a.name, a.size]), [["blank.png", 48213]]);
  assert.equal(page({ id: 1, fields: { "Custom.Notes": "<p>rich</p>" } }, "x").rich[0].label, "Notes", "a custom field with HTML: rich text");
});

test("your organization's fields, as their types say and as the Fields setting says", () => {
  const w = testdata("workitems.json").value.find((x) => x.id === 4211);
  const types = new Map(testdata("fields.json").value.map((x) => [x.referenceName.toLowerCase(), { name: x.name, type: x.type }]));
  let p = page(w, "contoso", { types });
  assert.deepEqual(p.other.map((x) => [x.label, x.value, x.format]), [
    ["Account Manager", "Dana", "person"], ["Contract End", "2027-03-31T00:00:00Z", "date"], ["Customer Impact", "Every SSO customer", "text"],
    ["Escalated", "Yes", "yes-no"],
  ]);
  assert.deepEqual(p.rich.map((r) => r.label), ["Description", "Repro steps", "System info", "Workaround Notes"], "multi-line text: beside the description");
  assert.match(p.rich[3].html, /<li>sign in <strong>without<\/strong> SSO<\/li>/, "as Markdown");
  const { fields, problems } = fieldSettings([
    "Contoso.Escalated | | hidden", "custom.customerimpact | Impact | markdown | main", "Microsoft.VSTS.Common.Severity | | | details",
    "# a comment", "", "Contoso.ContractEnd | Renewal | date | planning", "Bad field! | x", "Contoso.X | | colour", "Contoso.Y | | | sidebar",
  ]);
  assert.equal(problems.length, 3);
  assert.match(problems.join(" "), /reference name.*no format "colour".*nowhere called "sidebar"/s);
  p = page(w, "contoso", { types, custom: fields });
  assert.deepEqual(p.rich.map((r) => r.label), ["Description", "Repro steps", "System info", "Impact", "Workaround Notes"]);
  assert.deepEqual(p.planning.map((x) => x.label), ["Priority", "Effort", "Renewal"]);
  assert.deepEqual(p.other.map((x) => x.label), ["Severity", "Account Manager"], "hidden: Escalated; moved: Severity");
});

test("Markdown in work items", () => {
  const all = testdata("workitems.json").value;
  const story = page(all.find((x) => x.id === 4198), "contoso").rich[0].html;
  assert.match(story, /<h3>Notes<\/h3>/, "a Markdown field (multilineFieldsFormat)");
  assert.match(story, /<a href="https:\/\/dev\.azure\.com\/contoso\/_workitems\/edit\/4100">#4100<\/a>/);
  assert.match(story, /<li>☑ Design approved<\/li><li>☐ Copy reviewed<\/li>/);
  assert.match(story, /<td>SPRING10<\/td><td align="right">10%<\/td>/);
  const bug = page(all.find((x) => x.id === 4201), "contoso").rich[0].html;
  assert.match(bug, /<h2>What happens<\/h2>[\s\S]*<strong>0\.00<\/strong>[\s\S]*<li>show <code>0\.01<\/code><\/li>/, "Markdown typed into the HTML editor");
  assert.equal(page(all.find((x) => x.id === 4211), "contoso").rich[0].html, all.find((x) => x.id === 4211).fields["System.Description"], "HTML: as it is");
});

test("development links", () => {
  assert.deepEqual(artifact("vstfs:///Git/Commit/p%2Fr%2F0123456789abcdef", "Fixed in Commit", "contoso", "Shop"),
    { kind: "Fixed in Commit", label: "01234567", url: "https://dev.azure.com/contoso/p/_git/r/commit/0123456789abcdef" });
  assert.deepEqual(artifact("vstfs:///Build/Build/88", "Integrated in build", "contoso", "My Shop"),
    { kind: "Integrated in build", label: "#88", url: "https://dev.azure.com/contoso/My%20Shop/_build/results?buildId=88" });
  assert.equal(artifact("vstfs:///Wiki/WikiPage/x", "Wiki", "contoso", "Shop").url, null, "one it doesn't know: named, no page");
  assert.equal(artifact("https://example.test", "", "contoso", "Shop"), null);
});

test("branch names", () => {
  assert.equal(branchName({ id: 4211, title: "Login redirects to a blank page after SSO" }), "feature/4211-login-redirects-to-a-blank-page-after-sso");
  assert.equal(branchName({ id: 7, title: "Crème brûlée: 50% off!" }, "fix/"), "fix/7-creme-brulee-50-off");
  assert.equal(branchName({ id: 8, title: "!!!" }), "feature/8");
  assert.ok(branchName({ id: 9, title: "a ".repeat(60) }).length <= "feature/9-".length + 48);
});

test("changes: a patch that doesn't undo someone else's", () => {
  assert.deepEqual(patch({ state: "Resolved", priority: "2", tags: ["a", "b"] }, 7), [
    { op: "test", path: "/rev", value: 7 },
    { op: "add", path: "/fields/System.State", value: "Resolved" },
    { op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 2 },
    { op: "add", path: "/fields/System.Tags", value: "a; b" },
  ]);
  assert.deepEqual(patch({ assignee: "" }, null), [{ op: "add", path: "/fields/System.AssignedTo", value: "" }]);
  assert.throws(() => patch({ "System.Rev": 1 }, 1), /can't be changed/);
  assert.equal(commentHtml("Looks fine\nto me.\n\n<b>ship</b> & **go** (#12)", "contoso"),
    `<p>Looks fine<br>to me.</p>\n<p>&lt;b&gt;ship&lt;/b&gt; &amp; <strong>go</strong> (<a href="https://dev.azure.com/contoso/_workitems/edit/12">#12</a>)</p>`, "typed as Markdown; HTML typed: text");
});

test("what changed on yours, not by you", () => {
  const was = (o) => ({ id: 1, type: "Bug", title: "t", state: "Active", assignee: "me@x", changedBy: "bob@x", comments: 2, ...o });
  const before = snapshot([was(), was({ id: 2, assignee: "ann@x" })]);
  assert.deepEqual(changes(null, [was()], "me@x"), [], "the first look isn't news");
  assert.deepEqual(changes(before, [was({ state: "Resolved", comments: 4 }), was({ id: 2 }), was({ id: 3 })], "ME@x"), [
    { id: 1, kind: "state", from: "Active", to: "Resolved" },
    { id: 1, kind: "comments", count: 2 },
    { id: 2, kind: "assigned" },
    { id: 3, kind: "assigned" },
  ]);
  assert.deepEqual(changes(before, [was({ state: "Closed", changedBy: "me@x" }), was({ id: 2, changedBy: "me@x" })], "me@x"), [], "your own changes");
  assert.deepEqual(changes(before, [was({ state: "Closed", assignee: "ann@x", assignedTo: "Ann" })], "me@x"), [
    { id: 1, kind: "unassigned", to: "Ann" }, { id: 1, kind: "state", from: "Active", to: "Closed" },
  ], "one that left the list: taken off you, closed");
});

test("the current sprint", () => {
  const its = testdata("iterations.json").value;
  assert.equal(current(its), "Shop\\Sprint 42");
  assert.equal(current([]), null);
  assert.ok(within("Shop\\Sprint 42", "Shop\\Sprint 42") && within("Shop\\Sprint 42\\Week 1", "Shop\\Sprint 42"));
  assert.ok(!within("Shop\\Sprint 421", "Shop\\Sprint 42") && !within("Shop\\Sprint 42", null));
  const items = [
    { id: 1, parent: null, above: true }, { id: 2, parent: 1, mine: true, sprint: true }, { id: 3, parent: null, mine: true, sprint: false },
    { id: 4, parent: 2, sprint: true }, { id: 5, parent: 3, sprint: false }, { id: 6, parent: null, above: true },
  ];
  assert.deepEqual(sprintOnly(items).map((i) => i.id), [1, 2, 4], "what's above stays only over the sprint's");
});

test("a comment as a notification's text", () => {
  assert.equal(text("<div>Looks like the <b>state</b> param&nbsp;is lost.</div><p>Two &amp; three</p>"), "Looks like the state param is lost. Two & three");
});

test("a work item's history, as what happened", () => {
  const events = history(testdata("updates.json")["4211"]).map((e) => [e.by, e.kind, e.from, e.to]);
  assert.deepEqual(events, [
    ["Ann", "created", "", "New"],
    ["Bob", "state", "New", "Active"], ["Bob", "assignee", "", "Me"],
    ["Carol", "iteration", "Shop\\Sprint 41", "Shop\\Sprint 42"], ["Carol", "tags", "auth", "auth; sso"],
    ["Me", "development", "", "Pull Request"],
    ["Bob", "priority", 2, 1],
  ], "the parent given at its creation: part of it; the description's edit: left out");
  const [e] = history([{ rev: 2, revisedBy: { displayName: "Dana <dana@x>", uniqueName: "dana@x" }, revisedDate: "2026-10-01T10:00:00Z",
    relations: { removed: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://x/_apis/wit/workItems/7" }] } }]);
  assert.deepEqual(e, { at: "2026-10-01T10:00:00Z", by: "Dana", byId: "dana@x", kind: "parent", from: 7, to: "" }, "no ChangedDate: when it was revised");
});
