import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compare, mask, missingLines, parse } from "./env.js";

const data = (f) => readFileSync(new URL(`./testdata/${f}`, import.meta.url), "utf8");

test("parse: export, quotes, comments, several lines", () => {
  const ex = parse(data(".env.example"));
  assert.deepEqual(ex.map((e) => e.key), ["DATABASE_URL", "SECRET_KEY", "DEBUG", "SENTRY_DSN", "MAIL_FROM", "REDIS_URL"]);
  assert.equal(ex.find((e) => e.key === "MAIL_FROM").value, "Shop <noreply@example.com>");
  assert.equal(ex.find((e) => e.key === "SENTRY_DSN").value, "");
  assert.equal(ex.find((e) => e.key === "DATABASE_URL").line, 2);
  const env = parse(data(".env"));
  assert.equal(env.find((e) => e.key === "PRIVATE_KEY").value, "-----BEGIN KEY-----\nabc\n-----END KEY-----");
  assert.equal(env.find((e) => e.key === "LOCAL_ONLY").line, 8, "after a value on several lines");
  assert.equal(parse("A=1 # note\nB=a#b\n# C=3\n").map((e) => `${e.key}=${e.value}`).join(), "A=1,B=a#b");
});

test("compare with the example", () => {
  const rows = compare(parse(data(".env.example")), parse(data(".env")));
  const status = Object.fromEntries(rows.map((r) => [r.key, r.status]));
  assert.deepEqual(status, {
    DATABASE_URL: "ok", SECRET_KEY: "example", DEBUG: "empty", SENTRY_DSN: "ok",
    MAIL_FROM: "missing", REDIS_URL: "missing", PRIVATE_KEY: "extra", LOCAL_ONLY: "extra",
  });
  assert.deepEqual(missingLines(rows), ['MAIL_FROM="Shop <noreply@example.com>"', "REDIS_URL=redis://localhost:6379"]);
});

test("mask gives nothing away", () => {
  assert.equal(mask("postgres://app:s3cr3t@db.internal:5432/app"), "postgres://db.internal…");
  assert.equal(mask("a-long-made-up-api-token-value"), "••••••••••••");
  assert.equal(mask("abc"), "••••");
  assert.equal(mask("true"), "true");
  assert.equal(mask("8080"), "8080");
  assert.equal(mask(""), "(empty)");
});
