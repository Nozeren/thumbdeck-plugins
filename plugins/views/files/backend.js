// The Files backend: lists folders (with git status), previews files, copies, moves, renames,
// moves to the Trash (and undoes all of it), searches by name (fd) or content (ripgrep) and
// adds up sizes (du). The view only draws and takes keys (view.js).
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
// In your own plugin: `npm install @thumbdeck/backend`. The official plugins use the copy in
// this repository.
import { serve } from "../../../packages/backend/index.js";
import { kindOf, parseGitStatus, quote, score, statusFor, uniqueName } from "./files.js";

const mac = process.platform === "darwin";
const HOME = homedir();
const TEXT_MAX = 96 * 1024; // what a preview reads of a text file
const IMAGE_MAX = 12 * 1024 * 1024;
const undo = []; // { label, steps: [() => Promise] }, newest last
let tb = null;

const run = (cmd, args, o = {}) =>
  new Promise((resolve) =>
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: o.timeout ?? 15000, cwd: o.cwd }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr), missing: err?.code === "ENOENT" }),
    ),
  );
const has = async (p) => !!(await lstat(p).catch(() => null));

// ------------------------------------------------------------ git

const gitCache = new Map(); // repo root -> { at, status, branch }
async function gitFor(dir) {
  const top = await run("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 3000 });
  if (!top.ok) return null;
  const root = top.stdout.trim();
  const cached = gitCache.get(root);
  if (cached && Date.now() - cached.at < 1500) return { root, ...cached };
  const [st, br] = await Promise.all([
    run("git", ["-C", root, "status", "--porcelain=v1", "-z", "--ignored=matching"], { timeout: 8000 }),
    run("git", ["-C", root, "branch", "--show-current"], { timeout: 3000 }),
  ]);
  const info = { at: Date.now(), status: st.ok ? parseGitStatus(st.stdout) : {}, branch: br.stdout.trim() || "(detached)" };
  gitCache.set(root, info);
  return { root, ...info };
}

// ------------------------------------------------------------ listing

async function entry(dir, name) {
  const path = join(dir, name);
  const l = await lstat(path).catch(() => null);
  if (!l) return null;
  let s = l, link = l.isSymbolicLink();
  if (link) s = (await stat(path).catch(() => null)) ?? l;
  return { name, path, dir: s.isDirectory(), size: s.isDirectory() ? 0 : s.size, mtime: s.mtimeMs, hidden: name.startsWith("."), link, kind: s.isDirectory() ? "dir" : kindOf(name), mode: s.mode };
}

async function list({ dir }) {
  const names = await readdir(dir).catch((e) => {
    throw new Error(e.code === "EACCES" ? `You can't open ${dir}` : e.code === "ENOENT" ? `${dir} isn't there anymore` : e.message);
  });
  const entries = (await Promise.all(names.map((n) => entry(dir, n)))).filter(Boolean);
  // How many entries each folder holds (cheap: one readdir each, in parallel)
  await Promise.all(entries.filter((e) => e.dir).map(async (e) => (e.count = (await readdir(e.path).catch(() => [])).length)));
  const git = await gitFor(dir);
  let status = {};
  if (git) {
    const rel = relative(git.root, dir);
    status = statusFor(entries.map((e) => e.name), rel === "." ? "" : rel, git.status);
  }
  for (const e of entries) e.git = status[e.name] ?? "";
  return { dir, home: HOME, parent: dir === "/" ? null : dirname(dir), entries, git: git ? { root: git.root, branch: git.branch } : null };
}

// ------------------------------------------------------------ previews

async function preview({ path }) {
  const e = await entry(dirname(path), basename(path));
  if (!e) throw new Error(`${path} isn't there anymore`);
  if (e.dir) {
    const l = await list({ dir: path }).catch((err) => ({ problem: err.message }));
    return { ...e, type: "dir", entries: l.entries ?? [], repo: l.git ?? null, problem: l.problem };
  }
  const out = { ...e, type: e.kind };
  const git = await gitFor(dirname(path));
  if (git) {
    const rel = relative(git.root, path);
    const code = git.status[rel];
    if (code === "M" || code === "R") {
      const d = await run("git", ["-C", git.root, "diff", "HEAD", "--", rel], { timeout: 5000 });
      if (d.ok && d.stdout) out.diff = d.stdout.length > TEXT_MAX ? d.stdout.slice(0, TEXT_MAX) : d.stdout;
    }
  }
  switch (e.kind) {
    case "image":
      if (e.size <= IMAGE_MAX) out.data = (await readFile(path)).toString("base64");
      break;
    case "zip": {
      const isZip = /\.(zip|jar)$/i.test(path);
      const r = isZip ? await run("unzip", ["-Z1", path]) : await run("tar", ["-tf", path], { timeout: 8000 });
      out.entries = r.ok ? r.stdout.split("\n").filter(Boolean).slice(0, 400) : null;
      out.total = r.ok ? r.stdout.split("\n").filter(Boolean).length : 0;
      if (!r.ok) out.problem = r.missing ? `${isZip ? "unzip" : "tar"} isn't installed` : "Can't list it";
      break;
    }
    case "video":
    case "audio": {
      const r = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height,codec_name", "-of", "json", path]);
      if (r.ok) {
        const j = JSON.parse(r.stdout);
        out.duration = +j.format?.duration || null;
        const v = j.streams?.find((s) => s.width);
        if (v) out.res = `${v.width}×${v.height} ${v.codec_name}`;
      }
      break;
    }
    case "pdf": {
      const r = await run("pdfinfo", [path]);
      if (r.ok) out.info = Object.fromEntries(r.stdout.split("\n").map((l) => l.split(/:\s+/)).filter((p) => p.length >= 2 && ["Title", "Author", "Pages", "Page size", "Producer"].includes(p[0])).map(([k, ...v]) => [k, v.join(": ")]));
      const t = await run("pdftotext", ["-l", "1", "-layout", path, "-"]);
      if (t.ok) out.text = t.stdout.slice(0, 4000);
      break;
    }
    default: {
      // Text when the first bytes look like text
      const fd = await open(path, "r");
      try {
        const buf = Buffer.alloc(Math.min(TEXT_MAX, e.size));
        await fd.read(buf, 0, buf.length, 0);
        const binary = buf.subarray(0, 8000).includes(0);
        if (!binary) {
          out.text = buf.toString("utf8");
          out.cut = e.size > TEXT_MAX;
          if (out.type === "file") out.type = "code";
        }
      } finally {
        await fd.close();
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ changing files

/** Copy or move paths into a folder; names that are taken get " (2)" */
async function paste({ paths, to, move }) {
  const taken = await readdir(to);
  const done = [];
  for (const from of paths) {
    if (move && dirname(from) === to) continue;
    if ((to + "/").startsWith(from + "/")) throw new Error(`Can't put ${basename(from)} inside itself`);
    const name = uniqueName(basename(from), taken);
    taken.push(name);
    const dest = join(to, name);
    if (move) {
      await rename(from, dest).catch(async (e) => {
        if (e.code !== "EXDEV") throw e;
        await cp(from, dest, { recursive: true, preserveTimestamps: true }); // another disk
        await rm(from, { recursive: true, force: true });
      });
    } else await cp(from, dest, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    done.push({ from, dest });
  }
  const n = done.length;
  undo.push({
    label: `${move ? "move" : "copy"} of ${n === 1 ? basename(done[0].from) : `${n} items`}`,
    steps: done.map(({ from, dest }) => (move ? () => rename(dest, from) : () => trash({ paths: [dest], quiet: true }))),
  });
  return done.map((d) => d.dest);
}

/** The Trash: the freedesktop one in your home (so it can be undone), ~/.Trash on macOS, gio elsewhere */
async function trash({ paths, quiet }) {
  const steps = [];
  for (const path of paths) {
    if (mac) {
      const dest = join(HOME, ".Trash", uniqueName(basename(path), await readdir(join(HOME, ".Trash")).catch(() => [])));
      await rename(path, dest);
      steps.push(() => rename(dest, path));
      continue;
    }
    const base = join(process.env.XDG_DATA_HOME || join(HOME, ".local/share"), "Trash");
    mkdirSync(join(base, "files"), { recursive: true });
    mkdirSync(join(base, "info"), { recursive: true });
    const name = uniqueName(basename(path), await readdir(join(base, "files")));
    const info = join(base, "info", `${name}.trashinfo`);
    await writeFile(info, `[Trash Info]\nPath=${encodeURI(path)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`);
    try {
      await rename(path, join(base, "files", name));
      steps.push(async () => {
        await rename(join(base, "files", name), path);
        await rm(info, { force: true });
      });
    } catch (e) {
      await rm(info, { force: true });
      if (e.code !== "EXDEV") throw e;
      // On another disk: gio puts it in that disk's Trash (no undo here)
      const r = await run("gio", ["trash", path]);
      if (!r.ok) throw new Error(`Couldn't move ${basename(path)} to the Trash: ${r.stderr.trim() || "gio isn't installed"}`);
    }
  }
  if (!quiet) undo.push({ label: `trash of ${paths.length === 1 ? basename(paths[0]) : `${paths.length} items`}`, steps });
  return steps.length;
}

async function renameOne({ path, name }) {
  if (!name || name.includes("/")) throw new Error("A name can't be empty or have a /");
  const dest = join(dirname(path), name);
  if (dest === path) return path;
  if (await has(dest)) throw new Error(`There's already a ${name} here`);
  await rename(path, dest);
  undo.push({ label: `rename to ${name}`, steps: [() => rename(dest, path)] });
  return dest;
}

/** Several renames at once, swaps included (through temporary names) */
async function renameMany({ dir, changes }) {
  const tmp = changes.map(([from], i) => [join(dir, from), join(dir, `.thumbdeck-rename-${process.pid}-${i}`)]);
  for (const [from, t] of tmp) await rename(from, t);
  const done = [];
  for (const [i, [, to]] of changes.entries()) {
    await rename(tmp[i][1], join(dir, to));
    done.push([join(dir, changes[i][0]), join(dir, to)]);
  }
  undo.push({ label: `rename of ${done.length} items`, steps: [() => renameMany({ dir, changes: changes.map(([a, b]) => [b, a]), noUndo: true }).then(() => undo.pop())] });
  return done.length;
}

async function make({ dir, name, folder }) {
  if (!name || name.includes("/")) throw new Error("A name can't be empty or have a /");
  const path = join(dir, name);
  if (await has(path)) throw new Error(`There's already a ${name} here`);
  if (folder) await mkdir(path);
  else await writeFile(path, "", { flag: "wx" });
  undo.push({ label: `new ${folder ? "folder" : "file"} ${name}`, steps: [() => trash({ paths: [path], quiet: true })] });
  return path;
}

async function undoLast() {
  const u = undo.pop();
  if (!u) throw new Error("Nothing to undo");
  for (const step of [...u.steps].reverse()) await step();
  return u.label;
}

// ------------------------------------------------------------ finding

const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", "target", "dist", ".next"]);

/** Every path under dir (fd when it's installed; a walk otherwise), at most limit */
async function paths(dir, hidden, limit = 20000) {
  for (const fd of ["fd", "fdfind"]) {
    const r = await run(fd, ["--color=never", "--max-results", String(limit), ...(hidden ? ["--hidden", "--exclude", ".git"] : []), ".", dir], { timeout: 10000 });
    if (!r.missing) return r.stdout.split("\n").filter(Boolean).map((p) => p.replace(/\/$/, ""));
  }
  const out = [];
  async function walk(d, depth) {
    if (out.length >= limit || depth > 12) return;
    const names = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const n of names) {
      if ((!hidden && n.name.startsWith(".")) || SKIP.has(n.name)) continue;
      out.push(join(d, n.name));
      if (n.isDirectory()) await walk(join(d, n.name), depth + 1);
      if (out.length >= limit) return;
    }
  }
  await walk(dir, 0);
  return out;
}

const findCache = new Map(); // dir+hidden -> { at, list }
async function find({ dir, q, hidden }) {
  const key = `${dir}\0${hidden}`;
  let c = findCache.get(key);
  if (!c || Date.now() - c.at > 20000) findCache.set(key, (c = { at: Date.now(), list: await paths(dir, hidden) }));
  const rel = c.list.map((p) => p.slice(dir.length + 1));
  const ranked = q ? rel.map((p) => [p, score(q, p)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]) : rel.slice(0, 50).map((p) => [p, 0]);
  return Promise.all(ranked.slice(0, 50).map(async ([p]) => ({ rel: p, ...(await entry(dirname(join(dir, p)), basename(p))) })).filter(Boolean)).then((l) => l.filter((x) => x.name));
}

async function grep({ dir, q, hidden }) {
  if (!q) return [];
  const r = await run("rg", ["--json", "--max-count", "3", "--max-columns", "200", "-S", ...(hidden ? ["--hidden", "-g", "!.git"] : []), "--", q, dir], { timeout: 15000 });
  if (r.missing) {
    const g = await run("grep", ["-rnI", "--max-count=3", "-i", "--exclude-dir=.git", "--exclude-dir=node_modules", "--", q, dir], { timeout: 15000 });
    return g.stdout.split("\n").filter(Boolean).slice(0, 80).map((l) => {
      const [, path, line, text] = /^(.*?):(\d+):(.*)$/.exec(l) ?? [];
      return path && { path, rel: path.slice(dir.length + 1), line: +line, text: text.trim() };
    }).filter(Boolean);
  }
  return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.type === "match").slice(0, 80)
    .map((m) => ({ path: m.data.path.text, rel: m.data.path.text.slice(dir.length + 1), line: m.data.line_number, text: m.data.lines.text.trim() }));
}

/** What takes the space in a folder, biggest first */
async function usage({ dir, hidden }) {
  const r = mac ? await run("du", ["-k", "-d", "1", dir], { timeout: 60000 }) : await run("du", ["-b", "--max-depth=1", dir], { timeout: 60000 });
  const sizes = new Map();
  for (const l of r.stdout.split("\n")) {
    const m = /^(\d+)\s+(.*)$/.exec(l);
    if (m) sizes.set(m[2], +m[1] * (mac ? 1024 : 1));
  }
  const { entries } = await list({ dir });
  const items = entries.filter((e) => hidden || !e.hidden).map((e) => ({ ...e, size: sizes.get(e.path) ?? e.size }));
  return { dir, total: sizes.get(dir) ?? items.reduce((s, e) => s + e.size, 0), items: items.sort((a, b) => b.size - a.size), partial: !r.ok };
}

// ------------------------------------------------------------ opening

function detached(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
    p.on("error", (e) => reject(new Error(e.code === "ENOENT" ? `${cmd} isn't installed` : e.message)));
    p.on("spawn", () => (p.unref(), resolve()));
  });
}

async function copyText({ text }) {
  const tools = mac ? [["pbcopy"]] : process.env.WAYLAND_DISPLAY ? [["wl-copy"]] : [["xclip", "-selection", "clipboard"], ["xsel", "-ib"]];
  for (const [cmd, ...args] of tools) {
    const ok = await new Promise((resolve) => {
      const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"], detached: cmd !== "pbcopy" });
      p.on("error", () => resolve(false));
      p.on("spawn", () => (p.stdin.end(text), p.unref(), resolve(true)));
    });
    if (ok) return;
  }
  throw new Error(`Install ${mac ? "pbcopy" : process.env.WAYLAND_DISPLAY ? "wl-clipboard" : "xclip"} to copy`);
}

serve({
  initialize(_, t) {
    tb = t;
  },
  list,
  preview,
  paste,
  trash: (p) => trash(p),
  rename: renameOne,
  renameMany,
  make,
  undo: undoLast,
  undoLabel: () => undo.at(-1)?.label ?? null,
  find,
  grep,
  usage,
  copyText,
  async open({ path }) {
    await detached(mac ? "open" : "xdg-open", [path]);
  },
  /** A command on the selection, in the folder: {} is the files, quoted (or they go at the end) */
  command({ command, paths: ps }) {
    const files = ps.map((p) => quote(basename(p))).join(" ");
    return command.includes("{}") ? command.replaceAll("{}", files) : `${command} ${files}`;
  },
  home: () => HOME,
  exists: ({ path }) => existsSync(path),
});
