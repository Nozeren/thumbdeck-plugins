// The Agents backend: reads Claude Code's files for the tab, and tells the avatar when a
// Claude Code session is working or waiting for you (it starts with thumbdeck for that).
import { basename, join } from "node:path";
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../packages/backend/index.js";
import { claudeHome, listDefined, listSessions, listSkills, live, sessionsDir, startCommand, transcript } from "./claude.js";

const home = claudeHome();
const seen = new Map(); // what was read of each transcript, so growing ones are read from where they were

serve({
  /** The project's sessions, and the subagents and skills it (and you) have */
  list({ project, userAgents = true }) {
    if (!project) throw new Error("the Agents tab needs a project");
    const dir = sessionsDir(home, project.path);
    const defined = listDefined(join(project.path, ".claude/agents"), "project");
    const skills = listSkills(join(project.path, ".claude/skills"), "project");
    if (userAgents) {
      defined.push(...listDefined(join(home, "agents"), "user"));
      skills.push(...listSkills(join(home, "skills"), "user"));
    }
    return { sessions: listSessions(dir, seen), defined, skills, dir };
  },
  /** A session's or subagent's conversation */
  transcript: ({ file }) => transcript(file),
  /** The command that starts Claude Code as an agent or with a skill */
  command: ({ kind, agent, task = "" }) => startCommand(kind, agent, task),
}, (tb) => {
  // The avatar: a session waiting for you comes first, then one working
  let last = "";
  const look = () => {
    const now = live(home);
    const who = (status) => {
      const s = now.find((x) => x.status === status);
      return s ? `Claude in ${basename(s.cwd) || s.cwd}` : null;
    };
    const signals = { waiting: who("waiting"), working: who("busy") };
    const key = JSON.stringify(signals);
    if (key === last) return;
    last = key;
    tb.mood("waiting", signals.waiting);
    tb.mood("working", signals.working);
  };
  look();
  setInterval(look, 4000);
});
