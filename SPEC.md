# Toolkit pack format (draft, version 1)

A **toolkit pack** tells thumbdeck *when it applies* to a project and *which buttons it adds*
to that project's Toolkit. Packs are plain TOML files; they can only suggest commands, which
run when you press their button. Nothing in a pack runs when thumbdeck loads it, except
`source.command` (see [Generated actions](#generated-actions)), which needs you to trust the pack.

One pack per file, in `packs/<id>.toml`. The file name is the pack's **id** (`django.toml` →
`django`), used for overriding and for hiding actions.

```toml
schema = 1                      # version of this format
name = "Django"                 # shown as the group title in the Toolkit
description = "manage.py commands"
icon = "django"                 # a project-type icon (see Icons); optional
priority = 50                   # order among packs that apply; lower comes first (default 50)
requires = ["python"]           # other packs that apply along with this one (see Dependencies)

[detect]                        # when the pack applies (see Detection)
files = ["manage.py"]

[[action]]                      # one button (see Actions)
name = "runserver"
command = "{python} manage.py runserver"
```

## Detection

`[detect]` decides whether a pack applies to a project. Every condition you write must match
(AND); a pack without `[detect]` applies to every project. Paths are relative to the project
folder and may use globs (`*`, `**`, `?`).

| key | matches when |
| --- | --- |
| `files = ["a", "b"]` | **any** of these exist |
| `all_files = ["a", "b"]` | **all** of these exist |
| `not_files = ["a"]` | **none** of these exist |
| `json = [{ file = "package.json", key = "dependencies.react" }]` | each file exists and contains the key (dotted path); add `value = "..."` to also compare the value |
| `git_remote = "github.com[:/]acme/"` | the `origin` remote URL matches this regular expression (for packs about one project or organisation) |
| `path = "~/work/**"` | the project folder matches this glob |

Example, a pack that only applies to one repository:

```toml
[detect]
git_remote = "github.com[:/]Nozeren/athens-buses(\\.git)?$"
```

## Actions

Each `[[action]]` is one button.

| key | | meaning |
| --- | --- | --- |
| `name` | required | button label; unique within the pack |
| `command` | required | shell command, run in the project folder with your login shell's environment; may use [variables](#variables) |
| `description` | | tooltip text |
| `confirm` | | `true` asks before running (for deploys, resets, …) |
| `when` | | a `[detect]`-style table: the button only shows when it also matches, e.g. `when = { files = ["pytest.ini"] }` |

An action's id is `<pack id>:<name>` (e.g. `django:migrate`); that's what hiding an action in
thumbdeck refers to.

## Variables

Commands can use `{name}`. Built in:

| variable | value |
| --- | --- |
| `{project}` | the project folder's name |
| `{path}` | the project folder's full path |
| `{python}` | `.venv/bin/python` or `venv/bin/python` when the project has one, otherwise `python3` |
| `{pm}` | the JavaScript package manager, from the lockfile: `pnpm`, `yarn`, `bun` or `npm` |
| `{item}` | in generated actions: the current item (see below) |

A pack can define its own in `[vars]`; a value may use the built-ins:

```toml
[vars]
manage = "{python} manage.py"

[[action]]
name = "migrate"
command = "{manage} migrate"
```

## Generated actions

Some toolkits depend on the project's own files: one button per npm script, per Makefile
target, … A `[[generate]]` table turns a list of items into actions: `source` says where the
list comes from, `action` is the template for each item (it can use `{item}`), and `skip`
leaves items out.

```toml
[[generate]]
source = { json = "package.json", keys = "scripts" }    # the keys of that object
skip = ["prepare", "postinstall", "preinstall", "install"]
action = { name = "{item}", command = "{pm} run {item}" }
```

Sources, from safest to most powerful:

| source | items |
| --- | --- |
| `{ json = "file", keys = "dotted.path" }` | the keys of an object in a JSON file |
| `{ json = "file", values = "dotted.path" }` | the entries of an array (strings) in a JSON file |
| `{ file = "Makefile", regex = "^([A-Za-z0-9_.-]+):" }` | first capture group of every matching line |
| `{ command = "just --summary", split = " " }` | output of a command (split by lines, or `split`) |

A `command` source **runs when thumbdeck reads the pack**, so thumbdeck asks you to trust a
pack before using one (once per pack and version). It runs in the project folder with a
2-second time limit; its result is cached until one of the files listed in `watch` changes:

```toml
[[generate]]
source = { command = "just --summary", split = " " }
watch = ["justfile", "Justfile"]
action = { name = "{item}", command = "just {item}" }
```

## Dependencies

`requires = ["python"]` lists packs that come **along** with this one: when this pack applies,
the required packs apply too, even if their own `[detect]` doesn't match. Their buttons show
(under their own names) and their `[vars]` can be used in this pack's commands. Requirements
of requirements are followed as well.

- A required pack that can't be found disables the pack that needs it (thumbdeck says why).
- Circular requirements (`a` needs `b`, `b` needs `a`) are an error; neither pack loads.
- If both packs define the same variable, the pack that requires the other wins.

## tmux windows

When thumbdeck opens a project in tmux for the first time, it creates the session with Neovim
in window 1 and a shell in window 2. Packs that apply can add more windows after those:

```toml
[[tmux.window]]
name = "server"                 # window name
command = "{manage} runserver"  # typed into a shell in the project folder (venv active)
run = false                     # false: typed but not started, you press Enter (default true)
when = { files = ["manage.py"] }  # optional, like for actions
```

- The command is typed into a shell, so the window stays open (at a prompt) when it stops.
- Windows are added in `priority` order of their packs, and only when the session is created;
  an existing session is never changed.
- Prefer `run = false` for anything long-running or heavy (servers, watchers, containers):
  opening a project shouldn't start them by surprise.

## Where packs come from

thumbdeck reads packs from, in order (a later pack with the same id replaces an earlier one):

1. **built in**: the packs in this repository, bundled with the app
2. **this repository**, when it's cloned to `~/.local/share/thumbdeck/toolkits` (newer than the
   bundled copy)
3. **your own**: `~/.config/thumbdeck/toolkits/*.toml`, for private packs (e.g. about your
   work projects) that never leave your machine

Your custom actions and hidden actions in thumbdeck's settings apply on top of all packs.

## Icons

`icon` picks one of thumbdeck's project-type icons: `django`, `python`, `android`, `node`,
`tauri`, `rust`, `go`, `nvim`, `folder`. When several packs apply, the one with the lowest
`priority` that has an icon decides the project's icon.
