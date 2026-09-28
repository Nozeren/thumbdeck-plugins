# Tasks

Toolkit buttons for the commands in the project's `tasks.txt`, one per line:

```
# name: command
test: npm test
serve: python3 -m http.server
```

And a tab listing them: `j` / `k` move, `l` runs one (its output shows in the tab, and in a
tab of its own like any Toolkit button).

An example of a plugin with a **backend** (`backend.js`, in Node with `@thumbdeck/backend`): it
answers `actions` (the Toolkit asks again when `tasks.txt` changes), answers the tab's
`thumbdeck.backend.call("list")`, and sends an event every 10 seconds.
