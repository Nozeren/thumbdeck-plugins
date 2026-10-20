import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arrange, hexColor, matches, nextProfileDir, parseShortcuts, readLocalState, ruleFor, tenantId, withoutProfile } from "./chrome.js";

const state = JSON.parse(readFileSync(new URL("testdata/Local State", import.meta.url), "utf8"));

test("reads Chrome's profiles in its order", () => {
  const ps = readLocalState(state);
  assert.deepEqual(ps.map((p) => p.dir), ["Default", "Profile 3", "Profile 4", "Profile 5"]);
  const dev = ps[1];
  assert.equal(dev.chromeName, "Contoso dev");
  assert.equal(dev.email, "alex@contoso.com");
  assert.equal(dev.domain, "contoso.com");
  assert.equal(dev.active, true);
  assert.equal(dev.used, 1760900000000);
  assert.equal(ps[3].email, "", "a profile that isn't signed in");
  assert.deepEqual(readLocalState({}), []);
});

test("colours", () => {
  assert.equal(hexColor(-10915917), "#596fb3");
  assert.equal(hexColor(undefined), null);
});

test("groups by tenant: set, by domain, personal, made up, ungrouped", () => {
  const chrome = readLocalState(state);
  const { tenants, profiles } = arrange(chrome, {
    tenants: [{ id: "contoso", name: "Contoso", domains: ["contoso.com"] }, { id: "fabrikam", name: "Fabrikam", domains: [] }],
    profiles: { "Profile 5": { tenant: "fabrikam", label: "Fabrikam guest", role: "guest" } },
  });
  const t = Object.fromEntries(profiles.map((p) => [p.dir, p.tenant]));
  assert.deepEqual(t, { Default: "personal", "Profile 3": "contoso", "Profile 4": "contoso", "Profile 5": "fabrikam" });
  assert.equal(profiles[3].name, "Fabrikam guest");
  assert.deepEqual(tenants.map((x) => x.id), ["contoso", "fabrikam", "personal"]);

  const loose = arrange(chrome, {});
  assert.deepEqual(loose.profiles.map((p) => p.tenant), ["personal", "@contoso.com", "@contoso.com", "none"]);
  assert.deepEqual(loose.tenants.map((x) => x.name), ["Contoso", "Personal", "Ungrouped"]);
});

test("a tenant that's gone sends its profiles back to their domain", () => {
  const { profiles } = arrange(readLocalState(state), { profiles: { "Profile 3": { tenant: "deleted" } } });
  assert.equal(profiles[1].tenant, "@contoso.com");
});

test("profiles made here show until Chrome lists them", () => {
  const now = 1_800_000_000_000;
  const { profiles } = arrange([], { profiles: { "Profile 9": { label: "New", created: now - 1000 }, "Profile 8": { label: "Old", created: now - 30 * 864e5 } } }, { now });
  assert.deepEqual(profiles.map((p) => [p.dir, p.name, p.pending]), [["Profile 9", "New", true]]);
});

test("a new profile's folder", () => {
  assert.equal(nextProfileDir(["Default", "Profile 3", "Profile 12", "Guest Profile"]), "Profile 13");
  assert.equal(nextProfileDir(["Default"]), "Profile 1");
});

test("deleting a profile from Local State", () => {
  const next = withoutProfile(state, "Profile 4");
  assert.equal(next.profile.info_cache["Profile 4"], undefined);
  assert.deepEqual(next.profile.profiles_order, ["Default", "Profile 3", "Profile 5"]);
  assert.ok(state.profile.info_cache["Profile 4"], "the original is untouched");
});

test("shortcuts", () => {
  assert.deepEqual(parseShortcuts("Azure portal | portal.azure.com\n\nhttps://mail.google.com\n"), [
    ["Azure portal", "https://portal.azure.com"],
    ["mail.google.com", "https://mail.google.com"],
  ]);
});

test("link rules", () => {
  const u = "https://dev.azure.com/contoso/webshop/_workitems/edit/118";
  assert.ok(matches("dev.azure.com/contoso", u));
  assert.ok(matches("dev.azure.com/contoso/*", u));
  assert.ok(matches("https://dev.azure.com/contoso/", u));
  assert.ok(!matches("dev.azure.com/contos", u), "a whole path segment");
  assert.ok(!matches("dev.azure.com/fabrikam/*", u));
  assert.ok(matches("*.fabrikam.io", "https://grafana.fabrikam.io/d/1"));
  assert.ok(!matches("*.fabrikam.io", "https://fabrikam.io.evil.com/"));
  assert.ok(matches("github.com/fabrikam-*", "https://github.com/fabrikam-web/app/pull/3"));
  assert.ok(matches("portal.azure.com", "https://portal.azure.com/#home"));
  assert.ok(matches("*", "https://example.com"));
  assert.ok(matches("localhost", "http://localhost:1420/"));
  assert.ok(matches("localhost:1420", "http://localhost:1420/x"));
  assert.ok(!matches("localhost:3000", "http://localhost:1420/"));
  assert.ok(matches("localhost/admin", "http://localhost:8000/admin/users"));
  assert.ok(!matches("", "https://example.com"));
  const rules = [{ pattern: "dev.azure.com/fabrikam", dir: "Profile 5" }, { pattern: "dev.azure.com/*", dir: "Profile 3" }, { pattern: "*", dir: "Default" }];
  assert.deepEqual(ruleFor(rules, u), { ...rules[1], index: 1 });
  assert.equal(ruleFor(rules.slice(0, 1), u), null);
});

test("tenant ids", () => {
  assert.equal(tenantId("Contoso Ltd.", []), "contoso-ltd");
  assert.equal(tenantId("Contoso", ["contoso"]), "contoso-2");
});
