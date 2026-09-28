// The Tasks backend: reads the project's tasks.txt ("name: command" per line; # comments)
import { readFileSync } from "node:fs";
import { join } from "node:path";
// In your own plugin: `npm install @thumbdeck/backend` and import it by name. This example
// uses the copy in this repository.
import { serve } from "../../packages/backend/index.js";

function tasks(project) {
  let text = "";
  try {
    text = readFileSync(join(project.path, "tasks.txt"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes(":"))
    .map((line) => {
      const at = line.indexOf(":");
      return { name: line.slice(0, at).trim(), command: line.slice(at + 1).trim() };
    });
}

serve({
  // Toolkit buttons for a project (asked again when tasks.txt changes)
  actions: ({ project }) => tasks(project).map((t) => ({ ...t, description: `From tasks.txt: ${t.command}` })),
  // The tab asks for the list
  list: ({ project }) => tasks(project),
}, (tb) => {
  // An event every 10 seconds, to show a backend talking to its pages
  setInterval(() => tb.event("tick", { at: new Date().toISOString() }), 10_000);
});
