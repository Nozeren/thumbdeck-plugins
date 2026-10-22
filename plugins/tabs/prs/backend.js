// The Pull requests backend: looks every few minutes, even while the view isn't shown, and tells
// you what changed (a review asked of you; on yours: an approval, changes requested, failed
// checks), says how many wait for your review (the Plugins pane's status, the avatar's sign),
// and tells the view to look again. Asks GitHub with the GitHub CLI (gh), your gh login.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../../packages/backend/index.js";
import { SEARCH_QUERY, notices, prEvents, searches, snapshot, sortPrs } from "./prs.js";

let settings = {
  repos: "", refresh_minutes: 5, bots: ["copilot-pull-request-reviewer"], trim_suffix: "", notify_review: true, notify_verdicts: true, notify_checks: true,
};
let error = "";

/** Runs gh: its output, or an error with its first line */
const gh = (args) => new Promise((resolve, reject) => {
  execFile("gh", args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
    if (!err) return resolve(stdout);
    reject(new Error(err.code === "ENOENT" ? "the GitHub CLI (gh) isn't installed" : `gh: ${(String(stderr).split("\n").find((l) => l.trim()) ?? err.message).trim()}`));
  });
});
const graphql = async (query, vars) => {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
  return JSON.parse(await gh(args));
};
const demo = () => String(settings.repos ?? "").trim() === "demo";
const testdata = (f) => JSON.parse(readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8"));

/** The PRs that concern you (as the view sorts them) */
async function fetchPrs() {
  if (demo()) return sortPrs(testdata("search.json"), testdata("notifications.json"), "me_corp", { ...settings, trim_suffix: "_corp" });
  const [user, prs] = await Promise.all([gh(["api", "user", "--jq", ".login"]), graphql(SEARCH_QUERY, searches(settings.repos))]);
  if (!prs?.data) throw new Error("GitHub's answer had no PRs in it");
  return sortPrs(prs, [], user.trim(), settings);
}

// One look at a time
let looking = null;
function look(tb) {
  looking ??= (async () => {
    try {
      const prs = await fetchPrs();
      const waiting = prs.filter((p) => p.category === "review" || p.category === "re-review").length;
      tb.status(waiting ? `${waiting} to review` : null);
      tb.mood("review", waiting);
      // Per account and repos: another login's (or other repos') last look isn't compared
      const key = `${demo() ? "demo" : "gh"} ${String(settings.repos ?? "").trim()}`;
      const kept = await tb.storage.get("seen").catch(() => undefined);
      const events = prEvents(kept?.key === key ? kept.prs : null, prs);
      for (const [title, body] of notices(events, settings)) tb.notify(title, body);
      await tb.storage.set("seen", { key, prs: snapshot(prs) }).catch(() => {});
      if (events.length) tb.event("changed", { at: Date.now() });
      error = "";
    } catch (e) {
      error = e.message;
      tb.status("!");
    }
  })().finally(() => (looking = null));
  return looking;
}

let timer = null;
function schedule(tb) {
  clearInterval(timer);
  timer = setInterval(() => look(tb), Math.max(1, Number(settings.refresh_minutes) || 5) * 60_000);
}

serve({
  initialize(info, tb) {
    settings = { ...settings, ...info.settings };
    look(tb);
    schedule(tb);
  },
  settings(s, tb) {
    settings = { ...settings, ...s };
    look(tb);
    schedule(tb);
  },
  /** The view is here: it leaves the status and the avatar to this */
  hello: () => ({ ok: true }),
  /** Look now (after the view changed something): what changed since is told */
  async refresh(_p, tb) {
    await look(tb);
    return { error };
  },
});
