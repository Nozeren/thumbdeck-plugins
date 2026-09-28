// Builds every plugin that has a vite.config.js (its page from Svelte, into its dist/ folder).
// The built files are committed: installing a plugin never needs a build.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";

const only = process.argv[2];
for (const group of ["plugins", "examples"]) {
  for (const name of readdirSync(group)) {
    const config = join(group, name, "vite.config.js");
    if (!existsSync(config) || (only && only !== name)) continue;
    console.log(`building ${group}/${name}`);
    await build({ configFile: config, logLevel: "warn" });
  }
}
