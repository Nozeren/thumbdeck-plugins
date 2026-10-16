// The Azure Boards backend: asks Azure DevOps for your work items (with the token in the
// plugin's settings) and the ones under them, yours or not, looks again every few minutes, says how many are open (the Plugins
// pane's status), and tells you when a new one is assigned to you. Organization "demo":
// sample work items (testdata/).
import { readFileSync } from "node:fs";
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../../packages/backend/index.js";
import { added, auth, gather, ids, item, orgUrl, page, problem, wiql } from "./ado.js";

const demo = (f) => JSON.parse(readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8"));
let settings = { organization: "", token: "", show: "assigned", projects: [], hidden_states: ["Closed", "Done", "Removed"], refresh_minutes: 5, branch_prefix: "feature/" };
let items = [];
let error = "";
let updated = null;
let seen = null; // ids at the last look (null: none yet)

async function ado(path, init = {}) {
  const res = await answer(`${orgUrl(settings.organization)}${path}`, init);
  return res.json();
}

/** Asks Azure DevOps (only: the token goes nowhere else) */
async function answer(url, init = {}) {
  if (!url.startsWith(`${orgUrl(settings.organization)}/`)) throw new Error("not your organization's");
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: auth(settings.token), "Content-Type": "application/json", Accept: "application/json", ...init.headers },
    redirect: "manual", // a refused token redirects to a sign-in page
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(problem(res.status >= 300 && res.status < 400 ? 401 : res.status, settings.organization));
  return res;
}

async function load(tb) {
  const org = settings.organization.trim();
  try {
    if (!org) throw new Error("Set your organization and a token in Settings (,) › Plugins › Azure Boards");
    let list;
    let get;
    if (org === "demo") {
      const all = demo("workitems.json").value;
      list = ids(demo("wiql.json"));
      get = async (want) => all.filter((w) => want.includes(w.id));
    } else {
      if (!settings.token.trim()) throw new Error("Add a personal access token in Settings (,) › Plugins › Azure Boards");
      list = ids(await ado("/_apis/wit/wiql?api-version=7.1", { method: "POST", body: JSON.stringify({ query: wiql(settings) }) }));
      // With their relations (for what's under them), 200 at a time; errorPolicy=omit: one the
      // token can't see is left out instead of failing them all
      get = async (want) => {
        const got = [];
        for (let i = 0; i < want.length; i += 200) {
          const answer = await ado(`/_apis/wit/workitems?ids=${want.slice(i, i + 200).join(",")}&$expand=relations&errorPolicy=omit&api-version=7.1`);
          got.push(...(answer.value ?? []).filter(Boolean));
        }
        return got;
      };
    }
    const found = (list.length ? await gather(list, get, { hidden: settings.hidden_states ?? [] }) : []).map(({ w, mine, above }) => item(w, org, mine, above));
    // Recently changed first (the query's order)
    found.sort((a, b) => (b.changed > a.changed ? 1 : b.changed < a.changed ? -1 : 0));
    const now = found.filter((i) => i.mine).map((i) => i.id);
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
  tb.status(error ? "!" : `${items.filter((i) => i.mine).length} open`);
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
  /** A work item's page: its fields, rich text, links (the related work items with their
   *  titles) and discussion, newest first */
  async detail({ id }) {
    const org = settings.organization.trim();
    let w;
    let comments = [];
    let titles; // ids -> work items, for the related ones that aren't in the list
    if (org === "demo") {
      const all = demo("workitems.json").value;
      w = all.find((x) => x.id === id);
      comments = demo("comments.json")[id] ?? [];
      titles = async (want) => all.filter((x) => want.includes(x.id));
    } else {
      w = await ado(`/_apis/wit/workitems/${id}?$expand=all&api-version=7.1`);
      try {
        const project = encodeURIComponent(w.fields?.["System.TeamProject"] ?? "");
        comments = (await ado(`/${project}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`)).comments ?? [];
      } catch {} // comments are extra: the rest still shows
      titles = async (want) =>
        (await ado(`/_apis/wit/workitems?ids=${want.slice(0, 200).join(",")}&fields=System.Title,System.State,System.WorkItemType,System.TeamProject,System.AssignedTo&errorPolicy=omit&api-version=7.1`)).value?.filter(Boolean) ?? [];
    }
    if (!w) throw new Error(`no work item ${id}`);
    const p = page(w, org);
    const known = new Map(items.map((i) => [i.id, i]));
    const missing = [...new Set(p.related.map((r) => r.id))].filter((x) => !known.has(x));
    if (missing.length) {
      try {
        for (const x of await titles(missing)) known.set(x.id, item(x, org, false));
      } catch {} // without their titles
    }
    p.related = p.related.map((r) => {
      const it = known.get(r.id);
      return { ...r, title: it?.title ?? "", type: it?.type ?? "", state: it?.state ?? "", url: it?.url ?? `${orgUrl(org)}/_workitems/edit/${r.id}` };
    });
    p.comments = comments.filter((c) => !c.isDeleted)
      .map((c) => ({ by: c.createdBy?.displayName ?? "", at: c.createdDate ?? "", html: c.text ?? "" }))
      .sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
    return p;
  },
  /** An image in a description or comment (an attachment, which needs the token), as a data
   *  URL; only your organization's, an image, up to 8 MB */
  async image({ url }) {
    const res = await answer(String(url), { headers: { Accept: "image/*" } });
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) throw new Error("not an image");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) throw new Error("too big");
    return `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
  },
});
