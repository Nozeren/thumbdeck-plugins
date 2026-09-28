import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// A backend written with the helper, talked to the way thumbdeck talks to it
const program = `
import { serve } from ${JSON.stringify(fileURLToPath(new URL("./index.js", import.meta.url)))};
serve({
  add: ({ a, b }) => a + b,
  fail: () => { throw new Error("No such log"); },
  async remembered(_p, tb) { return await tb.storage.get("k"); },
  settings: (s, tb) => tb.event("saw-settings", s),
}, (tb) => { console.log("started"); tb.event("hello", 1); });
`;

test("requests, answers, errors, events and thumbdeck's own answers", async () => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await lines.next()).value);
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  assert.deepEqual(await next(), { method: "event", params: { name: "hello", data: 1 } });
  send({ id: 1, method: "initialize", params: { api: 1, settings: {} } });
  assert.deepEqual(await next(), { id: 1, result: {} });
  send({ id: 2, method: "add", params: { a: 2, b: 3 } });
  assert.deepEqual(await next(), { id: 2, result: 5 });
  send({ id: 3, method: "fail" });
  assert.deepEqual(await next(), { id: 3, error: { message: "No such log" } });
  send({ id: 4, method: "nope" });
  assert.match((await next()).error.message, /no nope in this backend/);
  send({ id: 5, method: "remembered" });
  const ask = await next();
  assert.equal(ask.method, "storage.get");
  send({ id: ask.id, result: "kept" });
  assert.deepEqual(await next(), { id: 5, result: "kept" });
  send({ method: "settings", params: { n: 2 } });
  assert.deepEqual(await next(), { method: "event", params: { name: "saw-settings", data: { n: 2 } } });
  send({ id: 6, method: "shutdown" });
  assert.deepEqual(await next(), { id: 6, result: {} });
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0);
  assert.match(stderr, /started/, "console.log went to stderr");
});
