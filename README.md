# thumbdeck-plugins

Plugins for [thumbdeck](https://github.com/Nozeren/thumbdeck): its tabs, its Toolkit buttons,
and everything written to add more. thumbdeck offers the official ones on its first start; in
thumbdeck, **Settings** (`,`) **› Plugins › Add a plugin** lists the ones you don't have.

- **[GUIDE.md](GUIDE.md)**: writing a plugin, step by step
- **[SPEC.md](SPEC.md)**: the whole contract (plugin.toml, the page API, keys, the backend)

## The official plugins

| plugin | adds |
| --- | --- |
| [git](plugins/git) | a tab: the repo at a glance (changes and diffs, commits, branches, stashes), read-only |
| [logs](plugins/logs) | a tab: the project's logs, with levels, search, live tail and sections |
| [agents](plugins/agents) | a tab: Claude Code sessions, subagents and skills; tells the avatar when Claude waits |
| [prs](plugins/prs) | a tab: the open pull requests that concern you (with the GitHub CLI) |
| [python](plugins/python), [django](plugins/django) | Toolkit buttons: venv, pip, pytest; manage.py |
| [npm](plugins/npm), [make](plugins/make) | Toolkit buttons: package.json scripts; Makefile targets |
| [cargo](plugins/cargo), [go](plugins/go), [gradle](plugins/gradle), [compose](plugins/compose) | Toolkit buttons for those projects |

`catalog.toml` lists them for thumbdeck. Each is installed on its own, from its folder:
`https://github.com/Nozeren/thumbdeck-plugins#plugins/git`, at its latest `git-v1.2.0` tag.

## Examples and the template

| | shows |
| --- | --- |
| [examples/hello](examples/hello) | a plugin that's only a plugin.toml: two Toolkit buttons |
| [examples/todos](examples/todos) | a tab in one HTML file: `td.exec`, keys, a setup field, a badge |
| [examples/tasks](examples/tasks) | a backend in Node: Toolkit buttons from code, a page calling it, events |
| [examples/pomodoro](examples/pomodoro) | a view in the Plugins pane, a panel, a full-window page, settings, storage |
| [template](template) | a starting point: a manifest with every part, a tab page, a backend |

## Packages

| package | for |
| --- | --- |
| [@thumbdeck/plugin](packages/plugin) | the types of `window.thumbdeck`, with docs, for your editor |
| [@thumbdeck/backend](packages/backend) | a backend in Node: the messages handled for you |
| [@thumbdeck/check](packages/check) | `npx @thumbdeck/check <folder>`: the checks thumbdeck makes, for CI |

## Working on this repository

```sh
npm install        # the build tools (Vite, Svelte) and the checker's TOML parser
npm test           # every plugin's and package's tests (node --test)
npm run build      # the plugins with a Svelte page (agents, logs) into their dist/ (committed)
npm run check      # every plugin, example and the template, as thumbdeck checks them
```

To try a change, link the folder in thumbdeck (Settings › Plugins › Add a plugin › Use a
folder…): it reloads as you save. A release is a tag named after the plugin and the version in
its plugin.toml: `git tag logs-v1.1.0`.
