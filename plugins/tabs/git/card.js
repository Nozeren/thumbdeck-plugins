// The Git plugin's cards in a project's Overview: "changes" (the branch and the uncommitted
// files; Enter or v reviews them) and "commits" (the last few; Enter shows the Git tab, from
// plugin.toml's opens). Read-only. Looks again every 5 seconds while shown.
import { ago, parseStatus, stateWord, track } from "./git.js";
import { git, log, review } from "./repo.js";

const td = window.thumbdeck;
const esc = td.escape;
const card = td.context.id;
const project = td.context.project;
const MAX_FILES = 8;
const COMMITS = 5;

let status = null;

async function draw() {
  try {
    document.getElementById("card").innerHTML = card === "changes" ? await changes() : await commits();
    document.getElementById("error").hidden = true;
  } catch (e) {
    const el = document.getElementById("error");
    el.textContent = e.message;
    el.hidden = false;
  }
}

async function changes() {
  status = parseStatus(await git(["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]));
  const { branch, changes } = status;
  td.ui.badge(changes.length || null);
  const head = `<div class="line head"><span class="branch">${esc(branch.name ?? "detached HEAD")}</span>
    <span class="track">${track(branch.ahead, branch.behind)}</span>${branch.gone ? `<span class="red">upstream gone</span>` : ""}</div>`;
  if (!changes.length) return `${head}<div class="line dim">Clean: nothing uncommitted.</div>`;
  const rows = changes.slice(0, MAX_FILES).map((c) => {
    const s = c.staged === "?" ? "?" : c.staged !== " " ? c.staged : c.unstaged;
    return `<div class="line"><span class="state s${s === "?" ? "N" : s}" title="${stateWord[s] ?? s}">${s === "?" ? "+" : s}</span>
      <span class="grow" title="${esc(c.path)}">${esc(c.path)}</span></div>`;
  });
  const more = changes.length > MAX_FILES ? `<div class="line dim">and ${changes.length - MAX_FILES} more · Enter reviews them all</div>` : "";
  return head + rows.join("") + more;
}

async function commits() {
  const list = await log(COMMITS);
  if (!list.length) return `<div class="line dim">No commits yet.</div>`;
  return list.map((c) => `<div class="line"><span class="hash">${esc(c.short)}</span>
    <span class="grow" title="${esc(c.subject)}">${esc(c.subject)}</span><span class="when">${ago(c.date)}</span></div>`).join("");
}

function reviewChanges() {
  if (!status?.changes.length) return td.ui.say("Nothing to review: the working tree is clean.");
  td.ui.openReview({
    title: "Uncommitted changes", subtitle: `${project?.name ?? ""} · ${status.branch.name ?? "detached HEAD"}`,
    diff: () => review("changes"), viewedKey: `changes:${project?.path}`,
  });
}

td.on("key", ({ action }) => {
  if (action === "review") reviewChanges();
  else if (action === "refresh") draw();
});

let shown = true;
td.on("shown", () => ((shown = true), draw()));
td.on("hidden", () => (shown = false));
setInterval(() => shown && !document.hidden && draw(), 5000);
draw();
