// Azure Boards (Azure DevOps work items): the queries, reading the answers, and small helpers.
// Pure functions, tested with `node --test` (ado.test.js); backend.js does the asking.

const FIELDS = [
  "System.Id", "System.Title", "System.State", "System.WorkItemType", "System.TeamProject",
  "System.AssignedTo", "System.ChangedDate", "System.IterationPath", "System.Tags",
  "Microsoft.VSTS.Common.Priority",
];
export const FIELD_LIST = FIELDS.join(",");

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

/** A work item from the API as the view shows it */
export function item(w, org) {
  const f = w.fields ?? {};
  const project = f["System.TeamProject"] ?? "";
  return {
    id: w.id,
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
