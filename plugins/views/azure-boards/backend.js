// The Azure Boards backend: asks Azure DevOps for your work items (with the token in the
// plugin's settings), looks again every few minutes, says how many are open (the Plugins
// pane's status), and tells you when a new one is assigned to you. Organization "demo":
// sample work items (testdata/).
import { readFileSync } from "node:fs";
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../../packages/backend/index.js";
import { added, auth, FIELD_LIST, ids, item, orgUrl, problem, text, wiql } from "./ado.js";

const demo = (f) => JSON.parse(readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8"));
let settings = { organization: "", token: "", show: "assigned", projects: [], hidden_states: ["Closed", "Done", "Removed"], refresh_minutes: 5, branch_prefix: "feature/" };
let items = [];
let error = "";
let updated = null;
let seen = null; // ids at the last look (null: none yet)

async function ado(path, init = {}) {
  const res = await fetch(`${orgUrl(settings.organization)}${path}`, {
    ...init,
    headers: { Authorization: auth(settings.token), "Content-Type": "application/json", Accept: "application/json", ...init.headers },
    redirect: "manual", // a refused token redirects to a sign-in page
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(problem(res.status >= 300 && res.status < 400 ? 401 : res.status, settings.organization));
  return res.json();
}

async function load(tb) {
  const org = settings.organization.trim();
  try {
    if (!org) throw new Error("Set your organization and a token in Settings (,) › Plugins › Azure Boards");
    let found;
    if (org === "demo") found = demo("workitems.json").value.map((w) => item(w, "demo"));
    else {
      if (!settings.token.trim()) throw new Error("Add a personal access token in Settings (,) › Plugins › Azure Boards");
      const list = ids(await ado("/_apis/wit/wiql?api-version=7.1", { method: "POST", body: JSON.stringify({ query: wiql(settings) }) }));
      found = list.length ? (await ado(`/_apis/wit/workitems?ids=${list.join(",")}&fields=${FIELD_LIST}&api-version=7.1`)).value.map((w) => item(w, org)) : [];
      // In the query's order (recently changed first)
      found.sort((a, b) => list.indexOf(a.id) - list.indexOf(b.id));
    }
    const now = found.map((i) => i.id);
    for (const id of added(seen, now)) {
      const it = found.find((i) => i.id === id);
      tb.notify(`${it.type} ${it.id} is yours`, it.title);
    }
    seen = now;
    items = found;
    error = "";
  } catch (e) {
    error = e.message;
  }
  updated = Date.now();
  tb.status(error ? "!" : `${items.length} open`);
  tb.event("updated", { updated });
}

let timer = null;
function schedule(tb) {
  clearInterval(timer);
  timer = setInterval(() => load(tb), Math.max(1, settings.refresh_minutes) * 60_000);
}

serve({
  initialize(info, tb) {
    settings = { ...settings, ...info.settings };
    load(tb);
    schedule(tb);
  },
  settings(s, tb) {
    settings = { ...settings, ...s };
    seen = null; // another query: what it finds isn't news
    load(tb);
    schedule(tb);
  },
  list: () => ({ items, error, updated, branchPrefix: settings.branch_prefix }),
  async refresh(_p, tb) {
    await load(tb);
    return { error };
  },
  /** A work item's description and comments */
  async detail({ id }) {
    const it = items.find((i) => i.id === id);
    if (!it) throw new Error(`no work item ${id}`);
    if (settings.organization.trim() === "demo") {
      const w = demo("workitems.json").value.find((x) => x.id === id);
      return { description: text(w.fields["System.Description"]), comments: (demo("comments.json")[id] ?? []).map(comment) };
    }
    const w = await ado(`/_apis/wit/workitems/${id}?fields=System.Description,Microsoft.VSTS.TCM.ReproSteps,Microsoft.VSTS.Common.AcceptanceCriteria&api-version=7.1`);
    const f = w.fields ?? {};
    const description = [f["System.Description"], f["Microsoft.VSTS.TCM.ReproSteps"] && `Repro steps:\n${text(f["Microsoft.VSTS.TCM.ReproSteps"])}`,
      f["Microsoft.VSTS.Common.AcceptanceCriteria"] && `Acceptance criteria:\n${text(f["Microsoft.VSTS.Common.AcceptanceCriteria"])}`]
      .filter(Boolean).map((x, i) => (i === 0 ? text(x) : x)).join("\n\n");
    let comments = [];
    try {
      comments = ((await ado(`/${encodeURIComponent(it.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`)).comments ?? []).map(comment);
    } catch {} // comments are extra: the description still shows
    return { description, comments };
  },
});

function comment(c) {
  return { by: c.createdBy?.displayName ?? "", at: c.createdDate ?? "", text: text(c.text) };
}
