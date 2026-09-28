import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { added, auth, branchName, ids, item, orgUrl, problem, text, wiql } from "./ado.js";

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

test("branch names", () => {
  assert.equal(branchName({ id: 4211, title: "Login redirects to a blank page after SSO" }), "feature/4211-login-redirects-to-a-blank-page-after-sso");
  assert.equal(branchName({ id: 7, title: "Crème brûlée: 50% off!" }, "fix/"), "fix/7-creme-brulee-50-off");
  assert.equal(branchName({ id: 8, title: "!!!" }), "feature/8");
  assert.ok(branchName({ id: 9, title: "a ".repeat(60) }).length <= "feature/9-".length + 48);
});

test("HTML as text", () => {
  assert.equal(text("<div>One</div><div><br></div><ol><li>a</li><li>b &amp; c</li></ol>"), "One\n\n• a\n• b & c");
  assert.equal(text(null), "");
});
