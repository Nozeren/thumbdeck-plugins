// The backend: thumbdeck starts it when a page first calls it. Each function answers a call;
// what it returns (or throws) is the answer. console.log goes to the plugin's log.
// In your own plugin: `npm install @thumbdeck/backend` and import it by name.
import { serve } from "../packages/backend/index.js";

serve({
  /** td.backend.call("count", { items }) from the page; params.project is the frame's project */
  count({ items, project }) {
    return { count: items, project: project?.name };
  },
});
