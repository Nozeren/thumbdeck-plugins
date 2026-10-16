# Azure Boards

Your Azure DevOps work items in thumbdeck: to see them, change them and be told what changed.

- **Its view** in the Plugins pane (`Ctrl+p`): the work items assigned to you (or created by
  you, or that you follow), most recently changed first, as a tree: each under its parent, and
  under yours their children and grandchildren even when they aren't yours, and above yours what
  they're under (dimmer, with who has them). `l` / `h` show and hide what's under one. One with
  something new since you last looked at it (not by you) shows in bold.
- **Its page**, beside the list: a header that stays while it scrolls (its type, state and
  title); its description (repro steps, acceptance criteria…), then its **activity**, oldest
  first: the comments and its history together (created, state changes, reassignments, sprint
  moves, renames, priority, tags, its parent, linked pull requests), with **"New since you last
  looked"** where your last visit ended, and a box to write a comment. Beside them its
  **properties**, each changed with a click (state, assignee, iteration, priority, tags; a dot:
  changed since you looked), then planning, development, related work, links, attachments and
  your organization's fields. A long text shows its start and "Show all" (`f`: all of them); the fields you open
  stay open. `d` / `u` scroll it; `o` opens it in Azure DevOps, `y` copies a
  branch name for it (`feature/4211-login-redirects-to-a-blank-page`), `Y` (or Copy) copies `BUG 4211
  Its title`, `/` filters.
- **Markdown**: descriptions and comments kept as Markdown, or Markdown typed into Azure
  DevOps' editor, show formatted (headings, lists and tasks, tables, code, links, `#123` to a
  work item); a comment written here is Markdown too.
- **Your organization's own fields** (Custom.*, Contoso.*…) show by themselves, as their type
  says: a date, a person, yes or no, a number, text, and multi-line text beside the description.
  The **Fields** setting changes how one shows, or shows one of Azure DevOps' own, a line each:
  `reference name | label | format | where`, all but the name optional. Formats: text,
  markdown, html, date, number, person, yes-no, link; where: main (beside the description),
  planning, details, hidden. For example `Custom.Impact | Customer impact | markdown | main`,
  `Custom.Internal | | hidden`, `Microsoft.VSTS.Common.ClosedDate | Closed | date | details`.
  A line it can't read is shown at the top of the view.
- **Changes, from the keyboard**: `s` its state (the ones its type has), `a` assign it (to you,
  someone in the list, an email, or nobody), `c` write a comment, `e` its title, `t` its tags, `p` its
  priority, `m` move it to another iteration. **Or with the mouse**: click its title, state, or
  a property; in the box, click a choice, Save or Cancel. A comment: `c`, or click the box under
  its activity; Ctrl+Enter or Comment sends it. A change is refused if someone changed the work
  item meanwhile (yours doesn't undo theirs): look again (`r`) and redo it.
- **The current sprint**: `i` (or the Sprint button) shows only the current sprint's work items (your team's: each
  project's default team, or the one in Settings), and again for every iteration's; remembered.
- **Your hours, day by day**: `w` (or the Hours button) shows a month as a calendar. Each day
  shows the hours you logged that day: what you added to a work item's Completed Work, counted
  on the day you added it, and taken off again if you corrected it down. A bar shows how much of
  a working day that is, and turns green once the day is full. Each week also has a total. Beside
  the calendar are the selected day's work items and its week's, each with its hours. A click on
  one opens it. `h` / `l` move a day, `j` / `k` a week, `d` / `u` a month, `g` goes to today and
  `w` goes back to the list. Only your own changes count. The **Hours in a working day** setting
  is 8 by default. If your organization logs hours in a field of its own, put that field's
  reference name in the **Hours field** setting.
- **How many are open**, next to its name in the Plugins pane.
- **Notifications** (it looks every 5 minutes): a work item assigned to you, a state changed on
  yours, new comments on yours; not your own changes. What it saw last is remembered, so what
  changed while thumbdeck was closed is told too (many at once: in one). Each can be turned off
  in Settings.

Set it up in Settings (`,`) › Plugins › Azure Boards: your **organization** (its name, as in
dev.azure.com/*name*) and a **personal access token** (Azure DevOps › User settings ›
Personal access tokens › New token, with **Work Items: Read & write**, or **Read** to only
look; nothing more is needed). The
token is kept in thumbdeck's settings file, which only you can read, and is only sent to Azure
DevOps. Set the organization to `demo` to see it with sample work items.

It needs [Node](https://nodejs.org) for its backend, which starts with thumbdeck.
