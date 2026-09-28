# thumbdeck plugins (plugin API 1)

A **plugin** adds things to thumbdeck: tabs for a project, buttons in its Toolkit, panels on the
right, full-window pages, or a view of its own in the Plugins pane. Everything thumbdeck shows
besides projects and their READMEs comes from plugins, including Logs, Git, Pull requests,
Agents and the language toolkits (Django, npm, Cargo, …).

A plugin is a folder with a `plugin.toml`. The simplest plugins are only that file: rules for
when they apply and the buttons they add. Plugins with a screen of their own add HTML pages
(plain HTML, or any framework) that talk to thumbdeck through `window.thumbdeck`. Plugins that
need more than a page can do add a **backend**: any program that reads and writes JSON lines.

This document is the whole contract. To write a first plugin step by step, see
[GUIDE.md](GUIDE.md).

- [A first plugin](#a-first-plugin)
- [The folder](#the-folder)
- [plugin.toml](#plugintoml)
- [Where a plugin shows up](#where-a-plugin-shows-up)
- [Toolkit actions](#toolkit-actions)
- [Settings and tab setup](#settings-and-tab-setup)
- [The page API (`window.thumbdeck`)](#the-page-api-windowthumbdeck)
- [Keys](#keys)
- [Looking like thumbdeck](#looking-like-thumbdeck)
- [The backend](#the-backend)
- [Installing, versions and updates](#installing-versions-and-updates)
- [API versions](#api-versions)
- [Writing and testing a plugin](#writing-and-testing-a-plugin)
- [Examples](#examples)

## A first plugin

A plugin that adds two buttons to Django projects:

```toml
# plugin.toml
id = "django"
name = "Django"
version = "1.0.0"
api = 1
description = "manage.py commands"

[detect]
files = ["manage.py"]

[[action]]
name = "runserver"
command = "{python} manage.py runserver"
tmux = { window = "server" }

[[action]]
name = "migrate"
command = "{python} manage.py migrate"
```

A plugin with a tab, a page that lists the project's TODO comments:

```toml
# plugin.toml
id = "todos"
name = "TODOs"
version = "0.1.0"
api = 1

[[tab]]
id = "todos"
name = "TODOs"
page = "todos.html"
```

```html
<!-- todos.html -->
<ul class="td-list" id="list"></ul>
<script type="module">
  const td = window.thumbdeck;
  const { stdout } = await td.exec(["git", "grep", "-n", "TODO"]);
  document.getElementById("list").innerHTML = stdout
    .split("\n").filter(Boolean)
    .map((line) => `<li>${td.escape(line)}</li>`).join("");
</script>
```

Install either one from its folder (**Settings** (`,`) **› Plugins › Add a plugin › Use a
folder…**), and it reloads whenever you save a file.

## The folder

```
my-plugin/
  plugin.toml        required: what the plugin is and adds
  README.md          shown in Settings › Plugins
  icon.svg           optional: the plugin's icon in Settings (and its projects' icon, see detect)
  *.html, *.js, …    its pages and whatever they load
  backend/…          optional: the backend program
```

Pages load their files by relative paths (`<script src="tab.js">`); anything in the folder can
be loaded, nothing outside it. A build step (Vite, esbuild) is fine: point `page` at the built
file and commit the build output, since thumbdeck doesn't build plugins.

## plugin.toml

```toml
id = "pomodoro"                 # lowercase letters, digits and -; unique among plugins
name = "Pomodoro"               # shown everywhere
version = "1.2.0"               # semver; matches the release tag (see Installing)
api = 1                         # the page/backend API version it's written for
description = "A focus timer"   # one line, shown in Settings
homepage = "https://github.com/x/thumbdeck-pomodoro"   # optional
icon = "icon.svg"               # optional
```

The rest of the manifest says what the plugin adds. Every section is optional:

| section | adds | scope |
| --- | --- | --- |
| `[detect]` | when the plugin's project features apply (tabs, panels, actions) | project |
| `[[action]]`, `[[generate]]`, `[vars]` | Toolkit buttons | project |
| `[[tab]]` | a tab in the center, turned on per project | project |
| `[[panel]]` | a panel on the right, under Running and Toolkit | project or app |
| `[[page]]` | a full-window page, opened by one of the plugin's frames | either |
| `[view]` | an entry in the Plugins pane that opens in the center | app |
| `[[settings]]` | the plugin's settings, drawn by thumbdeck in Settings › Plugins | app |
| `[backend]` | a program the pages (and thumbdeck) can call | app |
| `[keys]` | the keys of its tabs, panels, pages and view | — |

**Project scope** means it belongs to one project: it only shows for projects the plugin's
`[detect]` matches (every project when there's no `[detect]`), and a tab's frame always knows
its project. **App scope** means it's the same whatever project is selected; it can still
follow the selected project through the `project` event.

### Detection

`[detect]` decides whether the plugin applies to a project. Every condition you write must
match (AND). Paths are relative to the project folder and may use globs (`*`, `**`, `?`).

| key | matches when |
| --- | --- |
| `files = ["a", "b"]` | **any** of these exist |
| `all_files = ["a", "b"]` | **all** of these exist |
| `not_files = ["a"]` | **none** of these exist |
| `json = [{ file = "package.json", key = "dependencies.react" }]` | each file exists and contains the key (dotted path); add `value = "..."` to also compare the value |
| `contains = [{ file = "pyproject.toml", text = "[tool.pytest" }]` | each file exists and contains the text (plain text, not a pattern) |
| `any = [{ files = ["pytest.ini"] }, { contains = [...] }]` | **at least one** of these `[detect]`-style tables matches |
| `git_remote = "github.com[:/]acme/"` | the `origin` remote URL matches this regular expression |
| `path = "~/work/**"` | the project folder matches this glob |

`[detect]` can also give matching projects an icon, and ask for other plugins:

```toml
[detect]
files = ["manage.py"]
icon = "icon.svg"       # the project's icon in the list (the lowest priority wins)
priority = 50           # order among plugins that apply: Toolkit groups, icons (default 50)
requires = ["python"]   # these plugins apply along with this one (see below)
```

`requires` lists plugins that come **along**: when this plugin applies, the required ones
apply too, even if their own `[detect]` doesn't match, and their `[vars]` can be used here.
A required plugin that isn't installed is offered for installing (when it's in the catalog);
until then this plugin's actions are off and Settings says why. Circular requirements are an
error; neither plugin loads.

## Where a plugin shows up

Every screen a plugin draws is an HTML **page** in a frame. The same plugin can have several:
a tab, a panel and a page can each be a different HTML file, or the same one reading
`thumbdeck.context.surface`.

### Tabs

```toml
[[tab]]
id = "logs"               # unique in the plugin; a plugin may offer several tabs
name = "Logs"             # the tab's default title (the user can rename it)
description = "The project's log files: levels, search, errors, live tail"
page = "tab.html"
```

A tab is turned on per project, from the tab bar's **+**, and each one has its own **setup**
(see [Settings and tab setup](#settings-and-tab-setup)). The same tab can be added twice to one
project with different setups (e.g. two Logs tabs for two folders). Tabs are numbered at the
bottom of the center; `1`–`9` show them.

### Panels

```toml
[[panel]]
id = "ci"
name = "CI"
page = "panel.html"
scope = "project"         # "project" (default): only for projects the plugin applies to;
                          # "app": always there
height = "auto"           # "auto" (the page's height, up to half the column) or a number of lines
```

Panels sit on the right, under Running and Toolkit, in the order of the plugins in Settings
(↑ ↓ there change it). A panel is for a glance: a status, a count, a short list. Panels don't
take the keyboard; a click in one (a button of its own, or `thumbdeck.ui.openPage`) is how it
leads to more.

### Pages

```toml
[[page]]
id = "run"
page = "run.html"
```

A page covers the whole window, like the review page. It's opened from one of the plugin's
own frames with `thumbdeck.ui.openPage("run", data)`, gets `data` as `thumbdeck.context.data`,
and closes with `q` / `Esc` (or `thumbdeck.ui.close()`). A page opened from a tab keeps that
tab's project.

### The view (the Plugins pane)

```toml
[view]
name = "Pomodoro"
page = "view.html"
status = true             # show a short status next to the name in the pane (thumbdeck.ui.status)
```

A plugin with a `[view]` gets an entry in the **Plugins** pane below Projects (`Ctrl+p` takes
the keyboard there, `Esc` goes back to Projects). Selecting it
shows the view in the center, in place of the project. A plugin has at most one view, and it's
app scope. Plugins without a view (Toolkit-only, tab-only) aren't listed in the pane; they're
managed in **Settings › Plugins**.

### Frames and their life

- A frame is loaded the first time it's shown and kept while thumbdeck runs, so switching
  tabs doesn't reload it. thumbdeck may unload frames that haven't been shown for a while;
  keep anything that matters in [storage](#storage).
- Tab frames belong to one project each: selecting another project shows that project's frame.
  A project-scope panel loads again for the newly selected project; app-scope frames (views,
  app panels) stay and get the `project` event.
- A frame learns it's hidden or shown through the `hidden` / `shown` events; stop polling
  while hidden.

## Toolkit actions

Toolkit buttons are declared in the manifest (they work without any code) or come from the
backend (for lists only a program can work out).

### Declared actions

```toml
[[action]]
name = "migrate"                        # button label; unique in the plugin
command = "{manage} migrate"            # run in the project folder, login shell environment
description = "Apply migrations"        # tooltip
confirm = true                          # ask before running
when = { files = ["pytest.ini"] }       # a [detect]-style table: only show when it also matches
tmux = { window = "server" }            # run in the project's tmux session (or: tmux = true)
```

An action's id is `<plugin id>:<name>` (e.g. `django:migrate`); that's what hiding an action
refers to. By default an action runs inside thumbdeck: its output in a tab at the bottom of the
center, a notification when it ends while you're elsewhere. With `tmux`, it's typed into that
window of the project's tmux session (created if needed; if the window is busy, thumbdeck says
so instead of typing into it) and keeps running when thumbdeck closes.

### Variables

Commands can use `{name}`:

| variable | value |
| --- | --- |
| `{project}` | the project folder's name |
| `{path}` | the project folder's full path |
| `{python}` | `.venv/bin/python` or `venv/bin/python` when the project has one, otherwise `python3` |
| `{pm}` | the JavaScript package manager, from the lockfile: `pnpm`, `yarn`, `bun` or `npm` |
| `{item}` | in generated actions: the current item |

A plugin can define its own; a value may use the built-ins:

```toml
[vars]
manage = "{python} manage.py"
```

Anything else in braces is left as it is, so `${HOME}` and `awk '{print $1}'` work.

### Generated actions

One button per item of a list the project's files give: npm scripts, Makefile targets, …

```toml
[[generate]]
source = { json = "package.json", keys = "scripts" }
skip = ["prepare", "postinstall", "preinstall", "install"]
action = { name = "{item}", command = "{pm} run {item}" }
```

| source | items |
| --- | --- |
| `{ json = "file", keys = "dotted.path" }` | the keys of an object in a JSON file |
| `{ json = "file", values = "dotted.path" }` | the entries of an array of strings |
| `{ file = "Makefile", regex = "^([A-Za-z0-9_.-]+):" }` | the first capture group of each matching line |
| `{ command = "just --summary", split = " " }` | a command's output, split by lines (or `split`); 2 seconds at most |

`json` and `file` sources are read each time. A `command` source's items are kept until a file
in `watch = [...]` changes (a minute, when there's no `watch`).

### Actions from the backend

When a list needs real code, the backend answers the `actions` request (see
[The backend](#the-backend)) with buttons in the same shape as `[[action]]`. The Toolkit
doesn't wait for them: the rest of it shows at once, and the backend's buttons join as soon as
it answers.

```toml
[backend]
command = "node backend.js"
actions = true              # ask the backend for this project's buttons
watch = ["justfile"]        # ask again when these change (and on thumbdeck.actions.refresh())
```

## Settings and tab setup

A plugin can have **settings** (one set for the whole app, in Settings › Plugins) and each tab
has a **setup** (one per tab, per project, from the tab's `S` key). Both are forms thumbdeck
draws from the manifest, so they look and behave like the rest of the app:

```toml
[[settings]]
key = "minutes"
label = "Focus length (minutes)"
type = "number"
default = 25

[[tab.setup]]               # belongs to the [[tab]] above it
key = "folders"
label = "Folders to look in"
type = "folders"
default = ["logs", "log"]
help = "Relative to the project folder"
```

| type | value | drawn as |
| --- | --- | --- |
| `text` | string | a text field (`multiline = true`: a text area) |
| `number` | number | a number field (`min`, `max`) |
| `bool` | boolean | a checkbox |
| `choice` | string | a list to pick from: `choices = ["a", "b"]` or `[{ value = "a", label = "A" }]` |
| `list` | array of strings | one text field per entry, with add and remove |
| `folder`, `file` | string | a text field with a Browse button |
| `folders`, `files` | array of strings | a list of those |
| `json` | any JSON value | a text area with JSON (for values a form can't hold: a list of rules, …) |

Every field takes `label`, `default` and `help`. Every tab setup also has a `title` field,
added by thumbdeck. A setup saved by an older version of the plugin gets new fields' defaults.
If the form can't express what a tab needs, the tab can take the setup into its own hands:
`[[tab]] setup_page = "setup.html"` shows that page in thumbdeck's setup dialog instead of the
form (thumbdeck adds Cancel and Remove), and it saves with `thumbdeck.setup.save(value)`; the
page has the title field too. Its `[[tab.setup]]` fields still give the defaults and fill in
what an older setup lacks (`json` fields for nested values).

## The page API (`window.thumbdeck`)

Every frame has `window.thumbdeck` before its scripts run. Everything that talks to thumbdeck
returns a promise; errors are thrown as `Error`s with a plain message. Types and doc comments
are in the npm package `@thumbdeck/plugin` (types only, nothing to bundle):

```ts
/// <reference types="@thumbdeck/plugin" />
const td = window.thumbdeck;
```

Paths may be absolute, start with `~`, or be relative: relative to the project folder in
project-scope frames, to the plugin's data folder otherwise.

### Where am I

```ts
td.context: {
  plugin: { id: string; version: string; folder: string; dataFolder: string };
  surface: "tab" | "panel" | "page" | "view";
  id: string;                    // the tab/panel/page id from the manifest
  project: Project | null;       // fixed for tabs and project panels; the selected one otherwise
  data?: unknown;                // a page's data from openPage
  api: number;                   // the API version thumbdeck speaks to this plugin
  thumbdeck: string;             // thumbdeck's version
}

interface Project { path: string; name: string; branch: string | null; remote: string | null }

td.projects.selected(): Promise<Project | null>
td.projects.list(): Promise<Project[]>          // every project in the list, in its order
```

### Setup and settings

```ts
td.setup.get(): Promise<object>        // this tab's setup, every field filled in
td.setup.edit(): void                  // open the setup form
td.setup.save(value: object): Promise<void>   // only from a setup_page
td.settings.get(): Promise<object>     // the plugin's settings, every field filled in
```

### Storage

Small JSON values that survive restarts, kept by thumbdeck per plugin:

```ts
td.storage.get(key, { scope?: "app" | "project" }): Promise<any>   // undefined when unset
td.storage.set(key, value, { scope? }): Promise<void>
td.storage.remove(key, { scope? }): Promise<void>
```

`scope` defaults to `"project"` in project-scope frames and `"app"` elsewhere. For more than a
few hundred KB, write files in `context.plugin.dataFolder`.

### Files

```ts
td.fs.read(path, { encoding?: "utf8" | "base64"; start?: number; end?: number }): Promise<string>
td.fs.write(path, text): Promise<void>
td.fs.stat(path): Promise<{ size: number; modified: number; dir: boolean } | null>   // null: missing
td.fs.list(folder, { pattern?: "*.log"; recursive?: boolean }): Promise<Entry[]>
td.fs.watch(path, (change: { path: string; kind: "changed" | "added" | "removed" }) => void): Unsubscribe
```

`start` / `end` read a byte range, for following big files (read from the last size on each
`changed`).

### Running commands

Three ways, for three jobs:

```ts
// Capture the output, show nothing (git status, gh pr list, …)
td.exec(command: string | string[], { cwd?, env?, input?, timeout? }):
  Promise<{ code: number; stdout: string; stderr: string }>

// Run it like a Toolkit button: a tab with its output, in Running, a notification at the end
td.run(command: string, { label, cwd? }): Promise<Run>
interface Run { id: number; onOutput(fn: (line, stderr) => void); onExit(fn: (code) => void); stop(); done: Promise<number> }

// Type it into a window of the project's tmux session (show: also switch the terminal
// attached to the session to that window)
td.tmux(command: string, { window: string; show?: boolean }): Promise<string>   // thumbdeck's short message
```

A string command runs through the shell with your login shell's environment (PATH as in your
terminal); an array runs the program directly, with no shell quoting to worry about. `cwd`
defaults to the project folder. `exec` has a 30-second default `timeout`.

`run` adds a tab with the command's output at the bottom of the center but doesn't switch to it:
your page stays in front, and gets the output through `onOutput`.

### The window

```ts
td.ui.say(text, { error? }): void            // a short message in the status line
td.ui.notify(title, body?): void             // a desktop notification
td.ui.confirm(question, { yes?, no? }): Promise<boolean>   // thumbdeck's own dialog
td.ui.openUrl(url): void                     // in the browser
td.ui.openPage(id, data?): void              // one of this plugin's [[page]]s
td.ui.close(): void                          // a page: close it
td.ui.openReview({                           // thumbdeck's review page for a diff
  title, subtitle?,
  diff: string | (() => Promise<string>),    // a function: read again on r
  viewedKey,                                 // where files marked viewed are remembered (per plugin)
  startFile?,
}): void
td.ui.badge(text | number | null): void      // next to the tab's or panel's title (null: none)
td.ui.status(text | null): void              // the view: next to its name in the Plugins pane
td.ui.mood(signal, value): void              // tell the avatar what's going on (below)
td.escape(text): string                      // for putting text into HTML
```

### The avatar

The character in the top bar shows one mood at a time, the most urgent first. thumbdeck feeds
it what it sees itself (runs, their failures, updates, how late it is); plugins can add these
signals, and `null` takes one back:

| signal | value | the avatar |
| --- | --- | --- |
| `waiting` | text: who waits, e.g. `"Claude in thumbdeck"` | waits for you (right after failed and done runs) |
| `working` | text: who works | thinks |
| `reading` | `true` | reads |
| `review` | a count | has things for you to review |

A signal belongs to the frame (or backend) that sent it, and goes away with it. The avatar
adds up what several plugins send (e.g. two Logs tabs reading).

### Toolkit

```ts
td.actions.refresh(): void                   // ask the backend for this project's buttons again
```

### Events

```ts
td.on(event, fn): Unsubscribe
```

| event | when | gets |
| --- | --- | --- |
| `shown`, `hidden` | the frame is shown or hidden | — |
| `project` | another project is selected (app-scope frames) | `Project` |
| `keyboard` | the frame gets or loses the keyboard | `boolean` |
| `key` | one of its declared keys is pressed (see [Keys](#keys)) | `{ action, key }` |
| `setup`, `settings` | its setup or settings were saved | the new value |
| `run` | a Toolkit action or `td.run` in its project ended | `{ id, label, code }` |
| `focus` | the thumbdeck window gains or loses focus | `boolean` |

### Keyboard

```ts
td.keys.use(map: string): void     // switch to another of its keymaps (a mode: list → log)
td.keys.take(): void               // ask for the keyboard (e.g. on a click)
td.keys.release(): void            // give it back to thumbdeck
```

### The backend

```ts
td.backend.call(method, params?): Promise<any>
td.backend.on(event, fn): Unsubscribe        // events the backend sends
```

## Keys

Keys are declared in the manifest, one **keymap** per place and mode. thumbdeck checks them
when the plugin loads, draws `?` help and the status line from them, and sends the frame the
**action** of a key, never the key itself:

```toml
[keys.files]                     # a keymap; the first one of a surface is its starting one
name = "LOGS"                    # shown in the status line while it has the keyboard
surface = "tab:logs"             # tab:<id>, panel:<id>, page:<id> or view
bindings = [
  { keys = ["j", "ArrowDown"], action = "down", does = "down" },
  { keys = ["k", "ArrowUp"], action = "up", does = "up" },
  { keys = ["l", "Enter"], action = "open", does = "open the log" },
  { keys = ["r"], action = "refresh", does = "look for logs again" },
  { keys = ["/"], action = "search", does = "search" },
]

[keys.log]
name = "LOG"
surface = "tab:logs"
bindings = [ … ]
```

```js
td.on("key", ({ action }) => {
  if (action === "open") openSelected();
});
td.keys.use("log");   // now [keys.log] applies
```

**Key names**: `j`, `G`, `?`, `Enter`, `Space`, `Escape`, `ArrowDown`, `Shift+Tab`, `Ctrl+d`
(letters and symbols already carry Shift: `G`, not `Shift+g`).

**The same key means the same thing everywhere.** Where a plugin uses these keys, they must
run these actions (a plugin that breaks one isn't loaded, and the check says which):

| key | action | | key | action |
| --- | --- | --- | --- | --- |
| `j` | down | | `v` | review |
| `k` | up | | `o` | outside |
| `g` | first | | `r` | refresh |
| `G` | last | | `q`, `Escape` | leave |
| `d` | page-down | | `S` | setup |
| `u` | page-up | | `?` | help |
| `l` | open | | `Tab` / `Shift+Tab` | next-list / previous-list |

**thumbdeck keeps** `1`–`9` (tabs), `z` (wide) and `Ctrl+p` (the Plugins pane) even while a
plugin has the keyboard.
`?` always shows help and `S` always opens the setup; a plugin doesn't need to bind them.
`q` / `Escape` give the keyboard back unless the plugin binds them (to close something of its
own first).

A click in the frame gives it the keyboard (like `td.keys.take()`), and keys pressed with the
focus in the frame go through thumbdeck the same way.

**Typing**: while an `input` or `textarea` in the frame has focus, keys go to it as usual and
no actions are sent; `Esc` leaves the field. For anything else that needs raw keys (a key-driven game, a terminal),
listen to `keydown` in the frame: keys that aren't in the current keymap reach the frame's own
`keydown` listeners while it has the keyboard.

## Looking like thumbdeck

Every frame gets thumbdeck's colors and fonts as CSS variables, and a small stylesheet that
makes plain HTML look native. Both follow thumbdeck's look, so a plugin that uses them keeps
fitting in if that look changes.

```css
--bg-dim --bg0 --bg1 --bg2 --bg3      /* backgrounds, darkest to lightest */
--fg --grey --grey-dim                /* text */
--red --orange --yellow --green --aqua --blue --purple
--mono --sans                         /* fonts */
```

The kit styles `body`, headings, links, `button`, `input`, `select`, `textarea`, `table`,
`pre` and `code` without any classes, and adds:

| class | for |
| --- | --- |
| `td-list` | a list you move through with j / k; mark the current item with `aria-selected="true"` |
| `td-muted` | secondary text |
| `td-badge` | a small count or label (`td-badge red`, `green`, …) |
| `td-empty` | "nothing here" messages |
| `td-error` | an error message |
| `td-toolbar` | a row of buttons and fields at the top |

To start from nothing, put `<meta name="thumbdeck-kit" content="off">` in the page; the
variables stay.

## The backend

A backend is any program that reads JSON requests on stdin and writes JSON answers on stdout,
one per line. Use it for work a page can't do well: parsing big files, keeping a connection,
watching things while no page is shown, working out Toolkit buttons.

```toml
[backend]
command = "node backend.js"   # run in the plugin folder, with your login shell environment
install = "npm ci --omit=dev" # optional: run after installing and after each update (not for a
                              # linked folder: run it yourself there)
actions = true                # optional: answers `actions`
watch = ["justfile"]          # optional: when to ask for actions again
autostart = true              # optional: start with thumbdeck, not when first needed (for a
                              # backend that watches something, e.g. for the avatar)
```

### The messages

A request has an `id`; its answer has the same `id` and either a `result` or an `error`.
A message without an `id` is an event (nothing answers it). Both sides can send both.

```json
→ {"id": 1, "method": "initialize", "params": {"api": 1, "thumbdeck": "0.5.0", "folder": "…", "dataFolder": "…", "settings": {}}}
← {"id": 1, "result": {}}
→ {"id": 2, "method": "count", "params": {"project": {"path": "/home/me/dev/app", "name": "app"}}}
← {"id": 2, "result": 3}
← {"method": "event", "params": {"name": "tick", "data": {"left": 1480}}}
```

What thumbdeck sends:

| method | when | answer |
| --- | --- | --- |
| `initialize` | first: `{ api, thumbdeck, folder, dataFolder, settings }` | `{}` |
| `actions` | a project is shown (`actions = true`), or a watched file changed | `[{ name, command, description?, confirm?, tmux? }]` |
| `settings` (event) | the settings were saved | — |
| `shutdown` | thumbdeck quits; exit within 2 seconds | `{}` |
| anything else | a page called `td.backend.call(method, params)` | whatever the page expects |

A page's `td.backend.call(method, params)` sends `params` (an object, or nothing) with the
frame's project added as `params.project`: `{ path, name }`, or null for app-wide frames.

What the backend can send thumbdeck:

| method | does |
| --- | --- |
| `event` (event) | `{ name, data }` to every frame of the plugin listening with `td.backend.on(name)` |
| `ui.say`, `ui.notify`, `ui.badge`, `ui.status`, `ui.mood` | as the page API (a badge goes on all the plugin's tabs) |
| `actions.refresh` (event) | ask for Toolkit buttons again |
| `storage.get`, `storage.set`, `storage.remove` | as the page API; `project` (a folder) in params for project scope |

An error answer is `{"id": 2, "error": {"message": "No such log"}}`; the page's
`td.backend.call` throws it as an `Error` with that message.

### Its life

- thumbdeck starts the backend when it's first needed (a page calls it, or it answers
  `actions`), or with thumbdeck when it has `autostart`, and keeps one running per plugin,
  for every project and frame.
- Its stderr goes to the plugin's log. So does anything that isn't a JSON line on stdout.
- If it exits, it's started again at the next call; after three crashes within a minute it
  isn't, and calls say so (its log is in Settings). Turning the plugin off and on, or updating
  it, gives it a fresh start.
- Turning the plugin off, updating or removing it stops its backend; saving its settings sends
  the `settings` event.

### The Node helper

`@thumbdeck/backend` does the reading, writing and dispatching:

```js
import { serve } from "@thumbdeck/backend";

serve({
  async count({ project }) {
    return (await findTodos(project.path)).length;
  },
  actions({ project }) {
    return [{ name: "test", command: "just test" }];
  },
}, (tb) => {
  setInterval(() => tb.event("tick", { at: Date.now() }), 1000);   // tb: thumbdeck's side
});
```

## Installing, versions and updates

**Settings** (`,`, or **+ › Settings…**) **› Plugins › Add a plugin** takes:

- a git URL: `https://github.com/x/thumbdeck-pomodoro`
- a folder inside a repository holding several plugins: `https://github.com/Nozeren/thumbdeck-plugins#plugins/django`
- a folder on disk, linked rather than copied, for developing (reloads when files change)

thumbdeck installs the **latest release tag** of the plugin (the default branch when there are
none), keeps it in `~/.local/share/thumbdeck/plugins/<id>/` (`$XDG_DATA_HOME/thumbdeck` when
that's set), each plugin in a clone of its own, and shows its README, what it adds
and its version. Tags are `v1.2.0`, or `<id>-v1.2.0` in a repository with several plugins; the
tag's `version` in `plugin.toml` must match it.

On start, thumbdeck checks installed plugins for newer tags and marks them in Settings (↑);
you update them from there. Nothing updates by itself. A plugin without tags follows its default
branch: a newer commit there is its update.

A plugin with any problem in its manifest isn't loaded; Settings shows each problem in a plain
sentence (`plugin.toml line 5: there's no key nmae (did you mean name?)`).

**Trust**: a plugin runs with your user's rights, like an editor plugin: its pages can read and
write your files and run commands, and its backend is a program on your machine. thumbdeck says
so when you install one. Install plugins you trust.

**The catalog**: `catalog.toml` in [thumbdeck-plugins](https://github.com/Nozeren/thumbdeck-plugins)
lists the official plugins; thumbdeck's first run offers them, and Settings › Plugins › Add
can browse it.

```toml
[[plugin]]
id = "git"
source = "https://github.com/Nozeren/thumbdeck-plugins#plugins/git"
description = "The repo at a glance: changes, commits, branches and stashes (read-only)"
```

**Turning off** a plugin keeps it installed with its settings; **removing** it deletes its
folder, settings, storage and tabs.

## API versions

`api` in `plugin.toml` is the version of the page API, the backend messages and the manifest
together. thumbdeck speaks a range of versions (this draft: only 1):

- **Adding** things (a new function, event, manifest key or field type) keeps the version.
  A plugin that uses something newer than the thumbdeck it runs in gets a clear error at that
  call, and can check `td.context.thumbdeck` first.
- **Changing or removing** something raises the version. thumbdeck keeps speaking older
  versions to older plugins for as long as it can; when it drops one, those plugins show as
  "needs an update" in Settings.
- A plugin for a **newer** version than thumbdeck knows isn't loaded; Settings says to update
  thumbdeck.

## Writing and testing a plugin

1. Start from `template/` in thumbdeck-plugins (a manifest, a tab page and a backend, with
   comments), or from one of the examples.
2. Add it from its folder: **Settings › Plugins › Add › From a folder…**. Saving any of its
   files reloads it (its frames, and its backend if a backend file changed).
3. **Its log** (Settings › Plugins › *the plugin* › Log): its pages' `console` output and
   uncaught errors (including failed API calls nobody caught), and its backend's stderr. In a
   dev build of thumbdeck they're printed to its terminal too.
4. **Devtools**: Settings › Plugins › *the plugin* › Inspect opens the web inspector (for the
   whole window: pick the plugin's frame in it).
5. **Check it**: `thumbdeck plugin check <folder>` reads the manifest, checks every field, the
   keys against the rules above, the `api` version and that every page and file it names
   exists. It prints what's wrong in plain sentences and exits non-zero. In CI, where
   thumbdeck isn't installed, `npx @thumbdeck/check <folder>` does the same checks. Settings
   runs them too, on every plugin it loads.

## Examples

thumbdeck-plugins has these, smallest first:

| example | shows |
| --- | --- |
| `examples/hello` | a manifest-only plugin: detect and two actions |
| `examples/todos` | a tab page using `td.exec`, a `td-list` and keys |
| `examples/pomodoro` | a view with a status, an app panel, a page, settings, storage, notifications |
| `examples/tasks` | a backend in Node answering `actions` and a page's calls |
| `plugins/git` | a real tab: several keymaps, the review page |
| `plugins/logs` | the most complete: a Node backend, its own setup page, live tail, Svelte built with Vite |
| `plugins/agents` | a backend that starts with thumbdeck and tells the avatar what's going on |
