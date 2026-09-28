// Ports: reading `ss` (Linux) and `lsof` (macOS) into the ports that something listens on.
// Pure functions, tested with `node --test` (ports.test.js); view.js does the asking.

/** What usually listens on a port, for the ones worth a word */
export const KNOWN = {
  22: "SSH", 80: "HTTP", 443: "HTTPS", 631: "printing (CUPS)", 1420: "Tauri dev", 3000: "dev server",
  3306: "MySQL", 4200: "Angular dev", 5000: "dev server", 5173: "Vite", 5432: "PostgreSQL",
  5672: "RabbitMQ", 6379: "Redis", 8000: "dev server", 8080: "dev server", 8888: "Jupyter",
  9000: "dev server", 9200: "Elasticsearch", 9229: "Node debugger", 11211: "memcached",
  27017: "MongoDB",
};

/** host:port ("127.0.0.1:8000", "[::1]:631", "*:5173") into its parts */
function split(local) {
  const i = local.lastIndexOf(":");
  const host = local.slice(0, i).replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return { host: host === "*" || host === "0.0.0.0" || host === "::" ? "*" : host, port: Number(local.slice(i + 1)) };
}

/** `ss -Hltnp` lines: one per socket */
export function parseSs(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0] !== "LISTEN") continue;
    const { host, port } = split(f[3]);
    const procs = [...line.matchAll(/\("([^"]*)",pid=(\d+)/g)].map((m) => ({ name: m[1], pid: Number(m[2]) }));
    out.push({ host, port, procs });
  }
  return out;
}

/** `lsof -nP -iTCP -sTCP:LISTEN` lines: one per socket */
export function parseLsof(text) {
  const out = [];
  for (const line of text.split("\n").slice(1)) {
    const m = line.match(/^(\S+)\s+(\d+)\s.*TCP\s+(\S+)\s+\(LISTEN\)/);
    if (!m) continue;
    const { host, port } = split(m[3]);
    out.push({ host, port, procs: [{ name: m[1], pid: Number(m[2]) }] });
  }
  return out;
}

/** Sockets into one row per port: its addresses, and the processes (by pid, once each) */
export function ports(sockets) {
  const byPort = new Map();
  for (const s of sockets) {
    if (!Number.isFinite(s.port)) continue;
    const p = byPort.get(s.port) ?? { port: s.port, hosts: [], procs: [] };
    if (!p.hosts.includes(s.host)) p.hosts.push(s.host);
    for (const pr of s.procs) if (!p.procs.some((x) => x.pid === pr.pid)) p.procs.push(pr);
    byPort.set(s.port, p);
  }
  for (const p of byPort.values()) {
    // Listening everywhere covers the rest
    if (p.hosts.includes("*")) p.hosts = ["*"];
    p.procs.sort((a, b) => a.pid - b.pid);
    p.local = p.hosts.every((h) => h === "127.0.0.1" || h === "::1" || h === "localhost");
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** `ps -o pid=,args=` lines: pid -> its command line */
export function parsePs(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (m) out.set(Number(m[1]), m[2].trim());
  }
  return out;
}

/** "pid folder" lines (Linux, from /proc) or `lsof -Fpn -d cwd` (macOS): pid -> its folder */
export function parseCwd(text) {
  const out = new Map();
  let pid = null;
  for (const line of text.split("\n")) {
    if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
    else if (line.startsWith("n/") && pid !== null) out.set(pid, line.slice(1));
    else {
      const m = line.match(/^(\d+) (\/.*)$/);
      if (m) out.set(Number(m[1]), m[2]);
    }
  }
  return out;
}

/** The project a folder is in (the deepest one), or null */
export function projectOf(folder, projects) {
  if (!folder) return null;
  let best = null;
  for (const p of projects) {
    const root = p.path.replace(/\/+$/, "");
    if ((folder === root || folder.startsWith(`${root}/`)) && (!best || root.length > best.path.length)) best = p;
  }
  return best;
}
