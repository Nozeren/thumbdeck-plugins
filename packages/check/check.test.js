import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFolder, checkManifest } from "./index.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const MINIMAL = 'id = "hello"\nname = "Hello"\nversion = "1.0.0"\napi = 1\n';
const dir = mkdtempSync(join(tmpdir(), "thumbdeck-check-"));
const check = (text) => checkManifest(text, dir);

test("every plugin, example and the template in this repo is fine", () => {
  const kinds = readdirSync(join(repo, "plugins")).map((k) => join(repo, "plugins", k));
  const folders = [...kinds, join(repo, "examples")].flatMap((g) => readdirSync(g).map((n) => join(g, n)));
  for (const f of [...folders, join(repo, "template")]) assert.deepEqual(checkFolder(f).problems, [], f);
});

test("who it is", () => {
  const p = check('id = "My Plugin"\nname = " "\nversion = "1.0"\napi = 2\n');
  assert.equal(p.length, 4, JSON.stringify(p));
  assert.match(p[0], /lowercase/);
  assert.match(p[3], /update thumbdeck/);
  assert.match(check('id = "a"\nname = "A"\nversion = "1.0.0"\napi = 0\n')[0], /isn't a plugin API/);
  assert.deepEqual(check('id = "a"\nname = "A"\nversion = "1.0.0-beta.1"\napi = 1\n'), []);
  assert.deepEqual(check('id = "x"\n'), ["plugin.toml: it needs name", "plugin.toml: it needs version", "plugin.toml: it needs api"]);
});

test("typos say which key was meant", () => {
  assert.deepEqual(check(`${MINIMAL}nmae = "x"\n`), ["plugin.toml: there's no key nmae (did you mean name?)"]);
  assert.match(check(`${MINIMAL}[detect]\nfile = ["x"]\n`)[0], /no key file \(did you mean files\?\)/);
  assert.match(check(`${MINIMAL}colour = "x"\n`)[0], /no key colour here \(the keys are id, name,/);
  assert.match(check("id = \n")[0], /^plugin.toml line 1:/);
});

test("pages and files must be there and inside the plugin", () => {
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "tab.html"), "");
  assert.deepEqual(check(`${MINIMAL}[[tab]]\nid = "t"\nname = "T"\npage = "tab.html"\n`), []);
  const p = check(`${MINIMAL}[[tab]]\nid = "t"\nname = "T"\npage = "nope.html"\n[[panel]]\nid = "p"\nname = "P"\npage = "../x.html"\n[view]\nname = "V"\npage = "/etc/passwd"\n`);
  assert.equal(p.length, 3, JSON.stringify(p));
  assert.match(p[0], /isn't there/);
  assert.match(p[1], /inside/);
  assert.match(check(`${MINIMAL}[detect]\nicon = "whale"\n`)[0], /neither an .svg/);
});

test("fields, surfaces and keys", () => {
  const p = check(`${MINIMAL}[[tab]]\nid = "t"\nname = "T"\npage = "tab.html"\n[[tab.setup]]\nkey = "title"\nlabel = "T"\ntype = "text"\n`
    + `[[tab.setup]]\nkey = "c"\nlabel = "C"\ntype = "choice"\n[[settings]]\nkey = "n"\nlabel = "N"\ntype = "number"\ndefault = "five"\n`
    + `[keys.list]\nname = "T"\nsurface = "tab:nope"\nbindings = [{ keys = ["j", "3"], action = "jump", does = "x" }]\n`);
  for (const want of ["thumbdeck's own field", "has no choices", "default doesn't fit", "3 is thumbdeck's", "means down", "isn't one of the plugin's"]) {
    assert.ok(p.some((x) => x.includes(want)), `${want}: ${JSON.stringify(p)}`);
  }
});

test.after(() => rmSync(dir, { recursive: true }));
