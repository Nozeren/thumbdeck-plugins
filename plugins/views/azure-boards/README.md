# Azure Boards

Your Azure DevOps work items in thumbdeck, read-only:

- **Its view** in the Plugins pane (`Ctrl+p`): the work items assigned to you (or created by
  you, or that you follow), most recently changed first, as a tree: each under its parent, and
  under yours their children and grandchildren even when they aren't yours, and above yours what
  they're under (dimmer, with who has them). `l` / `h` show and hide what's under one. Beside
  them, the highlighted one's page as Azure DevOps lays it out: its state, area and iteration;
  its description (repro steps, acceptance criteria…) with its formatting and images; the
  discussion, newest first; planning (priority, effort, dates…), development (branches, pull
  requests, commits, builds), related work, links, attachments and custom fields. `d` / `u`
  scroll it; a related work item opens in the list (or in Azure DevOps). `o` opens it in Azure DevOps, `y` copies a branch name
  for it (`feature/4211-login-redirects-to-a-blank-page`), `Y` copies `#4211 its title`, `/`
  filters.
- **How many are open**, next to its name in the Plugins pane.
- **A notification** when a new work item is assigned to you (it looks every 5 minutes).

Set it up in Settings (`,`) › Plugins › Azure Boards: your **organization** (its name, as in
dev.azure.com/*name*) and a **personal access token** (Azure DevOps › User settings ›
Personal access tokens › New token, with **Work Items: Read**; nothing more is needed). The
token is kept in thumbdeck's settings file, which only you can read, and is only sent to Azure
DevOps. Set the organization to `demo` to see it with sample work items.

It needs [Node](https://nodejs.org) for its backend, which starts with thumbdeck.
