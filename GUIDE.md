# Writing a thumbdeck plugin

A walk from nothing to a plugin with Toolkit buttons, a tab, keys and a backend. Each step
works on its own: stop at the one that does what you need. The full contract is
[SPEC.md](SPEC.md); the examples in [`examples/`](examples) and the official plugins in
[`plugins/`](plugins) show everything in use.

## 1. A folder and a plugin.toml

```
mkdir ~/dev/deploy-buttons && cd ~/dev/deploy-buttons
```

```toml
# plugin.toml
id = "deploy-buttons"
name = "Deploy"
version = "0.1.0"
api = 1
description = "Deploy the project to staging or production"

[detect]
files = ["fly.toml"]            # only for projects with a fly.toml

[[action]]
name = "staging"
command = "fly deploy --config fly.staging.toml"

[[action]]
name = "production"
command = "fly deploy"
confirm = true                  # asks before running
```

Add it to thumbdeck: **Settings** (`,`) **› Plugins › Add a plugin › Use a folder…**, and
pick the folder. It's used where it is, so every time you save a file thumbdeck reloads it.
Open a project with a `fly.toml`: the Toolkit has a **Deploy** group with two buttons (Space,
then their letter, runs one).

If something's wrong, Settings › Plugins shows the plugin with a red `!` and says what, in a
sentence (`plugin.toml line 9: there's no key comand (did you mean command?)`).

Buttons can use `{project}`, `{path}`, `{python}` and `{pm}`, and your own `[vars]`; they can
run in the project's tmux session (`tmux = { window = "server" }`), show only when a file is
there (`when = { files = [...] }`), or come one per item of a list (`[[generate]]`: npm
scripts, Makefile targets). See [Toolkit actions](SPEC.md#toolkit-actions).

## 2. A tab

A tab is an HTML page. Add it to plugin.toml:

```toml
[[tab]]
id = "releases"
name = "Releases"
page = "releases.html"
```

```html
<!-- releases.html -->
<!doctype html>
<html>
<body>
  <div class="td-toolbar"><strong>Releases</strong></div>
  <ul class="td-list" id="list"></ul>
  <script type="module">
    const td = window.thumbdeck;
    const r = await td.exec(["fly", "releases", "--json"]);
    if (r.code !== 0) td.ui.say(r.stderr, { error: true });
    const releases = JSON.parse(r.stdout || "[]");
    document.getElementById("list").innerHTML = releases
      .map((x) => `<li>v${x.Version} ${td.escape(x.Status)} <span class="td-muted">${td.escape(x.CreatedAt)}</span></li>`)
      .join("");
  </script>
</body>
</html>
```

Save both, then add the tab to a project: the **+** at the end of the tab bar lists
**Releases**. `window.thumbdeck` (the page API) is there before your script runs: files,
commands, storage, the status line, notifications, thumbdeck's review page, and more (see
[the page API](SPEC.md#the-page-api-windowthumbdeck)). With `/// <reference types="@thumbdeck/plugin" />`
(`npm install -D @thumbdeck/plugin`) your editor explains each call as you type.

The page already looks like thumbdeck: its colors and fonts are there as CSS variables
(`var(--green)`, `var(--mono)`), and plain HTML is styled (`td-list`, `td-muted`,
`td-toolbar` and a few more; see [Looking like thumbdeck](SPEC.md#looking-like-thumbdeck)).

## 3. Its setup

Each tab has a setup, per project (`S` opens it). Declare the fields; thumbdeck draws the form:

```toml
[[tab.setup]]
key = "app"
label = "Fly app name"
type = "text"
default = ""
help = "Empty: the one in fly.toml"
```

```js
const { app } = await td.setup.get();
td.on("setup", (s) => reload(s));   // saved while the tab is open
```

Field types: text, number, bool, choice, list, folder, file, folders, files, json. A setup that
needs more than a form can have its own page (`setup_page`); the Logs plugin does.

## 4. Keys

Tabs are used from the keyboard. Declare what keys do, and thumbdeck sends your page the action:

```toml
[keys.list]
name = "RELEASES"                # shown in the status line while the tab has the keyboard
surface = "tab:releases"
bindings = [
  { keys = ["j", "ArrowDown"], action = "down", does = "down" },
  { keys = ["k", "ArrowUp"], action = "up", does = "up" },
  { keys = ["l", "Enter"], action = "open", does = "open the release in the browser" },
  { keys = ["r"], action = "refresh", does = "look again" },
]
```

```js
td.on("key", ({ action }) => {
  if (action === "down") move(1);
  else if (action === "up") move(-1);
  else if (action === "open") td.ui.openUrl(urlOf(cursor));
  else if (action === "refresh") load();
});
```

`?` shows these keys, `S` the setup, and `q` / `Esc` give the keyboard back, without you
doing anything. A key means the same thing everywhere in thumbdeck (`j` is always down, `r`
always refresh, …): a plugin that binds one to something else isn't loaded, and says why. The
table is in [Keys](SPEC.md#keys). Several keymaps for one tab are modes: `td.keys.use("detail")`.

## 5. A backend

A page can run commands and read files, which is often enough. When it isn't (a big parse,
something to keep running, Toolkit buttons worked out by code), add a backend: any program that
reads JSON on stdin and answers on stdout, one message per line. In Node, with the helper:

```toml
[backend]
command = "node backend.js"
install = "npm ci --omit=dev"    # after installing and updating (not for a linked folder)
```

```js
// backend.js
import { serve } from "@thumbdeck/backend";

serve({
  async regions({ project }) {
    // any work; what you return is the page's answer
    return ["ams", "fra"];
  },
});
```

```js
// in the page
const regions = await td.backend.call("regions");
```

thumbdeck starts it on the first call and keeps it for every project; `console.log` in it goes
to the plugin's log. With `actions = true` it can also answer `actions` with Toolkit buttons.
Any language works: the messages are in [The backend](SPEC.md#the-backend).

## 6. When something's wrong

- **Settings › Plugins › your plugin › Log**: the page's console output and errors, the
  backend's stderr, and API calls that failed.
- **Inspect** (same place): the web inspector, to look into your page.
- `thumbdeck plugin check .` (or `npx @thumbdeck/check .` where thumbdeck isn't installed, like
  CI) runs every check thumbdeck makes when it loads a plugin.

## 7. Share it

Push the folder to a git repository, then tag a release whose name is the version in
plugin.toml:

```
git tag v0.1.0 && git push --tags
```

Anyone can install it with **Settings › Plugins › Add a plugin**, giving the repository's URL.
thumbdeck installs the latest release tag, and offers newer ones when you tag them. A
repository with several plugins works too: `url#folder`, with tags like `deploy-buttons-v0.1.0`.

A plugin runs with your rights, like an editor plugin: say in its README what it runs and what
it needs.
