// Orca plugin worker for appdrive. Orca forks it on demand and reaps it when
// idle, so it holds no state of its own: running sessions are read from the
// registry each appdrive daemon publishes in $XDG_RUNTIME_DIR/appdrive/sessions,
// and tabs and comments go through the orca-ide CLI.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
export const REGISTRY = path.join(runtimeDir, "appdrive", "sessions");
const ORCA_IDE = [process.env.ORCA_IDE, path.join(homedir(), ".local", "bin", "orca-ide")].find((p) => p && existsSync(p)) ?? "orca-ide";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Running appdrive sessions, newest first. */
export function sessions(dir = REGISTRY) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const s = JSON.parse(readFileSync(path.join(dir, n), "utf8"));
      if (s && typeof s.pid === "number" && alive(s.pid)) out.push(s);
    } catch {}
  }
  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export function orca(args, run = execFile) {
  return new Promise((resolve) => {
    run(ORCA_IDE, [...args, "--json"], { timeout: 8000 }, (_err, stdout) => {
      try {
        const j = JSON.parse(String(stdout));
        resolve(j?.ok === false ? null : j?.result ?? null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * The focused worktree's path. readContext names it only by branch and display
 * name (four worktrees can all be "main"), but its terminal ids pin it down.
 */
export async function focusedWorktreePath(ctx, call = orca) {
  const fc = await ctx.host.call("workspace.readContext").catch(() => null);
  if (!fc) return null;
  const ids = (fc.terminals ?? []).map((t) => t.id);
  for (const id of ids) {
    const m = /::(\/.+?)(?:@@|$)/.exec(id);
    if (m) return m[1];
  }
  if (ids.length) {
    const terms = (await call(["terminal", "list"]))?.terminals ?? [];
    const hit = terms.find((t) => ids.includes(t.handle) || ids.includes(t.ptyId));
    if (hit?.worktreePath) return hit.worktreePath;
  }
  const wts = (await call(["worktree", "list"]))?.worktrees ?? [];
  const same = wts.filter((w) => w.displayName === fc.displayName && String(w.branch ?? "").replace(/^refs\/heads\//, "") === fc.branch);
  return same.length === 1 ? same[0].path : null;
}

/** Shows the dashboard tab in the session's worktree, reusing an open one. */
export async function openDashboard(s, call = orca) {
  const sel = `path:${s.root}`;
  const tabs = (await call(["tab", "list", "--worktree", sel]))?.tabs ?? [];
  const open = tabs.find((t) => typeof t.url === "string" && t.url.startsWith(s.url));
  if (open) return call(["tab", "switch", "--page", open.browserPageId, "--worktree", sel]);
  return call(["tab", "create", "--url", s.url, "--worktree", sel]);
}

function describe(s) {
  return `${s.app} · ${path.basename(s.root)} · ${s.phase}${s.lastAction ? ` · ${s.lastAction}` : ""}`;
}

export default async function activate(ctx, deps = {}) {
  const list = deps.sessions ?? sessions;
  const call = deps.orca ?? orca;
  const notify = (title, body) => ctx.host.call("notifications.show", { title, body: body?.slice(0, 1000) }).catch(() => null);

  ctx.commands.register("open-dashboard", async () => {
    const where = await focusedWorktreePath(ctx, call);
    const s = where ? list().find((x) => x.root === where) : null;
    if (!s) {
      await notify("appdrive", `No appdrive session in ${where ? path.basename(where) : "this worktree"}. An agent starts one with \`appdrive launch\`.`);
      return { opened: false };
    }
    await openDashboard(s, call);
    return { opened: true, url: s.url };
  });

  ctx.commands.register("open-all", async () => {
    const all = list();
    for (const s of all) await openDashboard(s, call);
    if (!all.length) await notify("appdrive", "No appdrive sessions are running.");
    return { opened: all.length };
  });

  ctx.commands.register("status", async () => {
    const all = list();
    await notify(
      all.length ? `appdrive: ${all.length} session${all.length === 1 ? "" : "s"}` : "appdrive",
      all.length ? all.map(describe).join("\n") : "No appdrive sessions are running.",
    );
    return { sessions: all.length };
  });

  // Orca wakes the worker on agent activity; that is the moment to look for a
  // session that crashed or failed to launch, and say so once.
  ctx.events.on("agent.status.changed", async () => {
    const bad = list().filter((s) => s.phase === "crashed" || s.phase === "failed");
    if (!bad.length) return;
    const seen = (await ctx.host.call("storage.get", { key: "notified" }).catch(() => null))?.value ?? [];
    const fresh = bad.filter((s) => !seen.includes(`${s.root}@${s.startedAt}`));
    for (const s of fresh) {
      await notify(`appdrive: ${s.app} ${s.phase} in ${path.basename(s.root)}`, s.failure ?? "See the dashboard and .appdrive/logs.");
    }
    if (fresh.length) {
      const next = [...seen, ...fresh.map((s) => `${s.root}@${s.startedAt}`)].slice(-50);
      await ctx.host.call("storage.set", { key: "notified", value: next }).catch(() => null);
    }
  });
}
