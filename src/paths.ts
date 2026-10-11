// Where a session lives. One session per checkout (git toplevel), so parallel
// agents in different worktrees never share a display, port or data dir.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function findRoot(cwd = process.cwd()): string {
  if (process.env.APPDRIVE_ROOT) return path.resolve(process.env.APPDRIVE_ROOT);
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

export function rootHash(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 10);
}

export interface Layout {
  root: string;
  /** `<root>/.appdrive`: self-ignoring, so the app's repo needs no .gitignore entry. */
  dir: string;
  session: string;
  log: string;
  shots: string;
  logs: string;
  frame: string;
  /** Private XDG config/data/cache/state homes, kept between runs so caches stay warm. */
  home: string;
  /** Shims that stand in for xdg-open, zenity and friends. */
  bin: string;
  /**
   * The app's XDG_RUNTIME_DIR. Short and outside the checkout because socket
   * paths cap at 108 bytes; private so the app finds no Wayland, Hyprland or
   * session-bus socket there.
   */
  runtime: string;
  /** Display claims shared by every session on this machine. */
  claims: string;
  /**
   * This session's entry in the machine-wide registry (one JSON file per
   * running session), read by the Orca plugin to find dashboards.
   */
  registry: string;
}

export function layout(root: string): Layout {
  const dir = path.join(root, ".appdrive");
  const runBase = process.env.XDG_RUNTIME_DIR || path.join(tmpdir(), `appdrive-${process.getuid?.() ?? "u"}`);
  return {
    root,
    dir,
    session: path.join(dir, "session.json"),
    log: path.join(dir, "log.jsonl"),
    shots: path.join(dir, "shots"),
    logs: path.join(dir, "logs"),
    frame: path.join(dir, "frame.png"),
    home: path.join(dir, "home"),
    bin: path.join(dir, "bin"),
    runtime: path.join(runBase, "appdrive", rootHash(root)),
    claims: path.join(runBase, "appdrive", "claims"),
    registry: path.join(runBase, "appdrive", "sessions", `${rootHash(root)}.json`),
  };
}

export function ensureLayout(l: Layout): void {
  for (const d of [l.dir, l.shots, l.logs, l.bin, l.claims, path.dirname(l.registry)]) mkdirSync(d, { recursive: true });
  for (const d of ["config", "data", "cache", "state"]) mkdirSync(path.join(l.home, d), { recursive: true });
  mkdirSync(l.runtime, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(l.dir, ".gitignore"), "*\n");
}
