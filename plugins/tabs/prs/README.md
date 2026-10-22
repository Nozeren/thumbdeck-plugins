# Pull requests

The open pull requests that concern you in **every repo you're in**, in the Plugins pane (`Ctrl+p`),
in the order to deal with them: asked to review again (after you reviewed), asked to review,
reviewed by you, and yours. Each row has its title, then repo, number, author and age, with its
checks (✓ ● ✗), comment count, conflict ⚠ or stale ⏳ marks and its reviewers' faces (a dot for
each one's verdict); 🔔 marks an unread GitHub notification. The highlighted one's details fill
the right side: verdicts, each check, the start of its description, labels. Filters at the top
(All, To review, Yours, Unread, with their counts): `Space f` goes through them.

- `Enter` (or `l`, `gd`) opens thumbdeck's review page for its changes (nothing is checked out).
  There: `cc` comments on a line, `v` selects lines to comment on together (then `c`), `Ctrl+g` suggests a
  change; the threads show under their lines (`Enter` replies, `x` resolves); `Space A` approves, `Space R`
  requests changes, `:w` posts your review with its comments. `zR` shows the whole file.
- `gx` opens it in the browser and marks its notification read.
- **Failed checks**: under Checks, a failed GitHub Actions job shows the step that failed and the
  end of its log (up to its error), with a link to the whole log. `Space r` (or Re-run failed)
  re-runs the failed jobs of each of its runs. Checks from elsewhere (other CI) only link to their page.
- **Merging**: `Space m` merges it, the way the repo allows (squash, merge commit or rebase; the one
  you used last first), then asks whether to delete its branch (not asked when the repo deletes
  branches itself, or the branch is in a fork). When GitHub won't merge it yet, it says why (a
  draft, an approval needed, required checks, conflicts, behind its base). It's refused if new
  commits came after you looked. Nothing is checked out or changed on your computer.
- **Yours**: `Space d` marks a draft ready for review (or turns it back into a draft, asked first),
  `Space u` asks someone to review it (suggested reviewers first; type to search anyone who can
  review in the repo, several at once, or `org/team`), `i` edits its title and `cc` its
  description (Markdown; Ctrl+Enter saves). The buttons under its details do the same.
- **Notifications**, even while the view isn't shown (it looks every few minutes): a review
  asked of you; on yours, an approval, changes requested, and checks that started failing. Not
  what was already there at the first look. Each can be turned off in Settings.
- The avatar holds up a sign while PRs wait for your review, and the Plugins pane says how many.

It reads and writes GitHub with the [GitHub CLI](https://cli.github.com) (`gh`), so it uses your gh
login; the notifications need [Node](https://nodejs.org) for its backend, which starts with thumbdeck. **Settings › Plugins › Pull requests › Repos** limits it to some owners (`acme`) or repos
(`acme/app`); empty is every repo you're in, and `demo` shows sample PRs (with a sample review).

Until 2.0 this was a tab per project, reading that project's repo; projects that had the tab show
it as gone (remove it there).
