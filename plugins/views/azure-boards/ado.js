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

/** Your work items (the ids of the query) and everything under them, yours or not: asks for
 *  a level at a time (fetch(ids) gives the work items, with their relations). Ones under yours
 *  in a hidden state are left out, and what's under them. [{ w, mine }], yours first. */
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
  return [...found.values()];
}

/** A work item from the API as the view shows it (mine: one of the query's, not only under one) */
export function item(w, org, mine = true) {
  const f = w.fields ?? {};
  const project = f["System.TeamProject"] ?? "";
  return {
    id: w.id,
    mine,
    parent: f["System.Parent"] ?? linked(w, PARENT)[0] ?? null,
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
 *  rows of { it, depth, kids, open } in the order they show. Collapsed ones (ids) hide what's
 *  under them; with words, the work items they match and the ones above them, all open. */
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
    const under = (kids.get(i.id) ?? []).filter((c) => !keep || keep.has(c.id));
    const open = keep ? true : !collapsed.has(i.id);
    out.push({ it: i, depth, kids: under.length, open });
    if (open) for (const c of under) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
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

/** HTML (descriptions, comments) as plain text */
export function text(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
