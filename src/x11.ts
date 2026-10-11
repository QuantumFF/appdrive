// Picking an X display number that belongs to nobody else.
//
// Never `Xvfb -displayfd`: it walks up from :0 and takes the first number whose
// *abstract* socket is free. Hyprland's XWayland listens only on filesystem
// sockets (`/tmp/.X11-unix/X1` and `X1_`), so -displayfd picked :1, unlinked
// XWayland's socket path and bound its own. New X11 clients on the user's
// desktop then reached the hidden display (2026-10-11). The lock file did not
// stop it. So a number counts as free only when none of its four markers exist,
// and we claim it with an O_EXCL file before Xvfb starts.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import path from "node:path";

const SOCKET_DIR = "/tmp/.X11-unix";

/** Every X display number something on this machine is using, by any marker. */
export function displaysInUse(procNetUnix = readProcNetUnix(), socketDir = SOCKET_DIR, lockDir = "/tmp"): Set<number> {
  const used = new Set<number>();
  for (const name of safeReaddir(socketDir)) {
    const m = /^X(\d+)_?$/.exec(name);
    if (m) used.add(Number(m[1]));
  }
  for (const name of safeReaddir(lockDir)) {
    const m = /^\.X(\d+)-lock$/.exec(name);
    if (m) used.add(Number(m[1]));
  }
  // Abstract and filesystem sockets, bound or unlinked-but-listening.
  for (const m of procNetUnix.matchAll(/@?\/tmp\/\.X11-unix\/X(\d+)_?$/gm)) used.add(Number(m[1]));
  return used;
}

function readProcNetUnix(): string {
  try {
    return readFileSync("/proc/net/unix", "utf8");
  } catch {
    return "";
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DisplayClaim {
  display: number;
  release(): void;
}

/**
 * Claims a display number in [from, to) that no X server, lock file or other
 * appdrive session holds. The claim file lives in `claimDir` and names our pid,
 * so a claim left by a dead session is reclaimed.
 */
export function claimDisplay(claimDir: string, from = 100, to = 200, inUse = displaysInUse()): DisplayClaim {
  mkdirSync(claimDir, { recursive: true });
  for (let n = from; n < to; n++) {
    if (inUse.has(n)) continue;
    const file = path.join(claimDir, `display-${n}.claim`);
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, "utf8").trim());
      if (pid && pidAlive(pid)) continue;
      rmSync(file, { force: true });
    }
    let fd: number;
    try {
      fd = openSync(file, "wx");
    } catch {
      continue; // another session got there first
    }
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return { display: n, release: () => rmSync(file, { force: true }) };
  }
  throw new Error(`no free X display in :${from}..:${to - 1}`);
}

/** The /tmp/.X11-unix entries and abstract X sockets present right now. */
export function socketSnapshot(): Set<string> {
  const out = new Set(safeReaddir(SOCKET_DIR).map((n) => `${SOCKET_DIR}/${n}`));
  for (const m of readProcNetUnix().matchAll(/(@\/tmp\/\.X11-unix\/X\d+_?)$/gm)) out.add(m[1]);
  return out;
}

/** Sockets from `before` that are gone now: a sign Xvfb clobbered someone. */
export function vanishedSockets(before: Set<string>, ours: number): string[] {
  const now = socketSnapshot();
  const mine = new RegExp(`/X${ours}_?$`);
  return [...before].filter((s) => !now.has(s) && !mine.test(s));
}
