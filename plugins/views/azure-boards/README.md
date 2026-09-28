# Azure Boards

Your Azure DevOps work items in thumbdeck, read-only:

- **Its view** in the Plugins pane (`Ctrl+p`): the work items assigned to you (or created by
  you, or that you follow), most recently changed first; the highlighted one's details,
  description and comments beside them. `o` opens it in Azure DevOps, `y` copies a branch name
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
