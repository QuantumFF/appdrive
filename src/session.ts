// How the CLI and a session's daemon find and talk to each other: the session
// file in .appdrive/, the daemon's HTTP API on 127.0.0.1, and the launch
// handshake. The daemon writes and serves these shapes; the CLI reads them.
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { Layout } from "./paths.ts";
import { tail } from "./util.ts";

export interface LaunchOptions {
  root: string;
  build: boolean;
  orca: boolean;
  fresh: boolean;
  screen: { width: number; height: number } | null;
  idleMinutes: number;
  /** Extra app env from `launch --env K=V`, over the profile's. */
  env: Record<string, string>;
}

export type Phase = "starting" | "building" | "display" | "devserver" | "driver" | "app" | "ready" | "crashed" | "failed" | "stopping";

/** `.appdrive/session.json`, rewritten whenever a process group starts or ends. */
export interface SessionFile {
  pid: number;
  port: number;
  url: string;
  root: string;
  app: string;
  display: number | null;
  startedAt: number;
  /** Process group ids by name, for a CLI to kill if the daemon dies. */
  groups: Record<string, number>;
}

/** GET /api/status, and `appdrive status`. */
export interface Status {
  phase: Phase;
  detail: string;
  failure: string | null;
  app: string;
  root: string;
  /** ":101" */
  display: string | null;
  /** "1280x800" */
  screen: string;
  devPort: number | null;
  appPid: number | null;
  appEnv: Record<string, string>;
  dashboard: string;
  pid: number;
  startedAt: number;
  actions: number;
  frameVersion: number;
  shots: string;
  logs: string;
}

/** The machine-wide registry entry (see Layout.registry), read by the Orca plugin. */
export interface RegistryEntry {
  root: string;
  app: string;
  url: string;
  pid: number;
  phase: Phase;
  failure: string | null;
  startedAt: number;
  lastAction: string;
}

/** POST /api/op replies. Notices ride on every reply but a note's own. */
export interface OpReply {
  ok: boolean;
  result?: unknown;
  error?: string;
  notices?: string[];
}

export const DAEMON = path.join(import.meta.dir, "daemon.ts");

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A session as the CLI sees it: through its session file and its daemon's API. */
export class Session {
  /** Called with the notices a reply carries: things the agent should hear about. */
  onNotices: (notices: string[]) => void = () => {};

  private constructor(
    readonly file: SessionFile,
    private sessionPath: string,
  ) {}

  /** The session whose file is at `sessionPath`, running or not; null when there is none. */
  static read(sessionPath: string): Session | null {
    try {
      return new Session(JSON.parse(readFileSync(sessionPath, "utf8")), sessionPath);
    } catch {
      return null;
    }
  }

  /** The daemon process is there (it may still not answer). */
  alive(): boolean {
    return pidAlive(this.file.pid);
  }

  /** Null when the daemon does not answer. */
  async status(timeoutMs = 3000): Promise<Status | null> {
    try {
      const r = await fetch(`${this.api}/status`, { signal: AbortSignal.timeout(timeoutMs) });
      return (await r.json()) as Status;
    } catch {
      return null;
    }
  }

  /** Runs an op; throws its error. */
  async op<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    let body: OpReply;
    try {
      const res = await fetch(`${this.api}/op`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op, args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = (await res.json()) as OpReply;
    } catch (e) {
      throw new Error(`cannot reach the session daemon (pid ${this.file.pid}): ${(e as Error).message}`);
    }
    if (body.notices?.length) this.onNotices(body.notices);
    if (!body.ok) throw new Error(body.error ?? "failed");
    return body.result as T;
  }

  /**
   * Asks the daemon to stop and waits for it; kills it if it does not, then
   * whatever process groups it left (it was killed, or crashed). The session
   * file goes too.
   */
  async stop(waitMs = 15_000): Promise<void> {
    if (this.alive()) {
      await this.op("stop", {}, 3000).catch(() => {});
      const end = Date.now() + waitMs;
      while (this.alive() && Date.now() < end) await Bun.sleep(200);
      if (this.alive()) {
        try {
          process.kill(this.file.pid, "SIGKILL");
        } catch {}
      }
    }
    for (const pgid of Object.values(this.file.groups ?? {})) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {}
    }
    rmSync(this.sessionPath, { force: true });
  }

  private get api(): string {
    return `http://127.0.0.1:${this.file.port}/api`;
  }
}

/**
 * Starts a detached daemon for `opts.root` and waits until its session is
 * ready, reporting each phase on the way. Throws when the launch fails or the
 * daemon dies. `layout` must exist (ensureLayout).
 */
export async function launchDaemon(
  L: Layout,
  opts: LaunchOptions,
  progress: (line: string) => void,
  o: { script?: string; timeoutMs?: number } = {},
): Promise<Status> {
  const logFile = path.join(L.logs, "daemon.log");
  const fd = openSync(logFile, "w");
  const child = spawn(process.execPath, [o.script ?? DAEMON, JSON.stringify(opts)], {
    cwd: opts.root,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  let last = "";
  const end = Date.now() + (o.timeoutMs ?? 30 * 60_000);
  for (;;) {
    await Bun.sleep(300);
    const st = (await Session.read(L.session)?.status()) ?? null;
    if (!child.pid || !pidAlive(child.pid)) {
      const log = existsSync(logFile) ? tail(readFileSync(logFile, "utf8"), 20) : "";
      throw new Error(`the session daemon exited during launch:\n${log}`);
    }
    if (st) {
      const line = `${st.phase}${st.detail ? `: ${st.detail}` : ""}`;
      if (line !== last && st.phase !== "ready" && st.phase !== "failed") progress(line);
      last = line;
      if (st.phase === "ready") return st;
      if (st.phase === "failed") throw new Error(`launch failed: ${st.failure}\n(logs in ${L.logs})`);
    }
    if (Date.now() > end) throw new Error(`launch is taking over ${Math.round((o.timeoutMs ?? 30 * 60_000) / 60_000)} minutes; check .appdrive/logs/`);
  }
}
