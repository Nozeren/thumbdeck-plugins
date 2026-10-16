import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { added, artifact, auth, branchName, childIds, gather, ids, item, orgUrl, page, problem, rows, wiql } from "./ado.js";

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
  assert.deepEqual(added(null, [1, 2]), [], "the first look isn't news");
  assert.deepEqual(added([1, 2], [3, 1, 2]), [3]);
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
  assert.deepEqual(p.planning, [{ label: "Priority", value: 1 }, { label: "Severity", value: "2 - High" }, { label: "Effort", value: 3 }]);
  assert.deepEqual(p.other, [{ label: "Customer impact", value: "Every SSO customer" }]);
  assert.deepEqual(p.related, [{ kind: "Parent", id: 4100 }, { kind: "Related", id: 4175 }]);
  assert.deepEqual(p.development, [
    { kind: "Branch", label: "feature/4211-login-redirects", url: "https://dev.azure.com/contoso/9b1c/_git/a7e2?version=GBfeature%2F4211-login-redirects" },
    { kind: "Pull request", label: "!311", url: "https://dev.azure.com/contoso/9b1c/_git/a7e2/pullrequest/311" },
  ]);
  assert.deepEqual(p.links, [{ label: "The incident", url: "https://status.example.test/incidents/77" }]);
  assert.deepEqual(p.attachments.map((a) => [a.name, a.size]), [["blank.png", 48213]]);
  assert.equal(page({ id: 1, fields: { "Custom.Notes": "<p>rich</p>" } }, "x").rich[0].label, "Notes", "a custom field with HTML: rich text");
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
