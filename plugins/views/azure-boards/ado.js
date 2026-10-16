// Azure Boards (Azure DevOps work items): the queries, reading the answers, and small helpers.
// Pure functions, tested with `node --test` (ado.test.js); backend.js does the asking.

/** A text for a WIQL string (single quotes doubled) */
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The WIQL for the work items to list, from the settings */
export function wiql(s) {
  const where = [];
  where.push(s.show === "created" ? "[System.CreatedBy] = @Me" : s.show === "following" ? "[System.Id] IN (@Follows)" : "[System.AssignedTo] = @Me");
  const hidden = (s.hidden_states ?? []).filter(Boolean);
  if (hidden.length) where.push(`[System.State] NOT IN (${hidden.map(quote).join(", ")})`);
  const projects = (s.projects ?? []).filter(Boolean);
  if (projects.length) where.push(`[System.TeamProject] IN (${projects.map(quote).join(", ")})`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
}

/** The organization's URL: "contoso", "https://dev.azure.com/contoso" or an old
 *  "https://contoso.visualstudio.com" all work */
export function orgUrl(org) {
  const o = String(org).trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(o)) return o;
  return `https://dev.azure.com/${encodeURIComponent(o)}`;
}

/** The Authorization header for a personal access token */
export const auth = (token) => `Basic ${Buffer.from(`:${String(token).trim()}`).toString("base64")}`;

const PARENT = "System.LinkTypes.Hierarchy-Reverse";
const CHILD = "System.LinkTypes.Hierarchy-Forward";
/** The ids a work item links to with a link type (its relations, from $expand=relations) */
const linked = (w, rel) => (w.relations ?? []).filter((r) => r.rel === rel).map((r) => Number(String(r.url).split("/").pop())).filter(Number.isInteger);
/** A work item's children's ids */
export const childIds = (w) => linked(w, CHILD);
/** A work item's parent's id (null: none) */
export const parentId = (w) => w.fields?.["System.Parent"] ?? linked(w, PARENT)[0] ?? null;

/** Your work items (the ids of the query), everything under them, yours or not, and what
 *  they're under (for where they belong, not what else is there): asks for a level at a time
 *  (fetch(ids) gives the work items, with their relations). Ones under yours in a hidden state
 *  are left out, and what's under them. [{ w, mine, above }], yours first. */
export async function gather(mine, fetch, { hidden = [], depth = 6, limit = 1000 } = {}) {
  const found = new Map();
  for (const w of await fetch(mine)) found.set(w.id, { w, mine: true });
  let next = [...found.values()].flatMap(({ w }) => childIds(w));
  for (let level = 0; level < depth && found.size < limit; level++) {
    const ask = [...new Set(next)].filter((id) => !found.has(id)).slice(0, limit - found.size);
    if (!ask.length) break;
    next = [];
    for (const w of await fetch(ask)) {
      if (hidden.includes(w.fields?.["System.State"])) continue;
      found.set(w.id, { w, mine: false });
      next.push(...childIds(w));
    }
  }
  let up = [...found.values()].filter((f) => f.mine).map(({ w }) => parentId(w));
  for (let level = 0; level < depth && found.size < limit; level++) {
    const ask = [...new Set(up)].filter((id) => id != null && !found.has(id)).slice(0, limit - found.size);
    if (!ask.length) break;
    up = [];
    for (const w of await fetch(ask)) {
      found.set(w.id, { w, mine: false, above: true });
      up.push(parentId(w));
    }
  }
  return [...found.values()];
}

/** A work item from the API as the view shows it (mine: one of the query's; above: not, but
 *  one of yours is under it) */
export function item(w, org, mine = true, above = false) {
  const f = w.fields ?? {};
  const project = f["System.TeamProject"] ?? "";
  return {
    id: w.id,
    mine,
    above,
    parent: parentId(w),
    title: f["System.Title"] ?? "",
    state: f["System.State"] ?? "",
    type: f["System.WorkItemType"] ?? "",
    project,
    assignedTo: f["System.AssignedTo"]?.displayName ?? "",
    changed: f["System.ChangedDate"] ?? "",
    iteration: f["System.IterationPath"] ?? "",
    tags: String(f["System.Tags"] ?? "").split(";").map((t) => t.trim()).filter(Boolean),
    priority: f["Microsoft.VSTS.Common.Priority"] ?? null,
    url: `${orgUrl(org)}/${encodeURIComponent(project)}/_workitems/edit/${w.id}`,
  };
}

/** The list as a tree: each work item under its parent (when the parent is in the list too),
 *  rows of { it, depth, kids, open } in the order they show: the most recently changed first,
 *  a work item above yours by what's under it. Collapsed ones (ids) hide what's under them;
 *  with words, the work items they match and the ones above them, all open. */
export function rows(items, { collapsed = new Set(), words = "" } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const kids = new Map();
  const roots = [];
  for (const i of items) {
    if (i.parent != null && i.parent !== i.id && byId.has(i.parent)) {
      if (!kids.has(i.parent)) kids.set(i.parent, []);
      kids.get(i.parent).push(i);
    } else roots.push(i);
  }
  const recent = new Map(); // id -> the latest change in it and under it
  const latest = (i) => {
    if (recent.has(i.id)) return recent.get(i.id);
    recent.set(i.id, ""); // (a loop)
    const own = i.above ? "" : (i.changed ?? "");
    const r = (kids.get(i.id) ?? []).reduce((m, c) => (latest(c) > m ? latest(c) : m), own);
    recent.set(i.id, r);
    return r;
  };
  const order = (list) => [...list].sort((a, b) => (latest(b) > latest(a) ? 1 : latest(b) < latest(a) ? -1 : 0));
  const w = words.toLowerCase();
  let keep = null; // with words: the ids that show
  if (w) {
    keep = new Set();
    for (const i of items) {
      if (!i.title.toLowerCase().includes(w) && String(i.id) !== words) continue;
      for (let a = i; a && !keep.has(a.id); a = byId.get(a.parent)) keep.add(a.id);
    }
  }
  const out = [];
  const seen = new Set();
  const walk = (i, depth) => {
    if (seen.has(i.id) || (keep && !keep.has(i.id))) return;
    seen.add(i.id);
    const under = order(kids.get(i.id) ?? []).filter((c) => !keep || keep.has(c.id));
    const open = keep ? true : !collapsed.has(i.id);
    out.push({ it: i, depth, kids: under.length, open });
    if (open) for (const c of under) walk(c, depth + 1);
  };
  for (const r of order(roots)) walk(r, 0);
  return out;
}

/** A git branch name for a work item: "feature/1234-fix-the-login-redirect" */
export function branchName(it, prefix = "feature/") {
  const slug = it.title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `${prefix}${it.id}${slug ? `-${slug}` : ""}`;
}

// A work item's page, as Azure DevOps lays it out: the fields it shows where (by their
// reference names; the ones a process doesn't have are left out)
const RICH = [
  ["System.Description", "Description"], ["Microsoft.VSTS.TCM.ReproSteps", "Repro steps"],
  ["Microsoft.VSTS.TCM.SystemInfo", "System info"], ["Microsoft.VSTS.Common.AcceptanceCriteria", "Acceptance criteria"],
  ["Microsoft.VSTS.Common.Resolution", "Resolution"],
];
const PLANNING = [
  ["Microsoft.VSTS.Common.Priority", "Priority"], ["Microsoft.VSTS.Common.Severity", "Severity"],
  ["Microsoft.VSTS.Scheduling.StoryPoints", "Story points"], ["Microsoft.VSTS.Scheduling.Effort", "Effort"],
  ["Microsoft.VSTS.Scheduling.Size", "Size"], ["Microsoft.VSTS.Common.BusinessValue", "Business value"],
  ["Microsoft.VSTS.Common.TimeCriticality", "Time criticality"], ["Microsoft.VSTS.Common.ValueArea", "Value area"],
  ["Microsoft.VSTS.Common.Risk", "Risk"], ["Microsoft.VSTS.Common.Activity", "Activity"],
  ["Microsoft.VSTS.Scheduling.StartDate", "Start date"], ["Microsoft.VSTS.Scheduling.TargetDate", "Target date"],
  ["Microsoft.VSTS.Scheduling.DueDate", "Due date"], ["Microsoft.VSTS.Scheduling.FinishDate", "Finish date"],
  ["Microsoft.VSTS.Scheduling.OriginalEstimate", "Original estimate"], ["Microsoft.VSTS.Scheduling.RemainingWork", "Remaining work"],
  ["Microsoft.VSTS.Scheduling.CompletedWork", "Completed work"], ["Microsoft.VSTS.Build.FoundIn", "Found in"],
  ["Microsoft.VSTS.Build.IntegrationBuild", "Integrated in"],
];
const isHtml = (v) => typeof v === "string" && /<\/?[a-z][^>]*>/i.test(v);
/** A field's value in words: a person's name, not the person */
const value = (v) => (v && typeof v === "object" ? (v.displayName ?? v.name ?? "") : v);
/** "Custom.CustomerImpact" -> "Customer impact" */
const label = (ref) => {
  const words = ref.replace(/^Custom\./, "").replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A development link (vstfs:///Git/PullRequestId/…): what it is, and its page */
export function artifact(uri, name, org, project) {
  const m = /^vstfs:\/\/\/(\w+)\/(\w+)\/(.+)$/i.exec(uri ?? "");
  if (!m) return null;
  const [, tool, kind, rest] = m;
  const id = decodeURIComponent(rest);
  const base = orgUrl(org);
  if (tool === "Git") {
    const [proj, repo, ...more] = id.split("/");
    const tail = more.join("/");
    const git = `${base}/${proj}/_git/${repo}`;
    if (kind === "PullRequestId") return { kind: "Pull request", label: `!${tail}`, url: `${git}/pullrequest/${tail}` };
    if (kind === "Commit") return { kind: name || "Commit", label: tail.slice(0, 8), url: `${git}/commit/${tail}` };
    if (kind === "Ref" && tail.startsWith("GB")) return { kind: "Branch", label: tail.slice(2), url: `${git}?version=${encodeURIComponent(tail)}` };
  }
  if (tool === "Build" && kind === "Build") return { kind: name || "Build", label: `#${id}`, url: `${base}/${encodeURIComponent(project)}/_build/results?buildId=${id}` };
  return { kind: name || kind, label: id, url: null };
}

/** A work item (from $expand=all) as its page shows it: the fields, the rich text, its links */
export function page(w, org) {
  const f = w.fields ?? {};
  const has = (k) => f[k] != null && f[k] !== "";
  const custom = Object.keys(f).filter((k) => k.startsWith("Custom.") && has(k)).sort();
  const rels = w.relations ?? [];
  return {
    reason: f["System.Reason"] ?? "",
    area: f["System.AreaPath"] ?? "",
    createdBy: value(f["System.CreatedBy"]) ?? "",
    created: f["System.CreatedDate"] ?? "",
    changedBy: value(f["System.ChangedBy"]) ?? "",
    changed: f["System.ChangedDate"] ?? "",
    rich: [...RICH.filter(([k]) => has(k)), ...custom.filter((k) => isHtml(f[k])).map((k) => [k, label(k)])]
      .map(([k, l]) => ({ label: l, html: String(f[k]) })),
    planning: PLANNING.filter(([k]) => has(k)).map(([k, l]) => ({ label: l, value: value(f[k]) })),
    other: custom.filter((k) => !isHtml(f[k])).map((k) => ({ label: label(k), value: value(f[k]) })),
    related: rels.filter((r) => /\/workItems\/\d+$/i.test(r.url ?? ""))
      .map((r) => ({ kind: r.attributes?.name ?? r.rel, id: Number(r.url.split("/").pop()) })),
    development: rels.filter((r) => r.rel === "ArtifactLink")
      .map((r) => artifact(r.url, r.attributes?.name, org, f["System.TeamProject"] ?? "")).filter(Boolean),
    links: rels.filter((r) => r.rel === "Hyperlink").map((r) => ({ label: r.attributes?.comment || r.url, url: r.url })),
    attachments: rels.filter((r) => r.rel === "AttachedFile")
      .map((r) => ({ name: r.attributes?.name ?? "a file", size: r.attributes?.resourceSize ?? null, url: r.url })),
  };
}

/** What an HTTP answer means, in words */
export function problem(status, org) {
  if (status === 401 || status === 203) return "Azure DevOps refused the token: check it in Settings › Plugins › Azure Boards (it needs Work Items: Read)";
  if (status === 404) return `There's no organization "${org}" (or the token can't see it)`;
  return `Azure DevOps answered ${status}`;
}

/** Ids in the answer of a WIQL query (the first 200: the API reads 200 at a time) */
export const ids = (answer) => (answer?.workItems ?? []).map((w) => w.id).slice(0, 200);

/** New ids since the last look (for "a work item was assigned to you") */
export const added = (before, now) => (before ? now.filter((id) => !before.includes(id)) : []);
