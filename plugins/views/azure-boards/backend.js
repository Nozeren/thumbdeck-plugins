// The Azure Boards backend: asks Azure DevOps for your work items (with the token in the
// plugin's settings) and the ones under and above them, looks again every few minutes, says how
// many are open (the Plugins pane's status), tells you what changed on yours (assigned to you,
// a state, new comments; not your own changes), knows each project's current sprint, and makes
// the changes the view asks for. Organization "demo": sample work items (testdata/), changed in
// memory only.
import { readFileSync } from "node:fs";
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../../packages/backend/index.js";
import {
  auth, changes, commentHtml, current, gather, ids, isMe, item, orgUrl, page, patch, problem, snapshot, text, wiql, within,
} from "./ado.js";

const demoFile = (f) => JSON.parse(readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8"));
const DEMO_ME = "me@example.test";
let demo = null; // { items, comments, iterations }: the sample, as changed in memory
let settings = {
  organization: "", token: "", show: "assigned", projects: [], hidden_states: ["Closed", "Done", "Removed"], refresh_minutes: 5,
  branch_prefix: "feature/", team: "", notify_assigned: true, notify_state: true, notify_comments: true,
};
let items = [];
let error = "";
let updated = null;
let me = ""; // your uniqueName (an email), for "not your own changes"
let sprints = {}; // project -> its current iteration's path (null: none)
let sprintOnly = false; // only the current sprint's (kept in storage)
const iterationsOf = new Map(); // project -> the team's iterations

const isDemo = () => settings.organization.trim() === "demo";

async function ado(path, init = {}, o = {}) {
  const res = await answer(`${orgUrl(settings.organization)}${path}`, init, o);
  return res.json();
}

/** Asks Azure DevOps (only: the token goes nowhere else). writing: a change (its refusals say so) */
async function answer(url, init = {}, { writing = false } = {}) {
  if (!url.startsWith(`${orgUrl(settings.organization)}/`)) throw new Error("not your organization's");
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: auth(settings.token), "Content-Type": "application/json", Accept: "application/json", ...init.headers },
    redirect: "manual", // a refused token redirects to a sign-in page
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const message = await res.json().then((b) => b?.message ?? "", () => "");
    throw new Error(problem(res.status >= 300 && res.status < 400 ? 401 : res.status, settings.organization, { writing, message }));
  }
  return res;
}

/** Work items by id, with their relations: 200 at a time; errorPolicy=omit: one the token can't
 *  see is left out instead of failing them all */
async function workItems(want) {
  if (isDemo()) return demo.items.filter((w) => want.includes(w.id));
  const got = [];
  for (let i = 0; i < want.length; i += 200) {
    const a = await ado(`/_apis/wit/workitems?ids=${want.slice(i, i + 200).join(",")}&$expand=relations&errorPolicy=omit&api-version=7.1`);
    got.push(...(a.value ?? []).filter(Boolean));
  }
  return got;
}

/** The ids of the query (the sample: the ones assigned to you, open, recently changed first) */
async function query(s) {
  if (!isDemo()) return ids(await ado("/_apis/wit/wiql?api-version=7.1", { method: "POST", body: JSON.stringify({ query: wiql(s) }) }));
  return demo.items.filter((w) => isMe(w.fields["System.AssignedTo"]?.uniqueName, DEMO_ME) && !(s.hidden_states ?? []).includes(w.fields["System.State"]))
    .sort((a, b) => (b.fields["System.ChangedDate"] > a.fields["System.ChangedDate"] ? 1 : -1)).map((w) => w.id);
}

/** A project's iterations, for its team (Settings' team, or the project's default team) */
async function iterations(project) {
  if (isDemo()) return demo.iterations;
  const team = settings.team.trim() ? `/${encodeURIComponent(settings.team.trim())}` : "";
  return (await ado(`/${encodeURIComponent(project)}${team}/_apis/work/teamsettings/iterations?api-version=7.1`)).value ?? [];
}

async function load(tb) {
  const org = settings.organization.trim();
  try {
    if (!org) throw new Error("Set your organization and a token in Settings (,) › Plugins › Azure Boards");
    if (!isDemo() && !settings.token.trim()) throw new Error("Add a personal access token in Settings (,) › Plugins › Azure Boards");
    if (!me) me = isDemo() ? DEMO_ME : await ado("/_apis/connectionData").then((c) => c.authenticatedUser?.properties?.Account?.$value ?? "", () => "");
    const list = await query(settings);
    const found = (list.length ? await gather(list, workItems, { hidden: settings.hidden_states ?? [] }) : []).map(({ w, mine, above }) => item(w, org, mine, above));
    // Each project's current sprint (a team that can't be read: none)
    const projects = [...new Set(found.filter((i) => !i.above).map((i) => i.project))];
    sprints = {};
    await Promise.all(projects.map(async (p) => {
      try {
        iterationsOf.set(p, await iterations(p));
        sprints[p] = current(iterationsOf.get(p));
      } catch {
        sprints[p] = null;
      }
    }));
    for (const i of found) i.sprint = within(i.iteration, sprints[i.project]);
    // Recently changed first (the query's order)
    found.sort((a, b) => (b.changed > a.changed ? 1 : b.changed < a.changed ? -1 : 0));
    // What the notifications watch: yours, and the ones assigned to you when the list shows others
    let watched = found.filter((i) => i.mine);
    if (settings.show !== "assigned" && !isDemo()) {
      const assigned = (await query({ ...settings, show: "assigned" })).filter((id) => !found.some((i) => i.id === id));
      watched = watched.concat((assigned.length ? await workItems(assigned) : []).map((w) => item(w, org)));
    }
    await tell(tb, watched);
    items = found;
    error = "";
  } catch (e) {
    error = e.message;
  }
  updated = Date.now();
  const mine = items.filter((i) => i.mine && (!sprintOnly || i.sprint)).length;
  tb.status(error ? "!" : `${mine} open`);
  tb.event("updated", { updated });
}

/** Notifications: what changed on the watched work items since the last look (kept in
 *  storage, so what changed while thumbdeck was closed is told too); many at once: one */
async function tell(tb, watched) {
  const key = `${settings.organization.trim().toLowerCase()} ${settings.show}`;
  const kept = await tb.storage.get("seen").catch(() => undefined);
  const before = kept?.key === key ? kept.items : null;
  const since = kept?.at ?? ""; // the last look: only comments after it are news
  const said = [];
  for (const c of changes(before, watched, me)) {
    const it = watched.find((i) => i.id === c.id);
    const name = `${it.type} ${it.id}`;
    if (c.kind === "assigned" && settings.notify_assigned) said.push([`${name} is yours`, it.title]);
    if (c.kind === "state" && settings.notify_state) said.push([`${name}: ${c.from} → ${c.to}`, it.title]);
    if (c.kind === "comments" && settings.notify_comments) {
      const latest = (await comments(it).catch(() => [])).filter((x) => x.createdDate > since && !isMe(x.createdBy?.uniqueName, me));
      if (latest.length) said.push([`${latest.length > 1 ? `${latest.length} comments` : "A comment"} on ${name}`, `${latest[0].createdBy?.displayName ?? ""}: ${text(latest[0].text).slice(0, 160)}`]);
    }
  }
  if (said.length > 4) tb.notify(`${said.length} changes on your work items`, said.map(([t]) => t).join(" · "));
  else for (const [title, body] of said) tb.notify(title, body);
  await tb.storage.set("seen", { key, at: new Date().toISOString(), items: snapshot(watched) }).catch(() => {});
}

/** A work item's comments, newest first */
async function comments(it) {
  if (isDemo()) return [...(demo.comments[it.id] ?? [])].reverse();
  return (await ado(`/${encodeURIComponent(it.project)}/_apis/wit/workItems/${it.id}/comments?$top=50&order=desc&api-version=7.1-preview.4`)).comments ?? [];
}

let timer = null;
function schedule(tb) {
  clearInterval(timer);
  timer = setInterval(() => load(tb), Math.max(1, settings.refresh_minutes) * 60_000);
}

function start() {
  me = "";
  iterationsOf.clear();
  demo = isDemo() ? { items: demoFile("workitems.json").value, comments: demoFile("comments.json"), iterations: demoFile("iterations.json").value } : null;
}

const known = (id) => {
  const it = items.find((i) => i.id === id);
  if (!it) throw new Error(`no work item ${id}: look again (r)`);
  return it;
};

serve({
  async initialize(info, tb) {
    settings = { ...settings, ...info.settings };
    sprintOnly = (await tb.storage.get("sprintOnly").catch(() => false)) === true;
    start();
    load(tb);
    schedule(tb);
  },
  settings(s, tb) {
    settings = { ...settings, ...s };
    start();
    load(tb);
    schedule(tb);
  },
  list: () => ({ items, error, updated, branchPrefix: settings.branch_prefix, me, sprints, sprintOnly }),
  async refresh(_p, tb) {
    await load(tb);
    return { error };
  },
  /** Only the current sprint's, or every iteration's (remembered) */
  async sprint({ on }, tb) {
    sprintOnly = !!on;
    await tb.storage.set("sprintOnly", sprintOnly).catch(() => {});
    tb.status(error ? "!" : `${items.filter((i) => i.mine && (!sprintOnly || i.sprint)).length} open`);
    return { sprintOnly };
  },
  /** A work item's page: its fields, rich text, links (the related work items with their
   *  titles) and discussion, newest first */
  async detail({ id }) {
    const org = settings.organization.trim();
    const w = isDemo() ? demo.items.find((x) => x.id === id) : await ado(`/_apis/wit/workitems/${id}?$expand=all&api-version=7.1`);
    if (!w) throw new Error(`no work item ${id}`);
    const p = page(w, org);
    const all = new Map(items.map((i) => [i.id, i]));
    const missing = [...new Set(p.related.map((r) => r.id))].filter((x) => !all.has(x));
    if (missing.length) {
      try {
        for (const x of await workItems(missing.slice(0, 200))) all.set(x.id, item(x, org, false));
      } catch {} // without their titles
    }
    p.related = p.related.map((r) => {
      const it = all.get(r.id);
      return { ...r, title: it?.title ?? "", type: it?.type ?? "", state: it?.state ?? "", url: it?.url ?? `${orgUrl(org)}/_workitems/edit/${r.id}` };
    });
    const project = w.fields?.["System.TeamProject"] ?? "";
    p.comments = (await comments({ id, project }).catch(() => [])) // comments are extra: the rest still shows
      .filter((c) => !c.isDeleted)
      .map((c) => ({ by: c.createdBy?.displayName ?? "", at: c.createdDate ?? "", html: c.text ?? "" }))
      .sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
    return p;
  },
  /** What a field can be changed to: state (the type's states), iteration (the team's), assignee
   *  (you and the people in the list) */
  async options({ id, field }) {
    const it = known(id);
    if (field === "state") {
      if (isDemo()) return ["New", "Active", "Resolved", "Closed"].map((name) => ({ value: name, label: name }));
      const states = (await ado(`/${encodeURIComponent(it.project)}/_apis/wit/workitemtypes/${encodeURIComponent(it.type)}/states?api-version=7.1`)).value ?? [];
      return states.map((s) => ({ value: s.name, label: s.name, note: s.category }));
    }
    if (field === "iteration") {
      const all = iterationsOf.get(it.project) ?? (await iterations(it.project));
      const order = { current: 0, future: 1, past: 2 };
      return [...all].sort((a, b) => (order[a.attributes?.timeFrame] ?? 3) - (order[b.attributes?.timeFrame] ?? 3))
        .map((t) => ({ value: t.path, label: t.name, note: t.attributes?.timeFrame === "current" ? "current" : t.path }));
    }
    if (field === "assignee") {
      const people = new Map();
      if (me) people.set(me.toLowerCase(), { value: me, label: "Me", note: me });
      for (const i of items) if (i.assignee && !people.has(i.assignee.toLowerCase())) people.set(i.assignee.toLowerCase(), { value: i.assignee, label: i.assignedTo, note: i.assignee });
      return [...people.values(), { value: "", label: "Unassigned" }];
    }
    throw new Error(`no options for ${field}`);
  },
  /** Changes a work item: { id, set: { state | assignee | title | tags | priority | iteration } } */
  async change({ id, set }, tb) {
    const it = known(id);
    const ops = patch(set, it.rev);
    if (isDemo()) changeDemo(id, set);
    else await ado(`/_apis/wit/workitems/${id}?api-version=7.1`, { method: "PATCH", body: JSON.stringify(ops), headers: { "Content-Type": "application/json-patch+json" } }, { writing: true });
    await load(tb);
    return { error };
  },
  /** Adds a comment (what was typed, as plain text) */
  async comment({ id, text: typed }, tb) {
    const it = known(id);
    if (!String(typed ?? "").trim()) throw new Error("an empty comment");
    if (isDemo()) {
      (demo.comments[id] ??= []).push({ text: commentHtml(typed), createdBy: { displayName: "Me", uniqueName: DEMO_ME }, createdDate: new Date().toISOString() });
      changeDemo(id, {}, { comments: 1 });
    } else {
      await ado(`/${encodeURIComponent(it.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`,
        { method: "POST", body: JSON.stringify({ text: commentHtml(typed) }) }, { writing: true });
    }
    await load(tb);
    return { error };
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

/** A change to the sample work items, in memory, as Azure DevOps would make it */
function changeDemo(id, set, { comments: more = 0 } = {}) {
  const w = demo.items.find((x) => x.id === id);
  const f = w.fields;
  for (const op of patch(set, null)) {
    const key = op.path.replace("/fields/", "");
    f[key] = key === "System.AssignedTo" ? (op.value ? { displayName: op.value === DEMO_ME ? "Me" : op.value, uniqueName: op.value } : undefined) : op.value;
  }
  f["System.CommentCount"] = (f["System.CommentCount"] ?? 0) + more;
  f["System.ChangedBy"] = { displayName: "Me", uniqueName: DEMO_ME };
  f["System.ChangedDate"] = new Date().toISOString();
  w.rev = (w.rev ?? 1) + 1;
}
