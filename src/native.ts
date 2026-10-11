// Native windows: whatever opens on the hidden display besides the app's own
// window (a portal file chooser, a zenity box, a file manager). WebDriver cannot
// reach them, so they are seen and driven at the X level, and noticed when they
// appear so the agent hears about them.
import path from "node:path";
import { parseXKeys, XConnection, type XWindow } from "./xproto.ts";

/** The hidden display as X sees it. XConnection is the real one. */
export interface Display {
  windows(): Promise<XWindow[]>;
  focus(win: number): Promise<void>;
  keys(chord: number[]): Promise<void>;
  type(text: string): Promise<void>;
  click(x: number, y: number, button: number, count: number): Promise<void>;
  close(): void;
}

export interface NativeOptions {
  /** Opens a connection; called again after one fails. */
  connect: () => Promise<Display>;
  /** Processes that may own native windows, pid → name. */
  helpers: () => Promise<Map<number, string>>;
  kill?: (pid: number) => void;
  pause?: (ms: number) => Promise<void>;
}

/** A window id as the CLI passed it (`--window 4194311`). */
export type WindowId = number | string | null;

export type ListedWindow = XWindow & { app: boolean };

const ESCAPE = 0xff1b;

export function describeWindow(w: XWindow): string {
  return `${w.name ? JSON.stringify(w.name) : "untitled"} ${w.width}x${w.height}+${w.x}+${w.y}`;
}

export class NativeWindows {
  /** The app's pid (WebDriver's webkit:processID); its windows are not native. 0 until known. */
  appPid = 0;
  private conn: Display | null = null;
  private known = new Set<number>();
  private pause: (ms: number) => Promise<void>;

  constructor(private o: NativeOptions) {
    this.pause = o.pause ?? Bun.sleep;
  }

  /** Every window on the display, the app's included. */
  async all(): Promise<ListedWindow[]> {
    const wins = await this.use((d) => d.windows());
    return wins.map((w) => ({ ...w, app: this.appPid !== 0 && w.pid === this.appPid }));
  }

  async native(): Promise<XWindow[]> {
    return (await this.all()).filter((w) => !w.app).map(({ app: _, ...w }) => w);
  }

  /** Native windows that were not there last time (the first time, every one). */
  async appeared(): Promise<XWindow[]> {
    const wins = await this.native();
    const fresh = wins.filter((w) => !this.known.has(w.id));
    this.known = new Set(wins.map((w) => w.id));
    return fresh;
  }

  /**
   * X key chords ("Ctrl+L Escape") to the window asked for, else the topmost
   * native one, else whatever has focus (the app). Returns the window keyed.
   */
  async keys(spec: string, window?: WindowId): Promise<XWindow | null> {
    const chords = parseXKeys(spec);
    const target = await this.target(window);
    await this.use(async (d) => {
      if (target) await d.focus(target.id);
      for (const chord of chords) await d.keys(chord);
    });
    return target;
  }

  /** Typing, targeted like keys(). */
  async type(text: string, window?: WindowId): Promise<XWindow | null> {
    const target = await this.target(window);
    await this.use(async (d) => {
      if (target) await d.focus(target.id);
      await d.type(text);
    });
    return target;
  }

  async click(x: number, y: number, o: { button?: string; double?: boolean } = {}): Promise<{ x: number; y: number }> {
    const px = Math.round(x);
    const py = Math.round(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error("xclick needs screen coordinates: xclick <x> <y>");
    const button = o.button === "right" ? 3 : o.button === "middle" ? 2 : 1;
    await this.use((d) => d.click(px, py, button, o.double ? 2 : 1));
    return { x: px, y: py };
  }

  /**
   * Closes every native window: Escape first, the way a person would (a first
   * Escape may only close a popup inside a dialog), then ends the helpers.
   */
  async dismiss(): Promise<{ done: string[]; remaining: XWindow[] }> {
    const done: string[] = [];
    for (let round = 0; round < 3; round++) {
      const open = await this.native();
      if (!open.length) break;
      await this.use(async (d) => {
        for (const w of open.reverse()) {
          await d.focus(w.id).catch(() => {});
          await d.keys([ESCAPE]).catch(() => {});
          if (round === 0) done.push(`Escape → ${describeWindow(w)}`);
        }
      });
      await this.pause(400);
    }
    if ((await this.native()).length) {
      const helpers = await this.o.helpers();
      const kill =
        this.o.kill ??
        ((pid: number) => {
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
        });
      for (const pid of helpers.keys()) kill(pid);
      done.push(...new Set([...helpers.values()].map((n) => `ended ${n}`)));
      await this.pause(300);
    }
    return { done, remaining: await this.native() };
  }

  close(): void {
    this.conn?.close();
    this.conn = null;
  }

  private async target(window: WindowId | undefined): Promise<XWindow | null> {
    const wins = await this.native();
    if (window !== undefined && window !== null && window !== "") {
      const w = wins.find((w) => w.id === Number(window));
      if (!w) throw new Error(`no native window ${window}; see \`appdrive windows\``);
      return w;
    }
    return wins[wins.length - 1] ?? null;
  }

  /** Runs on the connection, opening one if needed; a failure drops it so the next call reconnects. */
  private async use<T>(fn: (d: Display) => Promise<T>): Promise<T> {
    try {
      this.conn ??= await this.o.connect();
      return await fn(this.conn);
    } catch (e) {
      this.close();
      throw e;
    }
  }
}

// Programs whose windows count as native dialogs or file managers.
const HELPER = /^(xdg-desktop-portal-(gtk|kde|gnome)|zenity|kdialog|yad|dolphin|nautilus|thunar|nemo|pcmanfm(-qt)?)$/;

/** The helper processes in a process group, by `ps`. */
export async function helpersInGroup(pgid: number | undefined): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pgid) return out;
  const proc = Bun.spawn(["ps", "-o", "pid=,args=", "-g", String(pgid)], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const name = path.basename(m[2]);
    if (HELPER.test(name)) out.set(Number(m[1]), name);
  }
  return out;
}

/** The real display: XTEST and the core protocol over its socket. */
export function xDisplay(display: () => number | null): () => Promise<Display> {
  return async () => {
    const n = display();
    if (n === null) throw new Error("no display yet");
    return XConnection.open(n);
  };
}
