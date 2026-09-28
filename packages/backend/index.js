// @thumbdeck/backend: a plugin backend in Node. thumbdeck sends requests on stdin and reads
// answers on stdout, one JSON message per line (SPEC.md, The backend); this does the reading,
// writing and dispatching, so a backend is a set of functions:
//
//   import { serve } from "@thumbdeck/backend";
//   serve({ async count({ project }) { return 3; } });
import { createInterface } from "node:readline";

export function serve(handlers = {}, setup) {
  // A print on stdout would break the messages: console output goes to stderr, which is the
  // plugin's log in Settings › Plugins
  for (const level of ["log", "info", "debug"]) console[level] = (...args) => console.error(...args);

  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let next = 1;
  const waiting = new Map();

  /** Ask thumbdeck something (storage.get, …) */
  function request(method, params) {
    const id = next++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      write({ id, method, params: params ?? null });
    });
  }
  const tell = (method, params) => write({ method, params: params ?? null });

  const tb = {
    /** What initialize said: api, thumbdeck, folder, dataFolder, settings (kept up to date) */
    info: null,
    event: (name, data) => tell("event", { name, data: data ?? null }),
    say: (text, o = {}) => tell("ui.say", { text: String(text), error: !!o.error }),
    notify: (title, body = "") => tell("ui.notify", { title: String(title), body: String(body) }),
    badge: (value) => tell("ui.badge", { value: value == null ? null : String(value) }),
    status: (text) => tell("ui.status", { text: text == null ? null : String(text) }),
    mood: (signal, value) => tell("ui.mood", { signal, value: value ?? null }),
    refreshActions: () => tell("actions.refresh"),
    storage: {
      get: async (key, o = {}) => (await request("storage.get", { key, ...o })) ?? undefined,
      set: (key, value, o = {}) => request("storage.set", { key, value, ...o }),
      remove: (key, o = {}) => request("storage.remove", { key, ...o }),
    },
    request,
  };

  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return console.error("thumbdeck sent something that isn't JSON:", line);
    }
    if (!m.method) {
      // An answer to one of our requests
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) w?.reject(new Error(m.error.message ?? String(m.error)));
      else w?.resolve(m.result);
      return;
    }
    if (m.method === "initialize") tb.info = m.params;
    if (m.method === "settings" && tb.info) tb.info.settings = m.params;
    const fn = handlers[m.method];
    if (m.id === undefined) {
      // An event: nothing answers it
      try {
        await fn?.(m.params ?? {}, tb);
      } catch (e) {
        console.error(e);
      }
      return;
    }
    try {
      if (!fn && m.method !== "initialize" && m.method !== "shutdown") throw new Error(`there's no ${m.method} in this backend`);
      const result = fn ? await fn(m.params ?? {}, tb) : {};
      write({ id: m.id, result: result ?? null });
    } catch (e) {
      write({ id: m.id, error: { message: String(e?.message ?? e) } });
    }
    if (m.method === "shutdown") process.exit(0);
  });
  lines.on("close", () => process.exit(0));

  setup?.(tb);
  return tb;
}
