# Chrome

Your browser's profiles in a view in the Plugins pane (`Ctrl+p`), **grouped by tenant**: when
you have one profile per account and several accounts per tenant, each window is a key away.

- **Tenants** come from each profile's account: profiles signed in on `@contoso.com` group
  under Contoso, gmail.com and the like under Personal. Profiles the browser doesn't know an
  account for (a Microsoft 365 account, say) go to Ungrouped until you give them one (`e`) or
  move them (`m`). `N` makes a tenant, `E` renames it or changes its domains.
- `Enter` opens the profile's window (or brings it forward); a green dot marks the ones open.
  `a` `b` `c` open its **shortcuts**: the pages you use in that profile.
- `n` makes a **new profile**: the browser opens on it, you sign in, and it shows its account
  once the browser saves it. `e` edits a profile: its name, account, tenant, role (admin,
  dev, test…), colour and shortcuts. These are thumbdeck's labels; the browser's own stay.
- `x` **deletes**: hide a profile in thumbdeck (`H` shows hidden ones), or delete it from the
  browser, with its bookmarks, passwords, cookies and history (the folder goes to the Trash,
  and the browser's profile list is backed up first). That one needs the browser closed,
  since it rewrites its profile list when it quits.
- **Link rules** (`Tab`): links like `dev.azure.com/contoso/*` open in the profile you pick.
  With thumbdeck 0.9 or newer, thumbdeck's links (Pull requests, Azure Boards, Calendar, the
  review page) follow them; links no rule matches open in your default browser. `t` tries a
  link.

Settings (`,`) › Plugins › Chrome picks the browser: Chrome, Chromium, Brave or Edge. It reads
the browser's `Local State` file and starts it with `--profile-directory`; your labels,
tenants and rules are kept in the plugin's data folder.
