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
  MENTIONED_WIQL, areaPaths, auth, changes, commentHtml, createOps, creatable, current, fieldPatch, fieldSettings, fieldValue, gather, history, ids, isMe, isTask,
  item, mentions, orgUrl, page, patch, pickerPeople, problem, searchWiql, snapshot, taskType, text, typedFields, wiql, within,
} from "./ado.js";
import {
  HOURS_FIELD, activitiesIn, applyLog, entries as logEntries, fieldUse, hoursSetting, hoursWiql, logRows, logValue, logged, loggedLog, notHours, notLog,
} from "./hours.js";
import { markdown, richHtml } from "./markdown.js";

const demoFile = (f) => JSON.parse(readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8"));
const DEMO_ME = "me@example.test";
// The sample's people (anyone in the organization, for the people search and @mentions)
const DEMO_PEOPLE = [
  ["Me", DEMO_ME], ["Ann", "ann@example.test"], ["Bob", "bob@example.test"], ["Carol", "carol@example.test"], ["Dana", "dana@example.test"],
  ["Erik Lund", "erik.lund@example.test"], ["Femi Adeyemi", "femi@example.test"], ["Grace Ho", "grace.ho@example.test"],
].map(([name, email]) => ({ value: email, label: name, note: email, id: `demo-${email.split("@")[0]}` }));
const demoPerson = (email) => DEMO_PEOPLE.find((p) => p.value === email);
// Azure DevOps' own fields the sample's types have (besides testdata/fields.json), for typing them
const DEMO_BUILT_IN = [
  ["System.Description", "Description", "html"], ["System.AreaPath", "Area Path", "treePath"], ["Microsoft.VSTS.Common.AcceptanceCriteria", "Acceptance Criteria", "html"],
  ["Microsoft.VSTS.TCM.ReproSteps", "Repro Steps", "html"], ["Microsoft.VSTS.Scheduling.RemainingWork", "Remaining Work", "double"],
  ["Microsoft.VSTS.Scheduling.OriginalEstimate", "Original Estimate", "double"], ["Microsoft.VSTS.Scheduling.CompletedWork", "Completed Work", "double"],
  ["Microsoft.VSTS.Scheduling.StoryPoints", "Story Points", "double"], ["Microsoft.VSTS.Scheduling.Effort", "Effort", "double"],
  ["Microsoft.VSTS.Common.Severity", "Severity", "string", ["1 - Critical", "2 - High", "3 - Medium", "4 - Low"]],
  ["Microsoft.VSTS.Scheduling.DueDate", "Due Date", "dateTime"],
];
let demo = null; // { items, comments, iterations, fields, updates, worklog }: the sample, as changed in memory
let settings = {
  organization: "", token: "", show: "assigned", projects: [], hidden_states: ["Closed", "Done", "Removed"], refresh_minutes: 5,
  branch_prefix: "feature/", team: "", notify_assigned: true, notify_state: true, notify_comments: true, notify_mentions: true, fields: [],
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
let myId = ""; // your identity's id, for the @mentions of you
let sprints = {}; // project -> its current iteration's path (null: none)
let sprintOnly = false; // only the current sprint's (kept in storage)
const iterationsOf = new Map(); // project -> the team's iterations
let types = null; // the organization's fields: ref (lowercase) -> { name, type, readOnly } (once a start)
const typeFieldsOf = new Map(); // "project/type" -> its fields (with their allowed values)
const categoriesOf = new Map(); // project -> its work item type categories
const areasOf = new Map(); // project -> its area paths
const logs = new Map(); // id -> { rev, how, scale, entries: [{ at, hours }] }: what you logged on it, at that revision (how: the Hours field setting)
const MAX_LOGGED = 400; // work items looked into for the hours, the most recently changed
const activities = new Set(); // the activities in the work logs read (for a new entry's)
const MAX_FOUND = 50; // a search's

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
    types = new Map(all.map((x) => [x.referenceName.toLowerCase(), { name: x.name, type: x.type, readOnly: !!x.readOnly }]));
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

/** Who you are (your uniqueName: an email, and your identity's id), once */
async function whoAmI() {
  if (me) return me;
  if (isDemo()) [me, myId] = [DEMO_ME, demoPerson(DEMO_ME).id];
  else {
    const c = await ado("/_apis/connectionData").catch(() => null);
    me = c?.authenticatedUser?.properties?.Account?.$value ?? "";
    myId = c?.authenticatedUser?.id ?? "";
  }
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
      const mention = settings.notify_mentions && latest.find((x) => mentions(x, myId));
      if (mention) said.push([`${mention.createdBy?.displayName ?? "Someone"} mentioned you on ${name}`, `${it.title}: ${text(mention.text).slice(0, 160)}`]);
      else if (latest.length) said.push([`${latest.length > 1 ? `${latest.length} comments` : "A comment"} on ${name}`, `${latest[0].createdBy?.displayName ?? ""}: ${text(latest[0].text).slice(0, 160)}`]);
    }
  }
  said.push(...(await mentioned(tb, settings.notify_comments ? new Set(watched.map((i) => i.id)) : new Set()).catch(() => [])));
  if (said.length > 4) tb.notify(`${said.length} changes on your work items`, said.map(([t]) => t).join(" · "));
  else for (const [title, body] of said) tb.notify(title, body);
  await tb.storage.set("seen", { key, at: new Date().toISOString(), items: snapshot(watched) }).catch(() => {});
}

/** The @mentions of you since the last look, on work items that aren't yours (yours: told
 *  with their comments, in tell); those work items' comment counts kept in storage, so only
 *  ones with new comments are read. [[title, body]] */
async function mentioned(tb, told) {
  if (!settings.notify_mentions || isDemo() || !myId) return [];
  const key = settings.organization.trim().toLowerCase();
  const kept = await tb.storage.get("mentioned").catch(() => undefined);
  const before = kept?.key === key ? kept : null;
  const want = ids(await ado("/_apis/wit/wiql?$top=100&api-version=7.1", { method: "POST", body: JSON.stringify({ query: MENTIONED_WIQL }) })).slice(0, 100);
  const found = want.length ? await workItems(want) : [];
  const counts = Object.fromEntries(found.map((w) => [w.id, w.fields?.["System.CommentCount"] ?? 0]));
  const said = [];
  if (before) {
    for (const w of found) {
      if (told.has(w.id) || counts[w.id] <= (before.counts?.[w.id] ?? 0)) continue;
      const it = item(w, settings.organization.trim(), false);
      const latest = (await comments(it).catch(() => [])).filter((c) => c.createdDate > before.at && !isMe(c.createdBy?.uniqueName, me) && mentions(c, myId));
      if (latest.length) said.push([`${latest[0].createdBy?.displayName ?? "Someone"} mentioned you on ${it.type} ${it.id}`, `${it.title}: ${text(latest[0].text).slice(0, 160)}`]);
    }
  }
  await tb.storage.set("mentioned", { key, at: new Date().toISOString(), counts }).catch(() => {});
  return said;
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
  myId = "";
  logs.clear();
  activities.clear();
  types = null;
  iterationsOf.clear();
  typeFieldsOf.clear();
  categoriesOf.clear();
  areasOf.clear();
  demo = isDemo()
    ? {
      items: demoFile("workitems.json").value, comments: demoFile("comments.json"), iterations: demoFile("iterations.json").value,
      fields: demoFile("fields.json").value, updates: demoFile("updates.json"), worklog: demoFile("worklog.json"),
    }
    : null;
  if (demo) {
    demoHours();
    // Its people have ids (for @mentions), as Azure DevOps' do
    const withId = (who) => who && typeof who === "object" && who.uniqueName && (who.id ??= demoPerson(who.uniqueName)?.id);
    for (const w of demo.items) for (const v of Object.values(w.fields)) withId(v);
    let n = 0;
    for (const list of Object.values(demo.comments)) {
      for (const c of list) {
        c.id ??= ++n;
        c.createdBy.uniqueName ??= DEMO_PEOPLE.find((p) => p.label === c.createdBy.displayName)?.value;
        withId(c.createdBy);
      }
    }
  }
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
  demoLog();
}

/** The sample's work log (testdata/worklog.json), its days moved so the last is today: each
 *  revision the whole list, kept as an html field keeps it (quotes as &quot;) */
function demoLog() {
  const { field, revisions } = demo.worklog;
  const last = Object.values(revisions).flat().map((r) => r.at.slice(0, 10)).sort().at(-1);
  const today = new Date();
  const shift = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
  const moved = (iso) => new Date(Date.parse(iso) + shift * 86_400_000).toISOString();
  const html = (list) => JSON.stringify(list.map((e) => ({ ...e, startDate: moved(e.startDate), endDate: moved(e.endDate) }))).replace(/"/g, "&quot;");
  for (const [id, revs] of Object.entries(revisions)) {
    let was;
    for (const r of revs) {
      const now = html(r.value);
      (demo.updates[id] ??= []).push({
        rev: 200 + demo.updates[id].length, revisedBy: { displayName: r.by === DEMO_ME ? "Me" : "Ann", uniqueName: r.by }, revisedDate: "9999-01-01T00:00:00Z",
        fields: { "System.ChangedDate": { newValue: moved(r.at) }, [field]: { oldValue: was, newValue: now } },
      });
      was = now;
    }
    const w = demo.items.find((x) => x.id === Number(id));
    if (w) w.fields[field] = was;
  }
}

/** A work item: the list's, or (one that isn't in it: closed, someone else's…) asked for by id */
async function known(id) {
  const it = items.find((i) => i.id === id);
  if (it) return it;
  const [w] = await workItems([Number(id)]);
  if (!w) throw new Error(`There's no work item ${id}, or the token can't see it`);
  return item(w, settings.organization.trim(), isMe(w.fields?.["System.AssignedTo"]?.uniqueName, me));
}

/** The work log setting ({ field, log }), or why it isn't one */
function workLog() {
  const s = hoursSetting(settings.hours_field);
  if (s.problem) throw new Error(s.problem);
  if (!s.log) throw new Error("The Hours field isn't a work log: set it in Settings › Plugins › Azure Boards (e.g. Custom.WorkLogData | date: startDate | amount: daysSpent)");
  return s;
}

/** A work log's entries, and its activities remembered */
function readLog(v, log) {
  const list = logEntries(v);
  for (const a of activitiesIn(list ?? [], log)) activities.add(a);
  return list;
}

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
  list: () => ({ org: settings.organization.trim().toLowerCase(), orgUrl: settings.organization.trim() ? orgUrl(settings.organization) : "", items, error, note, warning: fieldSettings(settings.fields).problems.join(" · "), updated, branchPrefix: settings.branch_prefix, me, myId, sprints, sprintOnly }),
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
    const how = String(settings.hours_field ?? "").trim();
    const { field, log, problem } = hoursSetting(how);
    const perDay = Number(settings.hours_per_day) || 8;
    try {
      if (!/^\d{4}-\d\d-\d\d$/.test(String(since))) throw new Error("since: a day, YYYY-MM-DD");
      if (!org || (!isDemo() && !settings.token.trim())) throw new Error("Set your organization and a token in Settings (,) › Plugins › Azure Boards");
      await whoAmI();
      if (!me) throw new Error("Azure DevOps didn't say who you are, so your hours can't be told from others'");
      if (problem) throw new Error(problem);
      const scale = hoursIn();
      // A field of the organization's own: a number, or text with one (which can't be compared with 0)
      let compare = true;
      if (field.toLowerCase() !== HOURS_FIELD.toLowerCase()) {
        const known = await fieldTypes();
        const f = known.get(field.toLowerCase());
        if (known.size && !f) throw new Error(`There's no field ${field} in your organization: check the Hours field setting (its reference name, e.g. Custom.HoursSpent)`);
        if (f && !fieldUse(f.type)) throw new Error(`The Hours field ${field} (${f.name}) is a ${f.type} field: hours need a number field, or a text one with just the number in it`);
        if (log && f && fieldUse(f.type) !== "text") throw new Error(`The Hours field ${field} (${f.name}) is a ${f.type} field: a work log is kept in a text one`);
        compare = !log && (!f || fieldUse(f.type) === "number");
      }
      let found;
      let note = "";
      if (isDemo()) found = demo.items;
      else {
        const ask = (compare) => ado("/_apis/wit/wiql?api-version=7.1", { method: "POST", body: JSON.stringify({ query: hoursWiql({ field, since, projects: settings.projects ?? [], compare, log: !!log }) }) });
        // A type it couldn't know (the fields unread): a text field's refusal (TF212023), asked again without the comparison
        const all = ids(await ask(compare).catch((e) => (compare && /TF212023/.test(e.message) ? ask(false) : Promise.reject(e))));
        if (all.length > MAX_LOGGED) note = `Only the ${MAX_LOGGED} most recently changed work items are counted: older days may miss some hours`;
        found = await workItems(all.slice(0, MAX_LOGGED));
      }
      // The first value says if the field holds hours (a work log: the first with entries, or
      // the first value if none is a JSON list), before any history is read
      const values = found.map((w) => w.fields?.[field]).filter((v) => v != null && String(v).trim() !== "");
      if (log) for (const v of values) readLog(v, log);
      const why = !values.length ? ""
        : log ? notLog(values.find((v) => logEntries(v)?.length) ?? (values.some((v) => logEntries(v)) ? "[]" : values[0]), field, log)
        : notHours(values[0], field);
      if (why) throw new Error(why);
      const count = (u) => (log ? loggedLog(u, me, field, log, scale) : logged(u, me, field, scale));
      const stale = (k, w) => !k || k.rev !== w.rev || k.how !== how || k.scale !== scale;
      await each(found.filter((w) => stale(logs.get(w.id), w)), async (w) => {
        logs.set(w.id, { rev: w.rev, how, scale, entries: count(await updates(w.id)) });
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
    if (!w) throw new Error(`There's no work item ${id}, or the token can't see it`);
    const { field, log } = hoursSetting(settings.hours_field);
    const p = page(w, org, { types: await fieldTypes(), custom: fieldSettings(settings.fields).fields, skip: log ? [field] : [] });
    await whoAmI();
    p.item = item(w, org, isMe(w.fields?.["System.AssignedTo"]?.uniqueName, me)); // for one that isn't in the list
    if (log) {
      // The work log as a table (its raw JSON isn't for reading)
      const list = readLog(w.fields?.[field], log);
      const scale = hoursIn();
      const rows = list ? logRows(list, log, scale) : [];
      p.worklog = {
        field, rows, total: Math.round(rows.reduce((n, r) => n + r.hours, 0) * 100) / 100, activity: !!log.activity, activities: [...activities].sort(),
        error: list ? "" : notLog(w.fields?.[field], field, log),
      };
    }
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
        // Yours can be changed and taken back (with what was written, to edit it)
        const mine = isMe(c.createdBy?.uniqueName, me);
        return {
          id: c.id ?? null, by: c.createdBy?.displayName ?? "", byId: c.createdBy?.uniqueName ?? "", byUid: c.createdBy?.id ?? "", at: c.createdDate ?? "", html,
          edited: !!c.modifiedDate && c.modifiedDate !== c.createdDate && (Date.parse(c.modifiedDate) - Date.parse(c.createdDate) > 5000),
          mine, source: mine ? (c.text ?? "") : undefined, markdown: md,
        };
      })
      .sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : 0));
    p.history = history(await updates(id).catch(() => [])); // history is extra too
    // The people on it (with their ids), for @mentioning them
    const people = new Map();
    const add = (who) => who?.uniqueName && who.id && !people.has(who.uniqueName.toLowerCase()) && people.set(who.uniqueName.toLowerCase(), { value: who.uniqueName, label: who.displayName || who.uniqueName, note: who.uniqueName, id: who.id });
    for (const v of Object.values(w.fields ?? {})) if (v && typeof v === "object") add(v);
    for (const c of p.comments) add({ uniqueName: c.byId, displayName: c.by, id: c.byUid });
    p.people = [...people.values()];
    // Its rich text as written (for editing it as Markdown)
    const md = new Set(Object.entries(w.multilineFieldsFormat ?? {}).filter(([, f]) => /^markdown$/i.test(f)).map(([k]) => k.toLowerCase()));
    p.rich = p.rich.map((r) => ({ ...r, source: w.fields?.[r.ref] ?? "", markdown: md.has(r.ref.toLowerCase()) }));
    p.item.rev = w.rev ?? p.item.rev;
    return p;
  },
  /** What a field can be changed to: state (the type's states), iteration (the team's), assignee
   *  (you and the people in the list) */
  async options({ id, field }) {
    const it = await known(id);
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
      if (me) people.set(me.toLowerCase(), { value: me, label: "Me", note: me, id: myId });
      for (const i of items) if (i.assignee && !people.has(i.assignee.toLowerCase())) people.set(i.assignee.toLowerCase(), { value: i.assignee, label: i.assignedTo, note: i.assignee, id: i.assigneeId });
      return [...people.values(), { value: "", label: "Unassigned" }];
    }
    if (field === "type") return (await kinds(it.project)).map((t) => ({ value: t, label: t }));
    if (field === "area") return (await areas(it.project)).map((a) => ({ value: a, label: a.split("\\").pop(), note: a }));
    throw new Error(`no options for ${field}`);
  },
  /** Changes a work item: { id, set: { state | assignee | title | tags | priority | iteration } } */
  async change({ id, set }, tb) {
    const it = await known(id);
    const ops = patch(set, it.rev);
    if (isDemo()) changeDemo(id, set);
    else await ado(`/_apis/wit/workitems/${id}?api-version=7.1`, { method: "PATCH", body: JSON.stringify(ops), headers: { "Content-Type": "application/json-patch+json" } }, { writing: true });
    await load(tb);
    return { error };
  },
  /** Adds a comment (what was typed, as Markdown; mentions: the people picked for @Name) */
  async comment({ id, text: typed, mentions: people = [] }, tb) {
    const it = await known(id);
    if (!String(typed ?? "").trim()) throw new Error("an empty comment");
    const html = commentHtml(typed, isDemo() ? "demo" : settings.organization, people);
    if (isDemo()) {
      const list = (demo.comments[id] ??= []);
      const now = new Date().toISOString();
      list.push({ id: Math.max(0, ...Object.values(demo.comments).flat().map((c) => c.id ?? 0)) + 1, text: html, createdBy: { displayName: "Me", uniqueName: DEMO_ME, id: myId }, createdDate: now, modifiedDate: now });
      changeDemo(id, {}, { comments: 1 });
    } else {
      await ado(`/${encodeURIComponent(it.project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`,
        { method: "POST", body: JSON.stringify({ text: html }) }, { writing: true });
    }
    await load(tb);
    return { error };
  },
  /** Changes one of your comments: { id, comment (its id), text (Markdown), mentions, markdown
   *  (it's a Markdown comment: kept as one) } */
  async editComment({ id, comment, text: typed, mentions: people = [], markdown: md = false }) {
    const it = await known(id);
    if (!String(typed ?? "").trim()) throw new Error("an empty comment: take it back instead (dd)");
    const body = md ? String(typed).trim() : commentHtml(typed, isDemo() ? "demo" : settings.organization, people);
    if (isDemo()) {
      const c = (demo.comments[id] ?? []).find((x) => x.id === comment);
      if (!c || !isMe(c.createdBy?.uniqueName, DEMO_ME)) throw new Error("only your own comments can be changed");
      Object.assign(c, { text: body, modifiedDate: new Date().toISOString() });
    } else {
      await ado(`/${encodeURIComponent(it.project)}/_apis/wit/workItems/${id}/comments/${Number(comment)}?api-version=7.1-preview.4`,
        { method: "PATCH", body: JSON.stringify({ text: body }) }, { writing: true });
    }
    return { error: "" };
  },
  /** Takes back one of your comments */
  async deleteComment({ id, comment }, tb) {
    const it = await known(id);
    if (isDemo()) {
      const list = demo.comments[id] ?? [];
      const at = list.findIndex((x) => x.id === comment);
      if (at < 0 || !isMe(list[at].createdBy?.uniqueName, DEMO_ME)) throw new Error("only your own comments can be taken back");
      list.splice(at, 1);
      changeDemo(id, {}, { comments: -1 });
    } else {
      await ado(`/${encodeURIComponent(it.project)}/_apis/wit/workItems/${id}/comments/${Number(comment)}?api-version=7.1-preview.4`, { method: "DELETE" }, { writing: true });
    }
    await load(tb);
    return { error };
  },
  /** People in the organization whose name or email has what was typed (Azure DevOps' people
   *  picker): { people: [{ value: email, label, note, id }], error } */
  async people({ text: typed }) {
    const t = String(typed ?? "").trim();
    if (t.length < 2) return { people: [], error: "" };
    if (isDemo()) return { people: DEMO_PEOPLE.filter((p) => `${p.label} ${p.value}`.toLowerCase().includes(t.toLowerCase())), error: "" };
    try {
      const a = await ado("/_apis/IdentityPicker/Identities?api-version=7.1-preview.1", {
        method: "POST",
        body: JSON.stringify({
          query: t, identityTypes: ["user"], operationScopes: ["ims", "source"], options: { MinResults: 5, MaxResults: 20 },
          properties: ["DisplayName", "Mail", "SignInAddress", "SubjectDescriptor"],
        }),
      });
      return { people: pickerPeople(a), error: "" };
    } catch (e) {
      return { people: [], error: e.message };
    }
  },
  /** Makes a work item: { parent (an id; none: on its own, in project), type (none: a task), title }.
   *  It's yours, in the current sprint (the team's; none found: the parent's iteration), in the
   *  parent's area. { id, type, error } */
  async create({ parent = null, type = "", title, project = "" }, tb) {
    const t = String(title ?? "").trim();
    if (!t) throw new Error("a work item needs a title");
    const org = settings.organization.trim();
    await whoAmI();
    const up = parent != null ? await known(Number(parent)) : null;
    const proj = up?.project || project;
    if (!proj) throw new Error("which project? Highlight a work item of it first");
    const kind = type || taskType(await categories(proj));
    if (!(proj in sprints)) sprints[proj] = await iterations(proj).then((all) => (iterationsOf.set(proj, all), current(all)), () => null);
    const iteration = sprints[proj] || up?.iteration || "";
    const ops = createOps({ title: t, assignee: me, iteration, area: up?.area ?? "", parent: up?.id ?? null, org });
    let made;
    if (isDemo()) made = createDemo(proj, kind, ops, up);
    else {
      made = await ado(`/${encodeURIComponent(proj)}/_apis/wit/workitems/${encodeURIComponent(`$${kind}`)}?api-version=7.1`,
        { method: "POST", body: JSON.stringify(ops), headers: { "Content-Type": "application/json-patch+json" } }, { writing: true });
    }
    await load(tb);
    return { id: made.id, type: kind, iteration, error };
  },
  /** The fields of a work item that can be typed here (its type's, but the ones with a key of
   *  their own), with their values: { rev, fields: [{ ref, name, kind, value, allowed, required,
   *  help, markdown }] } */
  async fields({ id }) {
    const w = isDemo() ? demo.items.find((x) => x.id === id) : await ado(`/_apis/wit/workitems/${id}?api-version=7.1`);
    if (!w) throw new Error(`There's no work item ${id}, or the token can't see it`);
    const project = w.fields?.["System.TeamProject"] ?? "";
    const type = w.fields?.["System.WorkItemType"] ?? "";
    const known = new Map(await fieldTypes());
    let of;
    if (isDemo()) {
      for (const [ref, name, t] of DEMO_BUILT_IN) if (!known.has(ref.toLowerCase())) known.set(ref.toLowerCase(), { name, type: t });
      of = [...DEMO_BUILT_IN.map(([referenceName, name, , allowedValues]) => ({ referenceName, name, allowedValues })),
        ...demo.fields.filter((f) => !DEMO_BUILT_IN.some(([r]) => r === f.referenceName)).map((f) => ({ referenceName: f.referenceName, name: f.name }))];
    } else {
      const key = `${project}/${type}`;
      if (!typeFieldsOf.has(key)) typeFieldsOf.set(key, (await ado(`/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/fields?$expand=allowedValues&api-version=7.1`)).value ?? []);
      of = typeFieldsOf.get(key);
    }
    const md = Object.entries(w.multilineFieldsFormat ?? {}).filter(([, f]) => /^markdown$/i.test(f)).map(([k]) => k);
    return { rev: w.rev ?? null, project, fields: typedFields(of, known, w.fields ?? {}, { markdown: md }) };
  },
  /** Sets one field: { id, ref, kind, value (as typed; null or "": empty it), had (it had a
   *  value), rev, markdown (keep it as Markdown), mentions (in rich text: the people picked
   *  for @Name) }. Rich text (html) is typed as Markdown and written as HTML; refused if the
   *  work item changed since rev */
  async setField({ id, ref, kind, value: typed, had = true, rev = null, markdown: md = false, mentions: people = [] }, tb) {
    if (!/^[\w.]+$/.test(String(ref))) throw new Error("which field?");
    const { value, problem: wrong } = fieldValue(kind, typed);
    if (wrong) throw new Error(`${ref}: ${wrong}`);
    const org = settings.organization.trim();
    const written = value != null && kind === "html" && !md ? markdown(value, { workItem: (x) => `${orgUrl(org)}/_workitems/edit/${x}`, mentions: people }) : value;
    const ops = fieldPatch(ref, written, { rev, had, markdown: md });
    if (!ops.length) return { error: "" };
    if (isDemo()) changeDemo(id, {}, { fields: { [ref]: written ?? undefined } });
    else await ado(`/_apis/wit/workitems/${id}?api-version=7.1`, { method: "PATCH", body: JSON.stringify(ops), headers: { "Content-Type": "application/json-patch+json" } }, { writing: true });
    await load(tb);
    return { error };
  },
  /** A search, as Azure DevOps' own: a number, that work item; words, the work items whose
   *  title has them all, any state, anyone's, in the projects of the settings (up to 50, the
   *  most recently changed first). { items, error } */
  async search({ text: typed }) {
    const org = settings.organization.trim();
    try {
      const q = searchWiql(typed, settings.projects ?? []);
      if (!q) return { items: [], error: "" };
      let found;
      if (isDemo()) {
        const t = String(typed).trim().replace(/^#/, "");
        const words = t.toLowerCase().split(/\s+/).filter(Boolean);
        const projects = (settings.projects ?? []).filter(Boolean);
        found = demo.items.filter((w) => (/^\d+$/.test(t) ? w.id === Number(t)
          : words.every((x) => String(w.fields["System.Title"]).toLowerCase().includes(x)) && (!projects.length || projects.includes(w.fields["System.TeamProject"]))))
          .sort((a, b) => (b.fields["System.ChangedDate"] > a.fields["System.ChangedDate"] ? 1 : -1)).slice(0, MAX_FOUND);
      } else {
        const want = ids(await ado(`/_apis/wit/wiql?$top=${MAX_FOUND}&api-version=7.1`, { method: "POST", body: JSON.stringify({ query: q }) })).slice(0, MAX_FOUND);
        const got = want.length ? await workItems(want) : [];
        found = want.map((x) => got.find((w) => w.id === x)).filter(Boolean); // the query's order
      }
      await whoAmI();
      return { items: found.map((w) => item(w, org, isMe(w.fields?.["System.AssignedTo"]?.uniqueName, me))), error: "" };
    } catch (e) {
      return { items: [], error: e.message };
    }
  },
  /** Logs time in a work item's work log (the Hours field setting's): { id, change: { add: { day,
   *  hours, activity } } | { change: n, to, was } | { remove: n, was } } (hours.js applyLog). Its
   *  list read now, changed, and written back whole, in the form it was read; refused if the work
   *  item changed meanwhile. Only that field */
  async logTime({ id, change: what }, tb) {
    const { field, log } = workLog();
    const w = isDemo() ? demo.items.find((x) => x.id === id) : await ado(`/_apis/wit/workitems/${id}?fields=${encodeURIComponent(field)},System.Rev&api-version=7.1`);
    if (!w) throw new Error(`There's no work item ${id}, or the token can't see it`);
    const raw = w.fields?.[field];
    const list = readLog(raw, log);
    if (list === null) throw new Error(notLog(raw, field, log));
    const next = applyLog(list, what ?? {}, log, hoursIn());
    const html = String((await fieldTypes()).get(field.toLowerCase())?.type ?? "").toLowerCase() === "html";
    const value = logValue(raw, next, { html });
    if (isDemo()) changeDemo(id, {}, { fields: { [field]: value } });
    else {
      const ops = [{ op: "test", path: "/rev", value: w.rev }, { op: "add", path: `/fields/${field}`, value }];
      await ado(`/_apis/wit/workitems/${id}?api-version=7.1`, { method: "PATCH", body: JSON.stringify(ops), headers: { "Content-Type": "application/json-patch+json" } }, { writing: true });
    }
    logs.delete(id); // the calendar reads it again
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

/** A project's work item type categories (once) */
async function categories(project) {
  if (isDemo()) return [];
  if (!categoriesOf.has(project)) categoriesOf.set(project, (await ado(`/${encodeURIComponent(project)}/_apis/wit/workitemtypecategories?api-version=7.1`)).value ?? []);
  return categoriesOf.get(project);
}

/** The types a work item can be made as in a project */
async function kinds(project) {
  if (isDemo()) return ["Task", "Bug", "User Story", "Feature", "Epic"];
  const all = (await ado(`/${encodeURIComponent(project)}/_apis/wit/workitemtypes?api-version=7.1`)).value ?? [];
  const made = creatable(all, await categories(project));
  const task = taskType(await categories(project));
  return [...made.filter((t) => isTask(t, task)), ...made.filter((t) => !isTask(t, task))]; // a task first
}

/** A project's area paths (once) */
async function areas(project) {
  if (isDemo()) return ["Shop", "Shop\\Accounts", "Shop\\Checkout", "Shop\\Search", "Backoffice", "Backoffice\\Reports"].filter((a) => a.split("\\")[0] === project);
  if (!areasOf.has(project)) areasOf.set(project, areaPaths(await ado(`/${encodeURIComponent(project)}/_apis/wit/classificationnodes/Areas?$depth=10&api-version=7.1`)));
  return areasOf.get(project);
}

/** A new sample work item, in memory (its parent's relations and children too) */
function createDemo(project, type, ops, up) {
  const id = Math.max(...demo.items.map((w) => w.id)) + 1;
  const now = new Date().toISOString();
  const fields = { "System.Id": id, "System.WorkItemType": type, "System.TeamProject": project, "System.State": "New", "System.Reason": "New",
    "System.CreatedBy": { displayName: "Me", uniqueName: DEMO_ME, id: myId }, "System.CreatedDate": now, "System.ChangedDate": now,
    "System.ChangedBy": { displayName: "Me", uniqueName: DEMO_ME, id: myId }, "System.CommentCount": 0 };
  const relations = [];
  for (const op of ops) {
    if (op.path === "/relations/-") relations.push({ ...op.value, attributes: { name: "Parent" } });
    else {
      const key = op.path.replace("/fields/", "");
      fields[key] = key === "System.AssignedTo" ? { ...(demoPerson(op.value) ?? {}), displayName: op.value === DEMO_ME ? "Me" : op.value, uniqueName: op.value } : op.value;
    }
  }
  if (up) {
    fields["System.Parent"] = up.id;
    const parent = demo.items.find((w) => w.id === up.id);
    (parent.relations ??= []).push({ rel: "System.LinkTypes.Hierarchy-Forward", url: `https://dev.azure.com/contoso/_apis/wit/workItems/${id}`, attributes: { name: "Child" } });
  }
  demo.items.push({ id, rev: 1, fields, relations });
  demo.updates[id] = [{ rev: 1, revisedBy: { displayName: "Me", uniqueName: DEMO_ME }, revisedDate: "9999-01-01T00:00:00Z", fields: { "System.State": { newValue: "New" }, "System.ChangedDate": { newValue: now } } }];
  return { id };
}

/** A change to the sample work items, in memory, as Azure DevOps would make it */
function changeDemo(id, set, { comments: more = 0, fields = {} } = {}) {
  const w = demo.items.find((x) => x.id === id);
  const f = w.fields;
  const now = new Date().toISOString();
  const changed = { "System.ChangedDate": { oldValue: f["System.ChangedDate"], newValue: now } };
  for (const op of [...patch(set, null), ...Object.entries(fields).map(([k, value]) => ({ path: `/fields/${k}`, value }))]) {
    const key = op.path.replace("/fields/", "");
    const was = f[key];
    f[key] = key === "System.AssignedTo" ? (op.value ? { displayName: op.value === DEMO_ME ? "Me" : op.value, uniqueName: op.value } : undefined) : op.value;
    changed[key] = { oldValue: was, newValue: f[key] };
  }
  if (Object.keys(set).length || Object.keys(fields).length) {
    const list = (demo.updates[id] ??= []);
    list.push({ rev: list.length + 1, revisedBy: { displayName: "Me", uniqueName: DEMO_ME }, revisedDate: "9999-01-01T00:00:00Z", fields: changed });
  }
  f["System.CommentCount"] = (f["System.CommentCount"] ?? 0) + more;
  f["System.ChangedBy"] = { displayName: "Me", uniqueName: DEMO_ME };
  f["System.ChangedDate"] = new Date().toISOString();
  w.rev = (w.rev ?? 1) + 1;
}
