# Logs

A log viewer in a tab, for the project's log files: JSON lines (any tool's field names) or plain
text (Python logging, Rust, Go, Django, nginx, syslog, build output…).

- The files in the tab's folders, newest first, with a red dot when one has an ERROR; a preview
  says how many lines of each level, how long the run took, and its first error.
- A log: levels in colour (`f` then `D` `I` `W` `E` shows or hides one), search (`/`, then `n` /
  `N`), `e` / `E` for the next and previous error, live tail (`t`), and a line's full entry
  (`l`), its values copied with `y`.
- **Sections** (in the tab's setup): fold a log into parts that start and end at marker texts,
  a request, a test, a deploy step. Top sections (◆) hold inner ones (▸), and a section with an
  error is marked red.

The avatar reads along while a log opens. The tab's reading is done by its backend
(`backend.js`, in [Node](https://nodejs.org)). Its pages are built from `ui/` (Svelte) into `dist/`:
`npm run build` in the plugins repo.
