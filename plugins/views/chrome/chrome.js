// The Chrome plugin's logic, without any I/O (tested in chrome.test.js): where each browser keeps
// its profiles, reading its "Local State", grouping profiles by tenant, and link rules.

/** The Chromium browsers it knows: their user-data folder and how to start them */
export const BROWSERS = {
  chrome: { name: "Chrome", linux: [".config/google-chrome", ["google-chrome-stable", "google-chrome"]], mac: ["Library/Application Support/Google/Chrome", "Google Chrome"] },
  chromium: { name: "Chromium", linux: [".config/chromium", ["chromium", "chromium-browser"]], mac: ["Library/Application Support/Chromium", "Chromium"] },
  brave: { name: "Brave", linux: [".config/BraveSoftware/Brave-Browser", ["brave", "brave-browser"]], mac: ["Library/Application Support/BraveSoftware/Brave-Browser", "Brave Browser"] },
  edge: { name: "Edge", linux: [".config/microsoft-edge", ["microsoft-edge-stable", "microsoft-edge"]], mac: ["Library/Application Support/Microsoft Edge", "Microsoft Edge"] },
};

/** Accounts on these domains are someone's own, not a tenant's */
export const PERSONAL = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "yahoo.com"];

export const COLORS = ["blue", "red", "yellow", "purple", "aqua", "orange", "green"];

/** Chrome's colours are ARGB in a signed 32-bit number */
export function hexColor(n) {
  if (typeof n !== "number") return null;
  return "#" + ((n >>> 0) & 0xffffff).toString(16).padStart(6, "0");
}

export const domainOf = (email) => (String(email || "").split("@")[1] || "").toLowerCase();

/** The profiles in Chrome's Local State, in Chrome's own order */
export function readLocalState(state) {
  const profile = state?.profile ?? {};
  const cache = profile.info_cache ?? {};
  const order = [...(profile.profiles_order ?? []), ...Object.keys(cache)].filter((d, i, all) => cache[d] && all.indexOf(d) === i);
  const active = new Set(profile.last_active_profiles ?? []);
  return order.map((dir) => {
    const p = cache[dir];
    return {
      dir,
      chromeName: p.name || p.gaia_name || dir,
      email: p.user_name || "",
      domain: p.hosted_domain && p.hosted_domain !== "NO_DOMAIN" ? p.hosted_domain : domainOf(p.user_name),
      chromeColor: hexColor(p.profile_highlight_color ?? p.default_avatar_fill_color),
      used: p.active_time ? Math.round(p.active_time * 1000) : 0,
      active: active.has(dir),
    };
  });
}

/** Local State without one profile (deleting it: Chrome must not be running) */
export function withoutProfile(state, dir) {
  const next = structuredClone(state);
  const p = next.profile ?? {};
  if (p.info_cache) delete p.info_cache[dir];
  for (const key of ["profiles_order", "last_active_profiles"]) if (Array.isArray(p[key])) p[key] = p[key].filter((d) => d !== dir);
  if (p.last_used === dir) p.last_used = (p.profiles_order ?? [])[0] ?? "Default";
  return next;
}

/** The folder name for a new profile: "Profile N", after the highest one in use */
export function nextProfileDir(dirs) {
  const n = Math.max(0, ...dirs.map((d) => +(/^Profile (\d+)$/.exec(d)?.[1] ?? 0)));
  return `Profile ${n + 1}`;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tenant";
const title = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Chrome's profiles with the user's labels (state: { tenants, profiles: {dir: meta}, rules })
 * and the tenant each falls in. A profile set to a tenant stays there; otherwise its account's
 * domain decides: a tenant listing that domain, "Personal" for gmail.com and the like, a tenant
 * made up from the domain, or "Ungrouped" without an account.
 */
export function arrange(chrome, state, { now = Date.now() } = {}) {
  const tenants = (state.tenants ?? []).map((t) => ({ ...t, domains: t.domains ?? [], made: false }));
  const byId = new Map(tenants.map((t) => [t.id, t]));
  const metas = state.profiles ?? {};
  const seen = new Set(chrome.map((p) => p.dir));
  // Made here but not in Local State yet (Chrome writes it later)
  const pending = Object.entries(metas).filter(([dir, m]) => !seen.has(dir) && m.created && now - m.created < 7 * 864e5)
    .map(([dir]) => ({ dir, chromeName: dir, email: "", domain: "", chromeColor: null, used: metas[dir].created, active: false, pending: true }));
  const profiles = [...chrome, ...pending].map((c, i) => {
    const m = metas[c.dir] ?? {};
    const email = m.account || c.email;
    const domain = domainOf(m.account) || c.domain;
    let tenant = m.tenant && (byId.has(m.tenant) || m.tenant === "none") ? m.tenant : null;
    if (!tenant) {
      const t = domain && tenants.find((t) => t.domains.includes(domain));
      if (t) tenant = t.id;
      else if (PERSONAL.includes(domain)) tenant = "personal";
      else if (domain) tenant = "@" + domain;
      else tenant = "none";
      if (!byId.has(tenant) && tenant !== "none") {
        const made = tenant === "personal" ? { id: "personal", name: "Personal", domains: [] } : { id: tenant, name: title(domain.split(".")[0]), domains: [domain] };
        made.made = true;
        tenants.push(made);
        byId.set(tenant, made);
      }
    }
    return {
      ...c,
      i,
      name: m.label || c.chromeName,
      email,
      tenant,
      role: m.role || "",
      color: m.color || null,
      shortcuts: m.shortcuts ?? [],
      hidden: !!m.hidden,
    };
  });
  tenants.sort((a, b) => (a.id === "personal") - (b.id === "personal") || a.name.localeCompare(b.name));
  if (profiles.some((p) => p.tenant === "none")) tenants.push({ id: "none", name: "Ungrouped", domains: [], made: true });
  return { tenants, profiles };
}

export const tenantId = (name, taken) => {
  let id = slug(name), n = 2;
  while (taken.includes(id)) id = `${slug(name)}-${n++}`;
  return id;
};

/** "Name | address" lines → [[name, url]] (a bare address names itself) */
export function parseShortcuts(text) {
  return String(text).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [a, b] = l.split("|").map((x) => x.trim());
    const url = b ?? a;
    return [b ? a : url.replace(/^https?:\/\//, ""), /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`];
  });
}

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does a rule's pattern match the link? Patterns leave out the scheme; * matches anything.
 * A pattern without a / is a host (`*.contoso.com`, `portal.azure.com`) and matches every page
 * there; one with a path matches pages under it (`dev.azure.com/contoso` and `…/contoso/*` both
 * match dev.azure.com/contoso/webshop). `*` alone matches everything; a port only counts when the
 * pattern has one.
 */
export function matches(pattern, url) {
  const p = String(pattern).trim().replace(/^[a-z]+:\/\//i, "").replace(/\/\*?$/, "");
  if (!p) return false;
  if (p === "*") return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // The port only counts when the pattern names one (localhost matches localhost:5173)
  const host = p.split("/")[0].includes(":") ? u.host : u.hostname;
  const target = (host + u.pathname).replace(/\/$/, "");
  const re = escapeRe(p).replace(/\*/g, ".*");
  if (!p.includes("/")) return new RegExp(`^${re}$`, "i").test(host);
  return new RegExp(`^${re}(/.*)?$`, "i").test(target);
}

/** The first rule that matches, with its index; null when none does */
export function ruleFor(rules, url) {
  const i = (rules ?? []).findIndex((r) => matches(r.pattern, url));
  return i < 0 ? null : { ...rules[i], index: i };
}

/** "3m ago", "2d ago" */
export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 86400 / 7)}w ago`;
}

export const initials = (name) => String(name).split(/[\s._@-]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
