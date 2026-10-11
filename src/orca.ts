// The Orca side: an embedded browser tab on the dashboard, and the worktree
// card's comment showing the last action. Everything here is best effort; a
// session runs the same without Orca.
import { spawn } from "node:child_process";

const CLI = "orca-ide"; // bare `orca` is the GNOME screen reader on this machine

function run(args: string[], timeoutMs = 8000): Promise<{ ok: boolean; json: any; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(CLI, [...args, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, json: null, out: "orca-ide not found" });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => resolve({ ok: false, json: null, out: "orca-ide not found" }));
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {}
      resolve({ ok: code === 0 && json?.ok !== false, json, out });
    });
  });
}

function collectUrls(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectUrls(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectUrls(x, out));
  return out;
}

export class Orca {
  readonly selector: string;
  enabled = false;
  originalComment: string | null = null;
  private pending: string | null = null;
  private busy = false;
  private lastSent = 0;

  constructor(
    root: string,
    private log: (msg: string) => void,
  ) {
    this.selector = `path:${root}`;
  }

  /** True when Orca knows this checkout as a worktree. */
  async init(): Promise<boolean> {
    const r = await run(["worktree", "show", "--worktree", this.selector]);
    const wt = r.json?.result?.worktree;
    if (!r.ok || !wt) {
      this.log(`orca: not an Orca worktree or Orca not running (${r.out.trim().slice(0, 120)})`);
      return false;
    }
    this.enabled = true;
    this.originalComment = typeof wt.comment === "string" ? wt.comment : "";
    return true;
  }

  /** Opens the dashboard in the worktree, unless a tab on it is already open. */
  async openTab(url: string): Promise<void> {
    if (!this.enabled) return;
    const tabs = await run(["tab", "list", "--worktree", this.selector]);
    if (tabs.ok && collectUrls(tabs.json?.result).some((u) => u.startsWith(url))) {
      this.log(`orca: dashboard tab already open (${url})`);
      return;
    }
    const r = await run(["tab", "create", "--url", url, "--worktree", this.selector]);
    this.log(r.ok ? `orca: opened dashboard tab ${url}` : `orca: tab create failed: ${r.out.trim().slice(0, 200)}`);
  }

  /** Sets the card comment; calls coalesce so a burst of actions sends one update. */
  comment(text: string): void {
    if (!this.enabled) return;
    this.pending = text.length > 140 ? text.slice(0, 139) + "…" : text;
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.busy || this.pending === null) return;
    this.busy = true;
    const wait = Math.max(0, this.lastSent + 1000 - Date.now());
    if (wait) await Bun.sleep(wait);
    const text = this.pending;
    this.pending = null;
    if (text !== null) {
      await run(["worktree", "set", "--worktree", this.selector, "--comment", text]);
      this.lastSent = Date.now();
    }
    this.busy = false;
    if (this.pending !== null) void this.flush();
  }

  /** Waits for the last queued comment to land. */
  async settle(): Promise<void> {
    while (this.busy || this.pending !== null) await Bun.sleep(100);
  }

  /**
   * Puts back the comment the card had before the session. Orca's CLI cannot
   * set an empty comment (it drops "" as absent), so a card that had none gets
   * `fallback` instead: the session's final status.
   */
  async restore(fallback: string): Promise<void> {
    if (!this.enabled) return;
    this.pending = null;
    await this.settle();
    await run(["worktree", "set", "--worktree", this.selector, "--comment", this.originalComment?.trim() ? this.originalComment : fallback]);
  }
}
