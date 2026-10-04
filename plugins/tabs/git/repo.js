// Running git in the project, for the Git tab and its Overview cards.
import { cut, LOG_FORMAT, parseLog } from "./git.js";

const td = window.thumbdeck;

/** Run git in the project; its output, or an error with git's message */
export async function git(args, { exitOneIsFine = false } = {}) {
  const r = await td.exec(["git", "-c", "core.quotepath=off", "-c", "color.ui=never", "--no-pager", ...args], {
    env: { GIT_OPTIONAL_LOCKS: "0" },
  });
  // `git diff --no-index` exits 1 when the files differ
  if (r.code === 0 || (exitOneIsFine && r.code === 1)) return r.stdout;
  throw new Error((r.stderr.split("\n").find((l) => l.trim()) ?? "git failed").trim());
}

/** Everything to review, as one diff: "changes" (all uncommitted changes, new files too), a
 *  commit (by hash), or a stash ("stash@{0}") */
export async function review(what) {
  if (what === "changes") {
    // Against the last commit; a repo without commits has only the staged and unstaged diffs
    let out;
    try {
      out = await git(["diff", "HEAD", "--find-renames"]);
    } catch {
      out = (await git(["diff", "--cached"])) + (await git(["diff"]));
    }
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const file of untracked) {
      out += await git(["diff", "--no-index", "--", "/dev/null", file], { exitOneIsFine: true });
      if (out.length > 300_000) break;
    }
    return cut(out);
  }
  if (what.startsWith("stash@{")) return cut(await git(["stash", "show", "--patch", "--find-renames", what]));
  return cut(await git(["show", "--format=", "--patch", "--find-renames", what]));
}

export async function log(count) {
  try {
    return parseLog(await git(["log", `-n${Math.max(1, count)}`, LOG_FORMAT]));
  } catch (e) {
    if (/does not have any commits/.test(e.message)) return []; // a repo without commits yet
    throw e;
  }
}
