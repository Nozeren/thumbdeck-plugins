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
  one opens its page. `h` / `l` move a day, `j` / `k` a week, `d` / `u` a month, `g` goes to today and
  `w` goes back to the list. Only your own changes count. The **Hours in a working day** setting
  is 8 by default. If your organization logs hours in a field of its own, put that field's
  reference name in the **Hours field** setting. It can be a number field, or a text field holding
  just the number ("4", "2.5" or "2,5"; empty is 0). A text field with anything else in it (a
  work log in JSON…) is said, not counted. If your organization logs Completed Work in days (0.5
  for half a day), set **Hours field is in** to Days: each day then counts as a working day's hours.
  If its time tool keeps a work log in a field instead (a JSON list of entries, each with its day
  and amount), name the field and its entries' keys: `Custom.WorkLogData | date: startDate |
  amount: daysSpent`, with **Hours field is in** set to the amount's unit. Each entry you add
  counts on its own day (a day you forgot, logged later, lands on that day), and one you change
  or take out is corrected on its day. With the `demo` organization, that setting (in Days)
  shows a sample work log.
- **Logging time**, when the Hours field is a work log: a work item's page shows its work log
  as a table (day, activity, hours, the total) instead of its raw JSON. `L` (or Log time) asks
  the day (today, or the calendar's selected day when you came from there), the hours and the
  activity (one already in your organization's work logs, or one you type); `L` again, or a
  row's Change and ✕, changes or removes an entry (removing asks first). New entries are
  written like the ones there: add the keys they have to the setting, e.g. `Custom.WorkLogData
  | date: startDate | amount: daysSpent | end: endDate | id: _id | activity: activityType` (the
  end gets the date, the id the highest one + 1); the date in the same form as theirs, the
  amount in the field's unit (in days: the hours ÷ the hours in a working day); an edited
  entry keeps its other keys. Only that field is written, back as it was kept (quotes as
  `&quot;` if they were), and refused if the work item changed meanwhile. It needs Work Items:
  Read & write.
- **Any work item, here**: one clicked in the calendar, Related work, a `#123` link or a search
  opens its page in the view (only `o` / Open opens Azure DevOps), even one that isn't in your
  list (closed, someone else's), and it can be changed there as yours can. `Esc` / `q` go back
  where you came from (the calendar, the search, the list), the cursor where it was.
- **Search**: `F` (or the Search button) asks for a number (that work item) or words: the work
  items whose title has all of them, anyone's, in any state, in the **Only these projects**
  setting's projects (all if it's empty), the most recently changed first, up to 50. `Enter` or
  a click opens one; `/` still filters the list.
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
