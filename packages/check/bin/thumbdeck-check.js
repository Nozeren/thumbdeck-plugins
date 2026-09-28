#!/usr/bin/env node
// thumbdeck-check <folder>...: checks plugins like thumbdeck does when it loads them.
// Exits 1 when one has a problem (for CI).
import { checkFolder } from "../index.js";

const folders = process.argv.slice(2);
if (!folders.length) {
  console.error("usage: thumbdeck-check <plugin folder>...");
  process.exit(2);
}
let failed = 0;
for (const folder of folders) {
  const r = checkFolder(folder);
  if (r.problems.length) {
    failed++;
    console.log(`✗ ${folder} has ${r.problems.length} problem${r.problems.length === 1 ? "" : "s"}:`);
    for (const p of r.problems) console.log(`  - ${p}`);
  } else console.log(`✓ ${r.name} ${r.version} (${r.id}) is fine.`);
}
process.exit(failed ? 1 : 0);
