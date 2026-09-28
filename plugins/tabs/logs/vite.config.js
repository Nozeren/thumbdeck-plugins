// Builds the tab's page and its setup page (ui/, Svelte) into dist/: `npm run build` in the plugins repo
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("./ui"),
  base: "./",
  plugins: [svelte()],
  build: {
    outDir: here("./dist"),
    emptyOutDir: true,
    rollupOptions: { input: { tab: here("./ui/tab.html"), setup: here("./ui/setup.html") } },
  },
});
