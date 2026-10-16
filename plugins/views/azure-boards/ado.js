// Azure Boards (Azure DevOps work items): the queries, reading the answers, and small helpers.
// Pure functions, tested with `node --test` (ado.test.js); backend.js does the asking.
import { markdown, richHtml } from "./markdown.js";

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
    assignee: f["System.AssignedTo"]?.uniqueName ?? "", // for "is it mine" and assigning
    changedBy: f["System.ChangedBy"]?.uniqueName ?? "",
    rev: w.rev ?? null,
    comments: f["System.CommentCount"] ?? 0,
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
/** "Custom.CustomerImpact", "Contoso.Customer_Impact" -> "Customer impact" */
const label = (ref) => {
  const words = ref.replace(/^[^.]*\./, "").replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

// Your organization's own fields (any not Azure DevOps' own: Custom.*, Contoso.*…) show by
// themselves, as their type says; the Fields setting changes how, or shows one of Azure
// DevOps' own: "reference name | label | format | where", each part but the first optional.
export const FORMATS = ["text", "markdown", "html", "date", "number", "person", "yes-no", "link"];
export const SECTIONS = ["main", "planning", "details", "hidden"];
const ownField = (ref) => !/^(System|Microsoft)\.|^WEF_/i.test(ref);
// A field's type (from /_apis/wit/fields) -> how it shows
const TYPES = { html: "html", plaintext: "markdown", datetime: "date", boolean: "yes-no", identity: "person", integer: "number", double: "number" };

/** The Fields setting's lines: ref (lowercase) -> { label, format, where }, and what's wrong */
export function fieldSettings(lines) {
  const fields = new Map();
  const problems = [];
  for (const line of lines ?? []) {
    if (!String(line).trim() || String(line).trim().startsWith("#")) continue;
    const [ref, label = "", format = "", where = ""] = String(line).split("|").map((x) => x.trim());
    const f = format.toLowerCase();
    const w = where.toLowerCase();
    if (!/^[\w.]+$/.test(ref)) problems.push(`"${line}": start with the field's reference name (like Custom.Impact)`);
    else if (f && f !== "hidden" && !FORMATS.includes(f)) problems.push(`${ref}: no format "${format}" (${FORMATS.join(", ")})`);
    else if (w && !SECTIONS.includes(w)) problems.push(`${ref}: nowhere called "${where}" (${SECTIONS.join(", ")})`);
    else fields.set(ref.toLowerCase(), { label, format: f === "hidden" ? "" : f, where: f === "hidden" ? "hidden" : w, order: fields.size });
  }
  return { fields, problems };
}

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

/** A work item (from $expand=all) as its page shows it: the fields, the rich text (as HTML,
 *  Markdown rendered), its links. types: ref (lowercase) -> { name, type } (/_apis/wit/fields);
 *  custom: the Fields setting (fieldSettings) */
export function page(w, org, { types = new Map(), custom = new Map() } = {}) {
  const f = w.fields ?? {};
  const has = (k) => f[k] != null && f[k] !== "";
  const rels = w.relations ?? [];
  const workItem = (id) => `${orgUrl(org)}/_workitems/edit/${id}`;
  const markdownField = (k) => Object.entries(w.multilineFieldsFormat ?? {}).some(([ref, fmt]) => ref.toLowerCase() === k.toLowerCase() && /^markdown$/i.test(fmt));
  // Every field it shows: where, as what, called what
  const known = new Map([...RICH.map(([k, l]) => [k.toLowerCase(), { label: l, where: "main" }]), ...PLANNING.map(([k, l]) => [k.toLowerCase(), { label: l, where: "planning" }])]);
  const shown = [];
  for (const k of Object.keys(f)) {
    if (!has(k)) continue;
    const c = custom.get(k.toLowerCase());
    const builtIn = known.get(k.toLowerCase());
    if (!c && !builtIn && !ownField(k)) continue;
    const type = types.get(k.toLowerCase());
    let format = c?.format || (markdownField(k) ? "markdown" : TYPES[String(type?.type).toLowerCase()]) || (isHtml(f[k]) ? "html" : "text");
    if (f[k] && typeof f[k] === "object" && format === "text") format = "person";
    const where = c?.where || builtIn?.where || (format === "html" || format === "markdown" ? "main" : "details");
    if (where === "hidden") continue;
    shown.push({ k, label: c?.label || builtIn?.label || type?.name || label(k), format, where, order: c ? c.order : builtIn ? -1 : 1e6 });
  }
  // Azure DevOps' own in the order its page has them, then the setting's in its order, then the rest by name
  const builtInOrder = [...RICH, ...PLANNING].map(([k]) => k.toLowerCase());
  const rank = (x) => (x.order === -1 ? [0, builtInOrder.indexOf(x.k.toLowerCase())] : x.order < 1e6 ? [1, x.order] : [2, 0]);
  shown.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1] || a.label.localeCompare(b.label));
  const rich = (x) => (x.format === "markdown" || x.format === "html"
    ? richHtml(f[x.k], { format: x.format === "markdown" ? "markdown" : "", workItem })
    : `<p>${String(display(f[x.k], x.format)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`);
  const scalar = (x) => ({ label: x.label, value: display(f[x.k], x.format), format: x.format, ref: x.k });
  const isRich = (x) => x.format === "markdown" || x.format === "html";
  return {
    reason: f["System.Reason"] ?? "",
    area: f["System.AreaPath"] ?? "",
    createdBy: value(f["System.CreatedBy"]) ?? "",
    created: f["System.CreatedDate"] ?? "",
    changedBy: value(f["System.ChangedBy"]) ?? "",
    changed: f["System.ChangedDate"] ?? "",
    rich: shown.filter((x) => x.where === "main").map((x) => ({ label: x.label, html: rich(x) })),
    planning: shown.filter((x) => x.where === "planning").map((x) => (isRich(x) ? { label: x.label, value: text(f[x.k]), format: "text" } : scalar(x))),
    other: shown.filter((x) => x.where === "details").map((x) => (isRich(x) ? { label: x.label, value: text(f[x.k]), format: "text" } : scalar(x))),
    related: rels.filter((r) => /\/workItems\/\d+$/i.test(r.url ?? ""))
      .map((r) => ({ kind: r.attributes?.name ?? r.rel, id: Number(r.url.split("/").pop()) })),
    development: rels.filter((r) => r.rel === "ArtifactLink")
      .map((r) => artifact(r.url, r.attributes?.name, org, f["System.TeamProject"] ?? "")).filter(Boolean),
    links: rels.filter((r) => r.rel === "Hyperlink").map((r) => ({ label: r.attributes?.comment || r.url, url: r.url })),
    attachments: rels.filter((r) => r.rel === "AttachedFile")
      .map((r) => ({ name: r.attributes?.name ?? "a file", size: r.attributes?.resourceSize ?? null, url: r.url })),
  };
}

// What the history (/updates) tells, field by field: the rest of its edits are left out
const TRACKED = {
  "System.State": "state", "System.AssignedTo": "assignee", "System.IterationPath": "iteration", "System.AreaPath": "area",
  "System.Title": "title", "Microsoft.VSTS.Common.Priority": "priority", "System.Tags": "tags",
};

/** A work item's history (its /updates, oldest first) as events: { at, by, byId, kind, from, to }.
 *  kind: created, state, assignee, iteration, area, title, priority, tags, parent, development */
export function history(updates) {
  const out = [];
  for (const u of updates ?? []) {
    const f = u.fields ?? {};
    const revised = String(u.revisedDate ?? "");
    const at = f["System.ChangedDate"]?.newValue ?? (revised.startsWith("9999") ? "" : revised);
    const who = { at, by: u.revisedBy?.displayName?.replace(/\s*<[^>]*>$/, "") ?? "", byId: u.revisedBy?.uniqueName ?? "" };
    if (u.rev === 1) {
      out.push({ ...who, kind: "created", from: "", to: value(f["System.State"]?.newValue) ?? "" });
      continue;
    }
    for (const [ref, kind] of Object.entries(TRACKED)) {
      if (f[ref]) out.push({ ...who, kind, from: value(f[ref].oldValue) ?? "", to: value(f[ref].newValue) ?? "" });
    }
    const id = (r) => Number(String(r.url).split("/").pop());
    for (const r of u.relations?.added ?? []) {
      if (r.rel === PARENT) out.push({ ...who, kind: "parent", from: "", to: id(r) });
      if (r.rel === "ArtifactLink") out.push({ ...who, kind: "development", from: "", to: r.attributes?.name ?? "a link" });
    }
    for (const r of u.relations?.removed ?? []) if (r.rel === PARENT) out.push({ ...who, kind: "parent", from: id(r), to: "" });
  }
  return out;
}

/** A field's value in words, as its format says */
function display(v, format) {
  if (format === "person") return value(v) ?? "";
  if (format === "yes-no") return v === true || /^(true|yes|1)$/i.test(String(v)) ? "Yes" : "No";
  if (format === "number") return Number.isFinite(Number(v)) ? Number(v) : String(v);
  return typeof v === "object" ? (value(v) ?? "") : v;
}

/** What an HTTP answer means, in words (writing: a change was asked; message: Azure DevOps' own) */
export function problem(status, org, { writing = false, message = "" } = {}) {
  if (writing && (status === 401 || status === 403 || status === 203)) return "Azure DevOps refused the change: the token needs Work Items: Read & write (Settings › Plugins › Azure Boards)";
  if (status === 401 || status === 203) return "Azure DevOps refused the token: check it in Settings › Plugins › Azure Boards (it needs Work Items: Read)";
  if (writing && (status === 409 || /\brev\b|TF26071|TF237082/i.test(message))) return "Someone changed it meanwhile: look again (r) and redo it";
  if (status === 404) return `There's no organization "${org}" (or the token can't see it)`;
  return message ? `Azure DevOps: ${message}` : `Azure DevOps answered ${status}`;
}

/** HTML (comments) as plain text, for a notification */
export function text(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Changing a work item: the fields that can be changed from here
export const FIELDS = {
  state: "System.State", assignee: "System.AssignedTo", title: "System.Title", tags: "System.Tags",
  priority: "Microsoft.VSTS.Common.Priority", iteration: "System.IterationPath",
};

/** The JSON Patch for a change ({ state: "Resolved" }, …): refused by Azure DevOps if the work
 *  item changed since rev (someone else's change isn't undone) */
export function patch(set, rev) {
  const ops = rev == null ? [] : [{ op: "test", path: "/rev", value: rev }];
  for (const [k, v] of Object.entries(set)) {
    if (!FIELDS[k]) throw new Error(`${k} can't be changed from here`);
    ops.push({ op: "add", path: `/fields/${FIELDS[k]}`, value: k === "priority" ? Number(v) : k === "tags" ? [].concat(v).join("; ") : v });
  }
  return ops;
}

/** A comment as Azure DevOps keeps them (HTML), from what was typed (Markdown) */
export const commentHtml = (typed, org) => markdown(String(typed).trim(), org ? { workItem: (id) => `${orgUrl(org)}/_workitems/edit/${id}` } : {});

/** Is this you (an identity from Azure DevOps: uniqueName, an email)? */
export const isMe = (who, me) => !!who && !!me && String(who).toLowerCase() === String(me).toLowerCase();

/** What the notifications compare: id -> what matters of each of your work items */
export const snapshot = (items) =>
  Object.fromEntries(items.map((i) => [i.id, { state: i.state, assignee: i.assignee, comments: i.comments, title: i.title, type: i.type }]));

/** What changed on your work items since the last look, not by you: [{ id, kind, … }] (kind:
 *  assigned, state, comments). before: null on the very first look (nothing is news). */
export function changes(before, items, me) {
  if (!before) return [];
  const out = [];
  for (const i of items) {
    const was = before[i.id];
    if (isMe(i.assignee, me) && !isMe(was?.assignee, me) && !isMe(i.changedBy, me)) out.push({ id: i.id, kind: "assigned" });
    if (!was) continue;
    if (was.state !== i.state && !isMe(i.changedBy, me)) out.push({ id: i.id, kind: "state", from: was.state, to: i.state });
    if (i.comments > was.comments) out.push({ id: i.id, kind: "comments", count: i.comments - was.comments });
  }
  return out;
}

/** The iteration a team is in now (from teamsettings/iterations): its path, or null */
export const current = (iterations) => (iterations ?? []).find((t) => t.attributes?.timeFrame === "current")?.path ?? null;

/** In an iteration (the path, or one under it) */
export const within = (iteration, path) => !!path && (iteration === path || String(iteration).startsWith(`${path}\\`));

/** Only the current sprint's work items (sprint: true, set by the backend), and what they're
 *  under (for where they belong) */
export function sprintOnly(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const keep = new Set(items.filter((i) => !i.above && i.sprint).map((i) => i.id));
  for (const id of [...keep]) {
    for (let a = byId.get(byId.get(id).parent), n = 0; a && a.above && n < 50; a = byId.get(a.parent), n++) keep.add(a.id);
  }
  return items.filter((i) => keep.has(i.id));
}

/** Ids in the answer of a WIQL query (the first 200: the API reads 200 at a time) */
export const ids = (answer) => (answer?.workItems ?? []).map((w) => w.id).slice(0, 200);
