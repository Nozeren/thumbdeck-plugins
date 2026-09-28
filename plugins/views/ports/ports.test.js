import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCwd, parseLsof, parsePs, parseSs, ports, projectOf } from "./ports.js";

const data = (f) => readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8");

test("ss: one row per port, processes once each", () => {
  const p = ports(parseSs(data("ss.txt")));
  assert.deepEqual(p.map((x) => x.port), [631, 1420, 5173, 8000, 8765]);
  const vite = p.find((x) => x.port === 5173);
  assert.deepEqual(vite.hosts, ["*"]);
  assert.deepEqual(vite.procs, [{ name: "node", pid: 4242 }]);
  assert.equal(vite.local, false);
  const cups = p.find((x) => x.port === 631);
  assert.deepEqual(cups.hosts, ["127.0.0.1", "::1"]);
  assert.deepEqual(cups.procs, [], "another user's process: no pid");
  assert.equal(cups.local, true);
  assert.deepEqual(p.find((x) => x.port === 8000).procs.map((x) => x.pid), [533, 568, 569]);
});

test("lsof (macOS)", () => {
  const p = ports(parseLsof(data("lsof.txt")));
  assert.deepEqual(p.map((x) => [x.port, x.hosts.join(), x.procs[0].name]), [
    [5173, "::1", "node"], [5432, "127.0.0.1", "postgres"], [7000, "*", "ControlCe"],
  ]);
});

test("command lines and folders", () => {
  const ps = parsePs("  4242 node /home/me/dev/shop/node_modules/.bin/vite\n 569 gunicorn: worker [app]\n");
  assert.equal(ps.get(4242), "node /home/me/dev/shop/node_modules/.bin/vite");
  assert.equal(ps.get(569), "gunicorn: worker [app]");
  assert.equal(parseCwd("4242 /home/me/dev/shop\n569 /srv/app\n").get(569), "/srv/app");
  const mac = parseCwd(data("cwd-lsof.txt"));
  assert.equal(mac.get(4242), "/Users/me/dev/shop");
  assert.equal(mac.get(881), "/usr/local/var/postgres");
});

test("the project a folder is in", () => {
  const projects = [{ path: "/home/me/dev", name: "dev" }, { path: "/home/me/dev/shop/", name: "shop" }, { path: "/home/me/dev/shopping", name: "shopping" }];
  assert.equal(projectOf("/home/me/dev/shop/web", projects).name, "shop", "the deepest");
  assert.equal(projectOf("/home/me/dev/shop", projects).name, "shop");
  assert.equal(projectOf("/home/me/dev/other", projects).name, "dev");
  assert.equal(projectOf("/srv", projects), null);
  assert.equal(projectOf(null, projects), null);
});
