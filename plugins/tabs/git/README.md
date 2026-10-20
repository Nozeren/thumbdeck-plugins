# Git

The project's repo at a glance, in a tab: the uncommitted changes and their diffs, the branch
against its upstream, recent commits, branches and stashes. It only looks: it never changes the
repo (commit, push and the rest are for your own tools), and asks git not to take locks, so it
can't get in their way.

- `Tab` switches between Changes, Commits and Branches; `j` / `k` move, and the highlighted one
  shows beside the list (`d` / `u` scroll it): a file's diff with line numbers; a commit's
  message, its files with their added and removed lines, and its diff; a branch against the main
  branch (ahead / behind, merged, its commits not in main yet); a stash's files and diff.
- The header has the branch against its upstream (↑ ahead, ↓ behind); files show their +/−,
  commits their branch and tag names and counts, branches ↑ / ↓ against main.
- `l` or `v` opens thumbdeck's review page: all uncommitted changes (at the highlighted file),
  a commit, or a stash.
- The tab's setup (`S`) sets how many recent commits to list.

It also adds two cards to every git project's **Overview**, with or without the tab:

- **Changes**: the branch against its upstream and the uncommitted files (up to 8). Enter or
  `v` opens them all in the review page.
- **Recent commits**: the last 5. Enter shows the Git tab, when the project has one.
