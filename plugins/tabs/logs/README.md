# Logs

A log viewer in a tab, for the project's log files: JSON lines (any tool's field names) or plain
text (Python logging, Rust, Go, Django, nginx, syslog, build output…).

- The files in the tab's folders, newest first, each with a small graph of its activity over
  time, its errors and warnings, and its time span; a preview says how many lines of each level,
  how long the run took, and its first error.
- A **timeline** over a log: its lines over time, by level, with the part on screen framed; click
  it to go to that moment. A map on the right edge marks the errors and warnings.
- The highlighted line's **entry beside the log**: its fields, a traceback written out, and, for a
  line with a request id (`req`, `request_id`, `trace_id`…), that request's other lines. Enter
  moves the keyboard into it; `i` hides it. `=` shows only that request's lines.
- JSON fields show after the message (`req=r1008 ms=3000`); repeated lines fold into one with
  ×n (`c` shows every line); search marks its words.
- A log: levels in colour (`f` then `D` `I` `W` `E` shows or hides one), search (`/`, then `n` /
  `N`), `e` / `E` for the next and previous error, live tail (`t`), and a line's full entry
  (`l`), its values copied with `y`.
- **Sections** (in the tab's setup): fold a log into parts that start and end at marker texts,
  a request, a test, a deploy step. Top sections (◆) hold inner ones (▸), and a section with an
  error is marked red.

The avatar reads along while a log opens. The tab's reading is done by its backend
(`backend.js`, in [Node](https://nodejs.org)). Its pages are built from `ui/` (Svelte) into `dist/`:
`npm run build` in the plugins repo.
