import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, idle, local, relative } from "./utils.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const labels = (r) => r.map((x) => x.label);
const get = (r, label) => r.find((x) => x.label === label)?.value;
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("a JWT: header, payload and its times", () => {
  const exp = Math.floor(NOW / 1000) - 3600;
  const token = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "42", exp })}.c2lnbmF0dXJl`;
  const r = analyze(token, NOW);
  assert.equal(JSON.parse(get(r, "JWT payload")).sub, "42");
  assert.match(get(r, "JWT exp"), /1h ago \(expired\)$/);
  assert.ok(labels(r).includes("note"));
});

test("timestamps, seconds and milliseconds, and dates back", () => {
  assert.equal(get(analyze("1790596800", NOW), "UTC"), "2026-09-28T12:00:00.000Z");
  assert.equal(get(analyze("1790596800000", NOW), "UTC"), "2026-09-28T12:00:00.000Z");
  assert.match(get(analyze("1790596800", NOW), "local time"), /, now$/);
  assert.equal(get(analyze("2026-09-28T12:00:00Z", NOW), "unix seconds"), "1790596800");
  assert.equal(get(analyze("2026-09-28T15:00:00+03:00", NOW), "unix ms"), "1790596800000");
});

test("JSON, URLs, base64, URL-encoding", () => {
  assert.equal(get(analyze('{"a":1,"b":[2]}'), "JSON"), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  assert.equal(get(analyze('"{\\"a\\":1}"'), "JSON inside"), '{\n  "a": 1\n}');
  const u = analyze("https://me:pw@example.com/a%20b?x=1&y=two+words#top");
  assert.equal(get(u, "URL"), "https://example.com/a b");
  assert.equal(get(u, "query"), "x = 1\ny = two words");
  assert.equal(get(u, "login"), "me:••••");
  assert.equal(get(analyze("aGVsbG8gdGhlcmU="), "base64 decoded"), "hello there");
  assert.equal(get(analyze("hello%20there%2C%20you"), "URL-decoded"), "hello there, you");
  assert.equal(get(analyze("plainword"), "base64 decoded"), undefined, "not everything is base64");
  assert.equal(get(analyze("hi there"), "as base64"), "aGkgdGhlcmU=");
  assert.equal(get(analyze("héllo"), "length"), "5 characters, 6 bytes");
  assert.deepEqual(analyze("   "), []);
});

test("times in words, idle", () => {
  assert.equal(relative(NOW - 90_000, NOW), "2m ago");
  assert.equal(relative(NOW + 3 * 86400_000, NOW), "in 3d");
  assert.equal(local(NOW, 180), "2026-09-28 15:00:00 (+03:00)");
  assert.equal(local(NOW, -150), "2026-09-28 09:30:00 (-02:30)");
  const i = idle(NOW);
  assert.equal(get(i, "now, unix seconds"), "1790596800");
  assert.match(get(i, "a new UUID"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
