# Agents

Claude Code in a tab, for the project:

- **Agents** and **Skills**: the subagents (`.claude/agents/*.md`) and skills
  (`.claude/skills/<name>/SKILL.md`) the project has, and yours in `~/.claude` (the tab's setup
  can leave those out). Open one to read it and start Claude Code on a task with it, in the
  project's `claude` tmux window.
- **Sessions**: the project's Claude Code sessions, most recent first: working, idle or quiet,
  the model, tokens and cost, and the subagents each one started. Open one to read its
  conversation (a tool call's details with Enter; a subagent's conversation from its call).

It also tells thumbdeck's avatar when a Claude Code session, in any project, is working or
waiting for you.

It reads Claude Code's own files (`~/.claude`, or `$CLAUDE_CONFIG_DIR`). Their format isn't
documented, so it reads them carefully and skips what it doesn't know. Its backend needs
[Node](https://nodejs.org).

The tab's page is built from `ui/` (Svelte) into `dist/`: `npm run build` in the plugins repo.
