// Builds every plugin that has a vite.config.js (its page from Svelte, into its dist/ folder).
// The built files are committed: installing a plugin never needs a build.
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";

const only = process.argv[2];
// plugins/<kind>/<id> and examples/<id>
const folders = [
  ...readdirSync("plugins").flatMap((kind) => readdirSync(join("plugins", kind)).map((id) => join("plugins", kind, id))),
  ...readdirSync("examples").map((id) => join("examples", id)),
];
for (const folder of folders) {
  const config = join(folder, "vite.config.js");
  if (!existsSync(config) || (only && !folder.endsWith(`/${only}`))) continue;
  console.log(`building ${folder}`);
  await build({ configFile: config, logLevel: "warn" });
}
