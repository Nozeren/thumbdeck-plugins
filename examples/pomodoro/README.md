# Pomodoro

A focus timer, as an example of a plugin that isn't about one project:

- its **view** in the Plugins pane (`Ctrl+p`): start and stop (`s`), reset (`x`), today's
  sessions; the pane shows the time left next to its name while it runs,
- a **panel** on the right with the time left, in every project,
- a full-window **page** with the history (`H`),
- a **setting** for the length of a session, and a notification when one ends.

The view and the panel share the timer through the plugin's storage (`timer.js`).
