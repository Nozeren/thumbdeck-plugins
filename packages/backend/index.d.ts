// @thumbdeck/backend: write a thumbdeck plugin backend in Node (plugin API 1).

/** thumbdeck's side, for a backend */
export interface Thumbdeck {
  /** What initialize said; settings stay up to date */
  info: { api: number; thumbdeck: string; folder: string; dataFolder: string; settings: Record<string, any> } | null;
  /** An event for the plugin's pages: they get it with thumbdeck.backend.on(name) */
  event(name: string, data?: unknown): void;
  /** A short message in the status line */
  say(text: string, o?: { error?: boolean }): void;
  /** A desktop notification */
  notify(title: string, body?: string): void;
  /** Next to the titles of the plugin's tabs; null: none */
  badge(value: string | number | null): void;
  /** Next to the plugin's view in the Plugins pane; null: none */
  status(text: string | null): void;
  /** Tell the avatar what's going on (see SPEC.md, The avatar) */
  mood(signal: "waiting" | "working" | "reading" | "review", value: string | number | boolean | null): void;
  /** Ask for this plugin's Toolkit buttons again */
  refreshActions(): void;
  /** Small JSON values that survive restarts; `project` (a folder) for project scope */
  storage: {
    get(key: string, o?: { scope?: "app" | "project"; project?: string }): Promise<any>;
    set(key: string, value: any, o?: { scope?: "app" | "project"; project?: string }): Promise<void>;
    remove(key: string, o?: { scope?: "app" | "project"; project?: string }): Promise<void>;
  };
  /** Any request to thumbdeck, by method */
  request(method: string, params?: unknown): Promise<any>;
}

/** A project, as requests carry it */
export interface Project {
  path: string;
  name: string;
}

/** A Toolkit button, answered to `actions` */
export interface Action {
  name: string;
  command: string;
  description?: string;
  confirm?: boolean;
  /** true (a window named after it) or a window name: run in the project's tmux session */
  tmux?: boolean | string;
}

/** The backend's functions, by method. Each gets the params (with `project` for pages' calls)
 *  and thumbdeck's side; what it returns (or throws) is the answer. */
export interface Handlers {
  actions?(params: { project: Project }, tb: Thumbdeck): Action[] | Promise<Action[]>;
  initialize?(params: NonNullable<Thumbdeck["info"]>, tb: Thumbdeck): unknown;
  settings?(settings: Record<string, any>, tb: Thumbdeck): void;
  shutdown?(params: unknown, tb: Thumbdeck): unknown;
  [method: string]: ((params: any, tb: Thumbdeck) => unknown) | undefined;
}

/** Start answering thumbdeck; `setup` runs once, with thumbdeck's side */
export function serve(handlers?: Handlers, setup?: (tb: Thumbdeck) => void): Thumbdeck;
