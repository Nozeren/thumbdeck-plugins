// The Azure Boards backend: asks Azure DevOps for your work items (with the token in the
// plugin's settings) and the ones under and above them, looks again every few minutes, says how
// many are open (the Plugins pane's status), tells you what changed on yours (assigned to you,
// a state, new comments; not your own changes), knows each project's current sprint, makes
// the changes the view asks for, and counts the hours you logged, day by day (hours.js). Organization "demo": sample work items (testdata/), changed in
// memory only.
import { readFileSync } from "node:fs";
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../../packages/backend/index.js";
import {
  auth, changes, commentHtml, current, fieldSettings, gather, history, ids, isMe, item, orgUrl, page, patch, problem, snapshot, text, wiql, within,
} from "./ado.js";
import { HOURS_FIELD, fieldUse, hoursWiql, logged } from "./hours.js";
import { richHtml } from "./markdown.js";

const demoFile = (f) => JSON.parse(readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8"));
const DEMO_ME = "me@example.test";
let demo = null; // { items, comments, iterations, fields, updates }: the sample, as changed in memory
let settings = {
  organization: "", token: "", show: "assigned", projects: [], hidden_states: ["Closed", "Done", "Removed"], refresh_minutes: 5,
  branch_prefix: "feature/", team: "", notify_assigned: true, notify_state: true, notify_comments: true, fields: [],
  hours_field: "", hours_unit: "hours", hours_per_day: 8,
};
// How many it shows: yours (the most recently changed), and with what's under and above them
const MAX_MINE = 1000;
const MAX_ALL = 3000;
let items = [];
let note = ""; // what it couldn't show, said at the top of the view
let error = "";
let updated = null;
let me = ""; // your uniqueName (an email), for "not your own changes"
let sprints = {}; // project -> its current iteration's path (null: none)
let sprintOnly = false; // only the current sprint's (kept in storage)
const iterationsOf = new Map(); // project -> the team's iterations
let types = null; // the organization's fields: ref (lowercase) -> { name, type } (once a start)
const logs = new Map(); // id -> { rev, field, scale, entries: [{ at, hours }] }: what you logged on it, at that revision
const MAX_LOGGED = 400; // work items looked into for the hours, the most recently changed

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
    // Azure DevOps' own message (its JSON answers have one; "no such organization" is plain text),
    // and whether it knows the organization (a refused token there says which tenant it's in)
    const message = await res.json().then((b) => b?.message ?? "", () => "");
    const known = res.headers.has("x-vss-resourcetenant");
    throw new Error(problem(res.status, settings.organization, { writing, message, known }));
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

/** The organization's fields (names and types, for how its own fields show); none: guessed */
async function fieldTypes() {
  if (!types) {
    const all = isDemo() ? demo.fields : await ado("/_apis/wit/fields?api-version=7.1").then((a) => a.value ?? [], () => null);
    if (!all) return new Map(); // asked again next time
    types = new Map(all.map((x) => [x.referenceName.toLowerCase(), { name: x.name, type: x.type }]));
  }
  return types;
}

/** A project's iterations, for its team (Settings' team, or the project's default team) */
async function iterations(project) {
  if (isDemo()) return demo.iterations;
  const team = settings.team.trim() ? `/${encodeURIComponent(settings.team.trim())}` : "";
  return (await ado(`/${encodeURIComponent(project)}${team}/_apis/work/teamsettings/iterations?api-version=7.1`)).value ?? [];
}

// One look at a time: one asked for meanwhile waits, then runs once after it (two at once would
// both tell what changed, from the same last look)
let looking = null;
let again = false;
function load(tb) {
  if (looking) {
    again = true;
    return looking;
  }
  looking = (async () => {
    do {
      again = false;
      await look(tb);
    } while (again);
  })().finally(() => (looking = null));
  return looking;
}

/** Who you are (your uniqueName: an email), once */
async function whoAmI() {
  if (!me) me = isDemo() ? DEMO_ME : await ado("/_apis/connectionData").then((c) => c.authenticatedUser?.properties?.Account?.$value ?? "", () => "");
  return me;
}

/** Runs work on each thing, a few at a time */
async function each(things, work, at = 6) {
  const queue = [...things];
  await Promise.all(Array.from({ length: at }, async () => {
    while (queue.length) await work(queue.shift());
  }));
}

async function look(tb) {
  const org = settings.organization.trim();
  try {
    if (!org) throw new Error("Set your organization and a token in Settings (,) › Plugins › Azure Boards");
    if (!isDemo() && !settings.token.trim()) throw new Error("Add a personal access token in Settings (,) › Plugins › Azure Boards");
    await whoAmI();
    const all = await query(settings);
    const list = all.slice(0, MAX_MINE);
    const found = (list.length ? await gather(list, workItems, { hidden: settings.hidden_states ?? [], limit: MAX_ALL }) : []).map(({ w, mine, above }) => item(w, org, mine, above));
    note = [
      all.length > list.length && `Showing the ${list.length} most recently changed of your ${all.length} work items: leave out more states or projects in Settings to see the rest`,
      found.length >= MAX_ALL && `Some of the work items under and above yours aren't shown (over ${MAX_ALL})`,
    ].filter(Boolean).join(" · ");
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
      const assigned = (await query({ ...settings, show: "assigned" })).slice(0, MAX_MINE).filter((id) => !found.some((i) => i.id === id));
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
  // The ones that left the list since (closed, given to someone else…): once more, to tell why
  const gone = before ? Object.keys(before).map(Number).filter((id) => !watched.some((i) => i.id === id)) : [];
  const left = gone.length ? (await workItems(gone.slice(0, 200)).catch(() => [])).map((w) => item(w, settings.organization.trim(), false)) : [];
  const all = [...watched, ...left];
  const said = [];
  for (const c of changes(before, all, me)) {
    const it = all.find((i) => i.id === c.id);
    const name = `${it.type} ${it.id}`;
    const by = it.changedByName ? ` (by ${it.changedByName})` : "";
    if (c.kind === "assigned" && settings.notify_assigned) said.push([`${name} is yours`, it.title]);
    if (c.kind === "unassigned" && settings.notify_assigned) said.push([`${name} ${c.to ? `was reassigned to ${c.to}` : "was unassigned"}`, `${it.title}${by}`]);
    if (c.kind === "state" && settings.notify_state) said.push([`${name}: ${c.from} → ${c.to}`, `${it.title}${by}`]);
    if (c.kind === "comments" && settings.notify_comments) {
      const latest = (await comments(it).catch(() => [])).filter((x) => x.createdDate > since && !isMe(x.createdBy?.uniqueName, me));
      if (latest.length) said.push([`${latest.length > 1 ? `${latest.length} comments` : "A comment"} on ${name}`, `${latest[0].createdBy?.displayName ?? ""}: ${text(latest[0].text).slice(0, 160)}`]);
    }
  }
  if (said.length > 4) tb.notify(`${said.length} changes on your work items`, said.map(([t]) => t).join(" · "));
  else for (const [title, body] of said) tb.notify(title, body);
  await tb.storage.set("seen", { key, at: new Date().toISOString(), items: snapshot(watched) }).catch(() => {});
}

/** A work item's revisions (what changed in each), oldest first: 200 at a time, up to 1000 */
async function updates(id) {
  if (isDemo()) return demo.updates[id] ?? [];
  const all = [];
  for (let skip = 0; skip < 1000; skip += 200) {
    const page = (await ado(`/_apis/wit/workItems/${id}/updates?$top=200&$skip=${skip}&api-version=7.1`)).value ?? [];
    all.push(...page);
    if (page.length < 200) break;
  }
  return all;
}

/** A work item's comments, newest first */
async function comments(it) {
  if (isDemo()) return [...(demo.comments[it.id] ?? [])].reverse();
  return (await ado(`/${encodeURIComponent(it.project)}/_apis/wit/workItems/${it.id}/comments?$top=50&order=desc&$expand=renderedText&api-version=7.1-preview.4`)).comments ?? [];
}

let timer = null;
function schedule(tb) {
  clearInterval(timer);
  timer = setInterval(() => load(tb), Math.max(1, settings.refresh_minutes) * 60_000);
}

function start() {
  me = "";
  logs.clear();
  types = null;
  iterationsOf.clear();
  demo = isDemo()
    ? {
      items: demoFile("workitems.json").value, comments: demoFile("comments.json"), iterations: demoFile("iterations.json").value,
      fields: demoFile("fields.json").value, updates: demoFile("updates.json"),
    }
    : null;
  if (demo) demoHours();
}

/** The hours in one of the hours field's units: 1, or a working day's in days */
const hoursIn = () => (settings.hours_unit === "days" ? Number(settings.hours_per_day) || 8 : 1);

/** The sample's logged hours: most working days of the last two months, on a few work items (in
 *  the unit of the settings, as an organization would keep them) */
function demoHours() {
  const unit = hoursIn();
  const on = [4175, 4211, 3990, 4202];
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const done = new Map();
  const today = new Date();
  for (let back = 60; back >= 0; back--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 9);
    if (day.getDay() === 0 || day.getDay() === 6 || random() < 0.1) continue;
    let left = back === 0 ? 3 : 5 + Math.round(random() * 7) / 2; // 5 to 8.5
    for (let n = 0; left > 0 && n < 3; n++) {
      const id = on[Math.floor(random() * on.length)];
      const hours = n === 2 ? left : Math.min(left, 1 + Math.round(random() * 8) / 2);
      const was = done.get(id) ?? 0;
      done.set(id, was + hours);
      day.setHours(day.getHours() + Math.ceil(hours));
      (demo.updates[id] ??= []).push({
        rev: 100 + (demo.updates[id]?.length ?? 0), revisedBy: { displayName: "Me", uniqueName: DEMO_ME }, revisedDate: "9999-01-01T00:00:00Z",
        fields: { "System.ChangedDate": { newValue: day.toISOString() }, [HOURS_FIELD]: { oldValue: was ? was / unit : undefined, newValue: (was + hours) / unit } },
      });
      left -= hours;
    }
  }
  for (const w of demo.items) if (done.has(w.id)) w.fields[HOURS_FIELD] = done.get(w.id) / unit;
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
  list: () => ({ org: settings.organization.trim().toLowerCase(), items, error, note, warning: fieldSettings(settings.fields).problems.join(" · "), updated, branchPrefix: settings.branch_prefix, me, sprints, sprintOnly }),
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
  /** The hours you logged on work items changed since a day (YYYY-MM-DD): { entries: [{ at,
   *  hours, id, type, title, state, url }], perDay, note, error } (what's looked into stays known
   *  until it changes) */
  async hours({ since }) {
    const org = settings.organization.trim();
    const field = String(settings.hours_field ?? "").trim() || HOURS_FIELD;
    const perDay = Number(settings.hours_per_day) || 8;
    try {
      if (!/^\d{4}-\d\d-\d\d$/.test(String(since))) throw new Error("since: a day, YYYY-MM-DD");
      if (!org || (!isDemo() && !settings.token.trim())) throw new Error("Set your organization and a token in Settings (,) › Plugins › Azure Boards");
      await whoAmI();
      if (!me) throw new Error("Azure DevOps didn't say who you are, so your hours can't be told from others'");
      const scale = hoursIn();
      // A field of the organization's own: a number, or text with one (which can't be compared with 0)
      let compare = true;
      if (field.toLowerCase() !== HOURS_FIELD.toLowerCase()) {
        const known = await fieldTypes();
        const f = known.get(field.toLowerCase());
        if (known.size && !f) throw new Error(`There's no field ${field} in your organization: check the Hours field setting (its reference name, e.g. Custom.HoursSpent)`);
        if (f && !fieldUse(f.type)) throw new Error(`The Hours field ${field} (${f.name}) is a ${f.type} field: hours need a number field, or a text one with the number in it`);
        compare = !f || fieldUse(f.type) === "number";
      }
      let found;
      let note = "";
      if (isDemo()) found = demo.items;
      else {
        const ask = (compare) => ado("/_apis/wit/wiql?api-version=7.1", { method: "POST", body: JSON.stringify({ query: hoursWiql({ field, since, projects: settings.projects ?? [], compare }) }) });
        // A type it couldn't know (the fields unread): a text field's refusal (TF212023), asked again without the comparison
        const all = ids(await ask(compare).catch((e) => (compare && /TF212023/.test(e.message) ? ask(false) : Promise.reject(e))));
        if (all.length > MAX_LOGGED) note = `Only the ${MAX_LOGGED} most recently changed work items are counted: older days may miss some hours`;
        found = await workItems(all.slice(0, MAX_LOGGED));
      }
      const stale = (k, w) => !k || k.rev !== w.rev || k.field !== field || k.scale !== scale;
      await each(found.filter((w) => stale(logs.get(w.id), w)), async (w) => {
        logs.set(w.id, { rev: w.rev, field, scale, entries: logged(await updates(w.id), me, field, scale) });
      });
      const entries = found.flatMap((w) => {
        const it = item(w, org);
        return (logs.get(w.id)?.entries ?? []).map((e) => ({ ...e, id: it.id, type: it.type, title: it.title, state: it.state, url: it.url }));
      });
      return { entries, perDay, note, error: "" };
    } catch (e) {
      return { entries: [], perDay, note: "", error: e.message };
    }
  },
  /** A work item's page: its fields, rich text, links (the related work items with their
   *  titles) and discussion, newest first */
  async detail({ id }) {
    const org = settings.organization.trim();
    const w = isDemo() ? demo.items.find((x) => x.id === id) : await ado(`/_apis/wit/workitems/${id}?$expand=all&api-version=7.1`);
    if (!w) throw new Error(`no work item ${id}`);
    const p = page(w, org, { types: await fieldTypes(), custom: fieldSettings(settings.fields).fields });
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
      .map((c) => {
        // A Markdown comment (format "markdown", or 0): Azure DevOps' own rendering, or ours
        const md = /^markdown$/i.test(String(c.format)) || c.format === 0;
        const html = md && c.renderedText ? c.renderedText : richHtml(c.text, { format: md ? "markdown" : "", workItem: (x) => `${orgUrl(org)}/_workitems/edit/${x}` });
        return { by: c.createdBy?.displayName ?? "", byId: c.createdBy?.uniqueName ?? "", at: c.createdDate ?? "", html };
      })
      .sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
    p.history = history(await updates(id).catch(() => [])); // history is extra too
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
      (demo.comments[id] ??= []).push({ text: commentHtml(typed, "demo"), createdBy: { displayName: "Me", uniqueName: DEMO_ME }, createdDate: new Date().toISOString() });
      changeDemo(id, {}, { comments: 1 });
    } else {
      await ado(`/${encodeURIComponent(it.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`,
        { method: "POST", body: JSON.stringify({ text: commentHtml(typed, settings.organization) }) }, { writing: true });
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
  const now = new Date().toISOString();
  const changed = { "System.ChangedDate": { oldValue: f["System.ChangedDate"], newValue: now } };
  for (const op of patch(set, null)) {
    const key = op.path.replace("/fields/", "");
    const was = f[key];
    f[key] = key === "System.AssignedTo" ? (op.value ? { displayName: op.value === DEMO_ME ? "Me" : op.value, uniqueName: op.value } : undefined) : op.value;
    changed[key] = { oldValue: was, newValue: f[key] };
  }
  if (Object.keys(set).length) {
    const list = (demo.updates[id] ??= []);
    list.push({ rev: list.length + 1, revisedBy: { displayName: "Me", uniqueName: DEMO_ME }, revisedDate: "9999-01-01T00:00:00Z", fields: changed });
  }
  f["System.CommentCount"] = (f["System.CommentCount"] ?? 0) + more;
  f["System.ChangedBy"] = { displayName: "Me", uniqueName: DEMO_ME };
  f["System.ChangedDate"] = new Date().toISOString();
  w.rev = (w.rev ?? 1) + 1;
}
