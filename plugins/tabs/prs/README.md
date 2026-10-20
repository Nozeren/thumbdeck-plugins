# Pull requests

The open pull requests that concern you in **every repo you're in**, in the Plugins pane (`Ctrl+p`),
in the order to deal with them: asked to review again (after you reviewed), asked to review,
reviewed by you, and yours. Each row has its title, then repo, number, author and age, with its
checks (✓ ● ✗), comment count, conflict ⚠ or stale ⏳ marks and its reviewers' faces (a dot for
each one's verdict); 🔔 marks an unread GitHub notification. The highlighted one's details fill
the right side: verdicts, each check, the start of its description, labels. Filters at the top
(All, To review, Yours, Unread, with their counts): `f` goes through them.

- `v` (or `l`, `Enter`) opens thumbdeck's review page for its changes (nothing is checked out).
  There: `c` comments on a line, `V` selects lines to comment on together, `Ctrl+g` suggests a
  change; the threads show under their lines (`Enter` replies, `z` resolves); `A` approves, `R`
  requests changes, `P` posts your review with its comments. `f` shows the whole file.
- `o` opens it in the browser and marks its notification read.
- The avatar holds up a sign while PRs wait for your review, and the Plugins pane says how many.

It reads and writes GitHub with the [GitHub CLI](https://cli.github.com) (`gh`), so it uses your gh
login. **Settings › Plugins › Pull requests › Repos** limits it to some owners (`acme`) or repos
(`acme/app`); empty is every repo you're in, and `demo` shows sample PRs (with a sample review).

Until 2.0 this was a tab per project, reading that project's repo; projects that had the tab show
it as gone (remove it there).
