// The Logs backend: finds a project's log files and reads them into entries and sections
// (logs.js), for the tab.
import { statSync } from "node:fs";
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../../packages/backend/index.js";
import { list, open, problems, summary } from "./logs.js";

serve({
  /** The log files in the setup's folders, newest first, and the folders that aren't there */
  list({ project, setup }) {
    if (!project) throw new Error("the Logs tab needs a project");
    return list(project.path, setup);
  },
  /** A log: its entries, its outline (sections), its size */
  open: ({ file, setup }) => open(file, setup),
  /** At a glance, for the file list */
  summary: ({ file, setup }) => summary(file, setup),
  /** A log's size, to notice it growing (live tail); null when it's gone */
  size({ file }) {
    try {
      return statSync(file).size;
    } catch {
      return null;
    }
  },
  /** What's wrong with a setup (shown in its setup form) */
  check: ({ setup }) => problems(setup),
});
