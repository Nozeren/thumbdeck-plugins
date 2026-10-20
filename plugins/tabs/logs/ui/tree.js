// The log as rows on screen: blocks you opened show their contents, hidden levels are left
// out. Pure functions, tested with `node --test` (tree.test.js).
/** A block's identity across reloads (live tail keeps what you opened) */
export const blockKey = (b) => `${b.kind}:${b.first_line}`;
/** The rows on screen. `only`: a line must pass it to show (one request's lines); `fold`: lines
 *  that repeat the one before exactly (but for their time) become one row with a `count` */
export function rows(outline, lines, open, hidden, { fold = false, only = null } = {}) {
    const out = [];
    const walk = (nodes, depth) => {
        for (const n of nodes) {
            if (n.type === "line") {
                const l = lines[n.line];
                if (hidden.has(l?.level) || (only && !only(l)))
                    continue;
                const last = out[out.length - 1];
                if (fold && last?.type === "line" && last.depth === depth && signature(lines[last.line]) === signature(l)) {
                    last.count = (last.count ?? 1) + 1;
                    continue;
                }
                out.push({ key: `line:${n.line}`, depth, type: "line", line: n.line });
            }
            else {
                const key = blockKey(n);
                const isOpen = open.has(key);
                out.push({ key, depth, type: "block", node: n, open: isOpen });
                if (isOpen)
                    walk(n.children, depth + 1);
            }
        }
    };
    walk(outline, 0);
    return out;
}
/** For each line, the keys of the blocks it's in, outermost first */
export function ancestors(outline) {
    const out = new Map();
    const walk = (nodes, path) => {
        for (const n of nodes) {
            if (n.type === "line")
                out.set(n.line, path);
            else
                walk(n.children, [...path, blockKey(n)]);
        }
    };
    walk(outline, []);
    return out;
}
/** The parent block row of a row, if any */
export function parentIndex(list, index) {
    const depth = list[index]?.depth ?? 0;
    for (let i = index - 1; i >= 0; i--)
        if (list[i].depth < depth)
            return i;
    return null;
}
/** The line a row stands for: a block's first line */
export const lineOf = (r) => (r.type === "line" ? r.line : r.node.first_line);
/**
 * The next (or previous) line after `from` that matches, among lines whose level isn't hidden,
 * wrapping around. null when none does.
 */
export function findLine(lines, from, direction, hidden, matches) {
    const n = lines.length;
    for (let step = 1; step <= n; step++) {
        const i = (((from + direction * step) % n) + n) % n;
        if (!hidden.has(lines[i].level) && matches(lines[i]))
            return i;
    }
    return null;
}
/** "HH:MM:SS │ LEVEL   │ message" (how the viewer shows a line) */
export function formatLine(l) {
    const time = /\d{2}:\d{2}:\d{2}/.exec(l.time)?.[0] ?? l.time;
    const parts = [];
    if (time)
        parts.push(time);
    if (l.level !== "UNKNOWN")
        parts.push(l.level.padEnd(7));
    parts.push(l.message.replaceAll("\r", "").replaceAll("\n", " "));
    return parts.join(" │ ");
}
/** "5m ago" */
export function age(mtime, now = Date.now() / 1000) {
    const s = Math.max(0, now - mtime);
    if (s < 60)
        return "just now";
    if (s < 3600)
        return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}
const SHORTEN_AT = 200;
/** One entry as rows; the top-level containers start open (their path is in `closed` when not). */
export function jsonRows(entry, closed, opened) {
    const out = [];
    const walk = (key, value, path, depth) => {
        const container = value !== null && typeof value === "object";
        const open = container && (depth === 0 ? !closed.has(path) : opened.has(path));
        let display;
        let kind;
        if (Array.isArray(value))
            (display = `[${value.length}]`), (kind = "container");
        else if (container)
            (display = `{${Object.keys(value).length}}`), (kind = "container");
        else if (value === null)
            (display = "null"), (kind = "null");
        else if (typeof value === "boolean")
            (display = String(value)), (kind = "bool");
        else if (typeof value === "number")
            (display = String(value)), (kind = "number");
        else {
            display = JSON.stringify(String(value));
            if (display.length > SHORTEN_AT)
                display = display.slice(0, SHORTEN_AT) + "…";
            kind = "string";
        }
        out.push({ path, depth, key, value, container, open, display, kind });
        if (open) {
            const entries = Array.isArray(value) ? value.map((v, i) => [`[${i}]`, v]) : Object.entries(value);
            for (const [k, v] of entries)
                walk(k, v, `${path}.${k}`, depth + 1);
        }
    };
    for (const [k, v] of Object.entries(entry))
        walk(k, v, k, 0);
    return out;
}
/** What `y` copies: a value as text, containers as indented JSON */
export const copyText = (value) => value !== null && typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);

/** What makes two lines the same, but for their time (repeats fold only when this matches) */
const TIME_KEYS = new Set(["timestamp", "time", "ts", "@timestamp", "asctime", "datetime", "date", "t"]);
export function signature(l) {
    if (!l) return "";
    const data = l.data && typeof l.data === "object" ? Object.fromEntries(Object.entries(l.data).filter(([k]) => !TIME_KEYS.has(k))) : null;
    return `${l.level}\u0000${l.message}\u0000${data ? JSON.stringify(data) : ""}`;
}

/** A line's time in milliseconds ("2026-07-31 10:00:00,001", "...T...Z", "10:00:00"), or null */
export function timeMs(t) {
    const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,](\d{1,6}))?/.exec(String(t ?? ""));
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0);
    const h = /^(\d\d):(\d\d):(\d\d)(?:[.,](\d{1,6}))?/.exec(String(t ?? ""));
    return h ? Date.UTC(1970, 0, 1, +h[1], +h[2], +h[3], h[4] ? Number(h[4].slice(0, 3).padEnd(3, "0")) : 0) : null;
}

/** Lines per stretch of time, by level, for the timeline (null when the lines have no times) */
export function histogram(lines, buckets = 60) {
    const times = lines.map((l) => timeMs(l.time));
    const known = times.filter((t) => t !== null);
    if (known.length < 2) return null;
    const t0 = Math.min(...known), t1 = Math.max(...known), span = Math.max(1, t1 - t0);
    const bins = Array.from({ length: buckets }, () => ({ DEBUG: 0, INFO: 0, WARNING: 0, ERROR: 0, other: 0 }));
    lines.forEach((l, i) => {
        if (times[i] === null) return;
        const b = bins[Math.min(buckets - 1, Math.floor(((times[i] - t0) / span) * buckets))];
        b[l.level in b ? l.level : "other"]++;
    });
    const max = Math.max(1, ...bins.map((b) => b.DEBUG + b.INFO + b.WARNING + b.ERROR + b.other));
    return { t0, t1, bins, max, times };
}

/** A JSON line's other fields (not its message, level or time), to show after the message */
export function extraFields(data, fields) {
    if (!data || typeof data !== "object") return [];
    const skip = new Set([...(fields?.message ?? []), ...(fields?.level ?? []), ...(fields?.time ?? []), "message"]);
    return Object.entries(data).filter(([k]) => !skip.has(k)).map(([k, v]) => {
        const shown = v !== null && typeof v === "object" ? (Array.isArray(v) ? `[${v.length}]` : "{…}") : String(v);
        return [k, shown.length > 40 ? shown.slice(0, 39) + "…" : shown];
    });
}

/** The field tying a line to a request (req, request_id, trace_id…), as [name, value] */
const REQUEST_KEYS = ["req", "request_id", "requestId", "req_id", "reqId", "trace_id", "traceId", "correlation_id", "correlationId"];
export function requestOf(data) {
    if (!data || typeof data !== "object") return null;
    const k = REQUEST_KEYS.find((name) => data[name] !== undefined && data[name] !== null && typeof data[name] !== "object");
    return k ? [k, String(data[k])] : null;
}
