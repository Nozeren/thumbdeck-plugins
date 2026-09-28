// window.thumbdeck: what a thumbdeck plugin page can do (plugin API 1). Types only: the API
// itself is put in every plugin frame by thumbdeck. Use it with
//   /// <reference types="@thumbdeck/plugin" />
//   const td = window.thumbdeck;
// The whole contract is SPEC.md in https://github.com/Nozeren/thumbdeck-plugins.

export {};

declare global {
  interface Window {
    /** The page API: there before the page's own scripts run */
    thumbdeck: Thumbdeck.Api;
  }
}

declare namespace Thumbdeck {
  /** A project in thumbdeck's list */
  interface Project {
    /** Its folder */
    path: string;
    /** The folder's name */
    name: string;
    /** The git branch; null when it isn't a git repository (or HEAD is detached) */
    branch: string | null;
  }

  /** Where this frame is */
  interface Context {
    plugin: {
      id: string;
      version: string;
      /** The plugin's folder */
      folder: string;
      /** A folder for the plugin's own files (created when first used) */
      dataFolder: string;
    };
    /** What kind of frame this is */
    surface: "tab" | "panel" | "page" | "view";
    /** The tab, panel or page id from plugin.toml */
    id: string;
    /** Fixed for tabs and project panels; null for app-wide frames */
    project: Project | null;
    /** A page's data, from ui.openPage */
    data?: unknown;
    /** The plugin API version thumbdeck speaks to this plugin */
    api: number;
    /** thumbdeck's version */
    thumbdeck: string;
  }

  /** A file or folder from fs.list */
  interface Entry {
    name: string;
    /** Its full path */
    path: string;
    size: number;
    /** Last change, in milliseconds since 1970 */
    modified: number;
    dir: boolean;
  }

  interface Stat {
    size: number;
    /** Last change, in milliseconds since 1970 */
    modified: number;
    dir: boolean;
  }

  /** What a command printed, and how it ended */
  interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
  }

  interface ExecOptions {
    /** Where to run it; the project folder by default */
    cwd?: string;
    /** More environment variables, on top of your login shell's */
    env?: Record<string, string>;
    /** Text for its standard input */
    input?: string;
    /** Milliseconds; 30 seconds by default. It's stopped after that. */
    timeout?: number;
  }

  /** A command run like a Toolkit button */
  interface Run {
    id: number;
    /** Each line it prints */
    onOutput(fn: (line: string, stderr: boolean) => void): void;
    /** Its exit code when it ends */
    onExit(fn: (code: number) => void): void;
    stop(): void;
    /** Resolves with its exit code */
    done: Promise<number>;
  }

  interface ReviewRequest {
    /** "Uncommitted changes", "a1b2c3d Fix login" */
    title: string;
    /** A second line: author, branch, when */
    subtitle?: string;
    /** A unified diff, or a function giving one (called again on r) */
    diff: string | (() => Promise<string>);
    /** Where the files you mark viewed are remembered (per plugin) */
    viewedKey: string;
    /** Open at this file */
    startFile?: string;
  }

  /** The avatar's signals (see SPEC.md, The avatar); null takes one back */
  type Mood =
    | ["waiting", string | null]
    | ["working", string | null]
    | ["reading", true | null]
    | ["review", number | null];

  interface Events {
    /** The frame is shown again */
    shown: null;
    /** The frame is hidden (stop polling) */
    hidden: null;
    /** Another project is selected (app-wide frames) */
    project: Project;
    /** The frame got or lost the keyboard */
    keyboard: boolean;
    /** One of its declared keys was pressed */
    key: { action: string; key: string };
    /** Its tab's setup was saved */
    setup: Record<string, any>;
    /** The plugin's settings were saved */
    settings: Record<string, any>;
    /** A Toolkit action (or td.run) in its project ended */
    run: { id: number; label: string; code: number };
    /** The thumbdeck window gained or lost focus */
    focus: boolean;
  }

  type Scope = { scope?: "app" | "project" };

  interface Api {
    /** Where this frame is (read at once, no waiting) */
    readonly context: Context;

    projects: {
      /** The selected project */
      selected(): Promise<Project | null>;
      /** Every project in the list, in its order */
      list(): Promise<Project[]>;
    };

    setup: {
      /** This tab's setup, every field filled in */
      get(): Promise<Record<string, any>>;
      /** Open the tab's setup form */
      edit(): void;
      /** Save the setup (only from a tab's setup_page) */
      save(value: Record<string, any>): Promise<void>;
    };

    settings: {
      /** The plugin's settings, every field filled in */
      get(): Promise<Record<string, any>>;
    };

    /** Small JSON values that survive restarts. Scope: "project" in project frames, "app" elsewhere. */
    storage: {
      get(key: string, o?: Scope): Promise<any>;
      set(key: string, value: any, o?: Scope): Promise<void>;
      remove(key: string, o?: Scope): Promise<void>;
    };

    /** Files. Paths are absolute, start with ~, or are relative to the project folder
     *  (to the data folder in app-wide frames). */
    fs: {
      /** Text (or base64), or a byte range of it: start and end, for following big files */
      read(path: string, o?: { encoding?: "utf8" | "base64"; start?: number; end?: number }): Promise<string>;
      write(path: string, text: string): Promise<void>;
      /** null when it isn't there */
      stat(path: string): Promise<Stat | null>;
      list(folder: string, o?: { pattern?: string; recursive?: boolean }): Promise<Entry[]>;
      /** Called when the file changes, appears or goes; returns a function that stops watching */
      watch(path: string, fn: (change: { path: string; kind: "changed" | "added" | "removed" }) => void): () => void;
    };

    /** Run a command and capture what it prints; nothing shows. A string runs through the
     *  shell (like in your terminal); a list runs the program directly (no quoting). */
    exec(command: string | string[], o?: ExecOptions): Promise<ExecResult>;

    /** Run a command like a Toolkit button: a tab with its output, in Running, a
     *  notification when it ends while you're elsewhere */
    run(command: string, o?: { label?: string; cwd?: string }): Promise<Run>;

    /** Type a command into a window of the project's tmux session; resolves with
     *  thumbdeck's short message */
    tmux(command: string, o: { window: string }): Promise<string>;

    ui: {
      /** A short message in the status line */
      say(text: string, o?: { error?: boolean }): void;
      /** A desktop notification */
      notify(title: string, body?: string): void;
      /** thumbdeck's own yes / no dialog */
      confirm(question: string, o?: { yes?: string; no?: string }): Promise<boolean>;
      /** In the browser */
      openUrl(url: string): void;
      /** One of this plugin's [[page]]s, over the whole window */
      openPage(id: string, data?: unknown): void;
      /** A page: close it */
      close(): void;
      /** thumbdeck's review page for a diff */
      openReview(r: ReviewRequest): void;
      /** Next to the tab's or panel's title; null: none */
      badge(value: string | number | null): void;
      /** The view: next to its name in the Plugins pane; null: none */
      status(text: string | null): void;
      /** Tell the avatar what's going on */
      mood(...signal: Mood): void;
    };

    actions: {
      /** Ask the backend for this project's Toolkit buttons again */
      refresh(): void;
    };

    keys: {
      /** Switch to another of its keymaps (from plugin.toml [keys]) */
      use(map: string): void;
      /** Ask for the keyboard */
      take(): void;
      /** Give it back to thumbdeck */
      release(): void;
    };

    backend: {
      /** Call the plugin's backend; throws its error message */
      call(method: string, params?: unknown): Promise<any>;
      /** Events the backend sends */
      on(event: string, fn: (data: any) => void): () => void;
    };

    /** Listen to an event; returns a function that stops listening */
    on<E extends keyof Events>(event: E, fn: (data: Events[E]) => void): () => void;

    /** Text made safe for putting into HTML */
    escape(text: string): string;
  }
}
