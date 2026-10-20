# Notes

A **Notes** tab for any project: a scratchpad for what you were doing and what's next. It's
saved as you write, kept by thumbdeck (not in the project, so it never ends up in git), one per
project.

- `i` (or `a`) writes, `o` writes on a new line at the end, `Esc` stops.
- Checklist items (`- [ ] …`) count: the tab's number is how many are open. `x` ticks or
  unticks the item on the line where the cursor was (the first open one otherwise).
- `gx` opens the notes in nvim in the project's tmux; what you save there comes back.

It also adds a **Notes** card to every project's Overview: the open checklist items (or the
notes' first lines). Enter shows the Notes tab, when the project has one; `dd` hides the card in
a project where you don't keep notes.
