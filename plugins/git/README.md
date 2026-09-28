# Git

The project's repo at a glance, in a tab: the uncommitted changes and their diffs, the branch
against its upstream, recent commits, branches and stashes. It only looks: it never changes the
repo (commit, push and the rest are for your own tools), and asks git not to take locks, so it
can't get in their way.

- `Tab` switches between Changes, Commits and Branches; `j` / `k` move, and the highlighted
  one's diff shows below (`d` / `u` scroll it).
- `l` or `v` opens thumbdeck's review page: all uncommitted changes (at the highlighted file),
  a commit, or a stash.
- The tab's setup (`S`) sets how many recent commits to list.
