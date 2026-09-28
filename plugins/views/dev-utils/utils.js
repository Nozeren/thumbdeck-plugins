// Dev utils: what a pasted text is and what it decodes to (JWT, JSON, base64, timestamps,
// URLs, …). Pure functions, tested with `node --test` (utils.test.js); view.js shows them.

const b64decode = (s) => {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(std + "=".repeat((4 - (std.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
};
const b64encode = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const printable = (s) => !/[\x00-\x08\x0e-\x1f\x7f]/.test(s);
const pretty = (v) => JSON.stringify(v, null, 2);

/** "3h ago", "in 2d" */
export function relative(ms, now) {
  const d = ms - now;
  const a = Math.abs(d) / 1000;
  if (a < 5) return "now";
  const n = a < 60 ? `${Math.round(a)}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : a < 86400 * 365 ? `${Math.round(a / 86400)}d` : `${(a / 86400 / 365).toFixed(1)}y`;
  return d < 0 ? `${n} ago` : `in ${n}`;
}

/** A date in local time, as "2026-09-28 14:03:05 (+03:00)" */
export function local(ms, offsetMin = -new Date(ms).getTimezoneOffset()) {
  const t = new Date(ms + offsetMin * 60_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const sign = offsetMin < 0 ? "-" : "+";
  const o = Math.abs(offsetMin);
  return `${t} (${sign}${String(Math.floor(o / 60)).padStart(2, "0")}:${String(o % 60).padStart(2, "0")})`;
}

function jwt(s, now) {
  const parts = s.split(".");
  if (parts.length !== 3 || !/^eyJ/.test(parts[0])) return null;
  try {
    const header = JSON.parse(b64decode(parts[0]));
    const payload = JSON.parse(b64decode(parts[1]));
    const out = [{ label: "JWT header", value: pretty(header) }, { label: "JWT payload", value: pretty(payload) }];
    for (const [k, what] of [["exp", "expires"], ["iat", "issued"], ["nbf", "valid from"]]) {
      if (typeof payload[k] === "number") {
        const ms = payload[k] * 1000;
        out.push({ label: `JWT ${k}`, value: `${what} ${local(ms)}, ${relative(ms, now)}${k === "exp" && ms < now ? " (expired)" : ""}` });
      }
    }
    out.push({ label: "note", value: "The signature isn't checked: this only reads the token." });
    return out;
  } catch {
    return null;
  }
}

function timestamp(s, now) {
  if (!/^\d{9,13}(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  const ms = s.split(".")[0].length >= 13 ? n : n * 1000;
  const out = [
    { label: "local time", value: `${local(ms)}, ${relative(ms, now)}` },
    { label: "UTC", value: new Date(ms).toISOString() },
  ];
  return out;
}

function date(s, now) {
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return null;
  const ms = Date.parse(s.replace(" ", "T"));
  if (!Number.isFinite(ms)) return null;
  return [
    { label: "unix seconds", value: String(Math.floor(ms / 1000)) },
    { label: "unix ms", value: String(ms) },
    { label: "UTC", value: new Date(ms).toISOString() },
    { label: "local time", value: `${local(ms)}, ${relative(ms, now)}` },
  ];
}

function json(s) {
  if (!/^[[{"]/.test(s)) return null;
  try {
    const v = JSON.parse(s);
    const out = [{ label: "JSON", value: pretty(v) }, { label: "JSON, one line", value: JSON.stringify(v) }];
    // A JSON string that holds JSON (logs do this)
    if (typeof v === "string") {
      try {
        out.push({ label: "JSON inside", value: pretty(JSON.parse(v)) });
      } catch {}
    }
    return out;
  } catch {
    return null;
  }
}

function url(s) {
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null;
  const out = [{ label: "URL", value: decodeURI(u.origin + u.pathname) }];
  const params = [...u.searchParams];
  if (params.length) out.push({ label: "query", value: params.map(([k, v]) => `${k} = ${v}`).join("\n") });
  if (u.hash) out.push({ label: "fragment", value: decodeURIComponent(u.hash.slice(1)) });
  if (u.username || u.password) out.push({ label: "login", value: `${decodeURIComponent(u.username)}${u.password ? ":••••" : ""}` });
  return out;
}

function base64(s) {
  if (s.length < 8 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s) || /^\d+$/.test(s)) return null;
  try {
    const text = b64decode(s);
    return printable(text) && text.trim() ? [{ label: "base64 decoded", value: text }] : null;
  } catch {
    return null;
  }
}

function urlEncoded(s) {
  if (!/%[0-9a-f]{2}/i.test(s) && !/\+/.test(s.split("?")[1] ?? "")) return null;
  try {
    const d = decodeURIComponent(s.replace(/\+/g, " "));
    return d !== s ? [{ label: "URL-decoded", value: d }] : null;
  } catch {
    return null;
  }
}

/** Everything the text can be read as; then what it can be turned into */
export function analyze(input, now = Date.now()) {
  const s = input.trim();
  if (!s) return [];
  const found = [jwt, timestamp, date, json, url, urlEncoded, base64].flatMap((f) => f(s, now) ?? []);
  const also = [
    { label: "as base64", value: b64encode(s) },
    { label: "URL-encoded", value: encodeURIComponent(s) },
    { label: "length", value: `${[...s].length} characters, ${new TextEncoder().encode(s).length} bytes${s.includes("\n") ? `, ${s.split("\n").length} lines` : ""}` },
  ];
  return [...found, ...also.filter((a) => !found.some((f) => f.value === a.value))];
}

/** A random UUID (v4) */
export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** With nothing pasted: the time now, and a fresh UUID */
export function idle(now = Date.now(), id = uuid()) {
  return [
    { label: "now, unix seconds", value: String(Math.floor(now / 1000)) },
    { label: "now, unix ms", value: String(now) },
    { label: "now, UTC", value: new Date(now).toISOString() },
    { label: "now, local", value: local(now) },
    { label: "a new UUID", value: id },
  ];
}
