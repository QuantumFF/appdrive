// The session's child processes. Each runs detached in its own process group,
// so one signal takes the whole tree (dbus-daemon, the app, WebKit's helpers,
// Vite's children), and logs to `<logs>/<name>.log`.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { tail, withTimeout } from "./util.ts";

export interface Group {
  readonly name: string;
  /** Also the process group id. */
  readonly pid: number;
  readonly log: string;
  /** Resolves with the exit code (null when a signal ended it). */
  readonly exited: Promise<number | null>;
  /** Null while it runs; once it has ended, why, with the tail of its log. */
  ended(): string | null;
  signal(sig: NodeJS.Signals): void;
}

export interface GroupsOptions {
  cwd: string;
  logs: string;
  /** After every start and exit, e.g. to rewrite the session file's pgids. */
  onChange?: () => void;
  /** `how` is the exit code or the signal. */
  onExit?: (name: string, how: number | string) => void;
}

export class ProcessGroups {
  private running = new Map<string, Group>();

  constructor(private o: GroupsOptions) {}

  start(name: string, cmd: string, args: string[], env: Record<string, string | undefined>): Group {
    const log = path.join(this.o.logs, `${name}.log`);
    const fd = openSync(log, "w");
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd: this.o.cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
    let how: number | string | null = null;
    let spawnError: string | null = null;
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code, sig) => {
        how = code ?? sig ?? "?";
        resolve(code);
      });
      child.once("error", (e) => {
        // ENOENT and friends: no exit event follows.
        if (child.pid !== undefined) return;
        spawnError = e.message;
        how = e.message;
        resolve(null);
      });
    });
    const group: Group = {
      name,
      pid: child.pid ?? 0,
      log,
      exited,
      ended: () => {
        if (how === null) return null;
        const last = tailOf(log);
        return `${name} ${spawnError ? `could not start: ${spawnError}` : `exited (${how})`}${last ? `:\n${last}` : ""}`;
      },
      signal: (sig) => {
        if (!group.pid || how !== null) return;
        try {
          process.kill(-group.pid, sig);
        } catch {}
      },
    };
    this.running.set(name, group);
    void exited.then(() => {
      if (this.running.get(name) === group) this.running.delete(name);
      this.o.onChange?.();
      this.o.onExit?.(name, how!);
    });
    this.o.onChange?.();
    return group;
  }

  get(name: string): Group | undefined {
    return this.running.get(name);
  }

  /** Process group ids of what still runs, by name: for a CLI to kill if the daemon dies. */
  pgids(): Record<string, number> {
    return Object.fromEntries([...this.running].filter(([, g]) => g.pid).map(([name, g]) => [name, g.pid]));
  }

  /** SIGTERM in `order` (then the rest), SIGKILL whatever is left after `graceMs`. */
  async stopAll(order: string[] = [], graceMs = 4000): Promise<void> {
    const names = [...new Set([...order, ...this.running.keys()])];
    for (const name of names) this.running.get(name)?.signal("SIGTERM");
    const all = [...this.running.values()];
    await withTimeout(Promise.all(all.map((g) => g.exited)), graceMs, "children").catch(() => {
      for (const g of all) g.signal("SIGKILL");
    });
  }
}

function tailOf(file: string, lines = 15): string {
  try {
    return tail(readFileSync(file, "utf8"), lines);
  } catch {
    return "";
  }
}
