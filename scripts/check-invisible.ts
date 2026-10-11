#!/usr/bin/env bun
// Runs a whole appdrive session against a checkout and checks that the user's
// desktop never noticed: no new Hyprland client (polled every 200ms, so a
// window that flashes up counts), cursor, focus, monitors and workspaces as
// they were, X sockets intact, and the app's real config and storage untouched.
//
//   bun scripts/check-invisible.ts <checkout> [-- extra launch args]
//
// The scenario is walltare's; other apps need their own. The user may be
// working meanwhile, so a cursor or focus change is reported, not failed,
// unless it lands on a window this session made.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const checkout = path.resolve(process.argv[2] ?? ".");
const dashdash = process.argv.indexOf("--");
const extra = dashdash > 0 ? process.argv.slice(dashdash + 1) : [];
const appdrive = path.join(import.meta.dir, "..", "bin", "appdrive");
const IDENTIFIER = "com.quantumff.walltare";

function hypr<T = any>(what: string): T {
  return JSON.parse(execFileSync("hyprctl", [what, "-j"], { encoding: "utf8" }));
}

function cursor(): string {
  return execFileSync("hyprctl", ["cursorpos"], { encoding: "utf8" }).trim();
}

function mtimes(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = st.mtimeMs;
    }
  };
  walk(dir);
  return out;
}

function snapshot() {
  return {
    clients: new Map<string, any>(hypr<any[]>("clients").map((c) => [c.address, c])),
    active: hypr("activewindow")?.address ?? null,
    cursor: cursor(),
    monitors: hypr<any[]>("monitors").map((m) => `${m.name} ${m.width}x${m.height}@${m.x},${m.y}`).join(" | "),
    workspaces: hypr<any[]>("workspaces").map((w) => w.id).sort((a, b) => a - b).join(","),
    sockets: readdirSync("/tmp/.X11-unix").sort().join(","),
    config: mtimes(path.join(homedir(), ".config", IDENTIFIER)),
    data: mtimes(path.join(homedir(), ".local", "share", IDENTIFIER, "localstorage")),
  };
}

function descendants(pgids: number[]): Set<number> {
  const out = new Set<number>();
  for (const g of pgids) {
    const r = spawnSync("ps", ["-o", "pid=", "-g", String(g)], { encoding: "utf8" });
    for (const l of r.stdout.split("\n")) if (l.trim()) out.add(Number(l));
  }
  return out;
}

// A session left running would be in the "before" picture.
spawnSync(appdrive, ["stop"], { cwd: checkout, stdio: "ignore" });
const before = snapshot();
const seenClients = new Map<string, any>();
const ourPids = new Set<number>();
let polling = true;
const poller = (async () => {
  while (polling) {
    try {
      const sess = path.join(checkout, ".appdrive", "session.json");
      if (existsSync(sess)) {
        const s = JSON.parse(await Bun.file(sess).text());
        for (const p of descendants(Object.values(s.groups ?? {}) as number[])) ourPids.add(p);
      }
      for (const c of hypr<any[]>("clients")) if (!before.clients.has(c.address)) seenClients.set(c.address, c);
    } catch {}
    await Bun.sleep(200);
  }
})();

const steps: string[][] = [
  ["launch", "--restart", ...extra],
  ["outline"],
  ["click", "text=Library"],
  ["shot"],
  ["click", 'button[aria-label="Settings"]'],
  ["type", 'input[aria-label="Screen width"]', "1920", "--clear"],
  ["key", "Tab"],
  ["query", 'input[aria-label="Screen width"]'],
  ["click", "button >> text=Browse", "--nth", "0"],
  ["windows"],
  ["xkey", "Ctrl+L"],
  ["xtype", "/tmp"],
  ["shot", "--screen"],
  ["dismiss"],
  ["key", "Escape"],
  ["shot", "[role=tablist]"],
  ["log", "40"],
  ["stop"],
];

let failedStep: string | null = null;
const envProblems: string[] = [];

/** Reads the running app's environment and checks every isolation variable. */
function checkAppEnv(): string {
  const st = JSON.parse(spawnSync(appdrive, ["status"], { cwd: checkout, encoding: "utf8" }).stdout);
  const env = Object.fromEntries(
    readFileSync(`/proc/${st.appPid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
  );
  const state = path.join(checkout, ".appdrive");
  const want: [string, (v: string | undefined) => boolean][] = [
    ["WAYLAND_DISPLAY", (v) => v === undefined],
    ["HYPRLAND_INSTANCE_SIGNATURE", (v) => v === undefined],
    ["DISPLAY", (v) => !!v && Number(v.slice(1)) >= 100],
    ["GDK_BACKEND", (v) => v === "x11"],
    ["XDG_CONFIG_HOME", (v) => !!v?.startsWith(state)],
    ["XDG_DATA_HOME", (v) => !!v?.startsWith(state)],
    ["XDG_CACHE_HOME", (v) => !!v?.startsWith(state)],
    ["XDG_RUNTIME_DIR", (v) => !!v?.includes("/appdrive/")],
    ["DBUS_SESSION_BUS_ADDRESS", (v) => !!v && v !== process.env.DBUS_SESSION_BUS_ADDRESS],
  ];
  for (const [k, ok] of want) if (!ok(env[k])) envProblems.push(`app env ${k}=${env[k] ?? "(unset)"}`);
  return `app pid ${st.appPid}: ${want.map(([k]) => `${k}=${env[k] ?? "(unset)"}`).join(" ")}`;
}

for (const step of steps) {
  const r = spawnSync(appdrive, step, { cwd: checkout, encoding: "utf8", timeout: 20 * 60_000 });
  const out = (r.stdout + r.stderr).trim();
  console.log(`$ appdrive ${step.join(" ")}\n${out.split("\n").slice(0, step[0] === "log" ? 60 : 6).join("\n")}\n`);
  if (r.status !== 0 && !failedStep) failedStep = step.join(" ");
  if (step[0] === "launch" && r.status !== 0) break;
  if (step[0] === "launch") console.log(checkAppEnv() + "\n");
  // Give the poller a look between steps.
  await Bun.sleep(250);
}
await Bun.sleep(600);
polling = false;
await poller;
const after = snapshot();

const problems: string[] = [];
const notes: string[] = [];
const ours = [...seenClients.values()].filter((c) => ourPids.has(c.pid));
const strangers = [...seenClients.values()].filter((c) => !ours.includes(c));
if (ours.length) problems.push(`windows from this session reached Hyprland: ${ours.map((c) => `${c.class} "${c.title}" pid ${c.pid}`).join("; ")}`);
if (strangers.length) notes.push(`other new clients during the run (not from this session): ${strangers.map((c) => `${c.class} pid ${c.pid}`).join("; ")}`);
if (before.monitors !== after.monitors) problems.push(`monitors changed: ${before.monitors} → ${after.monitors}`);
if (before.sockets !== after.sockets) problems.push(`/tmp/.X11-unix changed: ${before.sockets} → ${after.sockets}`);
if (before.workspaces !== after.workspaces) notes.push(`workspaces changed: ${before.workspaces} → ${after.workspaces} (the user may have switched)`);
if (before.cursor !== after.cursor) notes.push(`cursor moved: ${before.cursor} → ${after.cursor} (appdrive never moves it; the user may have)`);
if (before.active !== after.active) {
  const now = after.clients.get(after.active);
  if (now && ourPids.has(now.pid)) problems.push(`focus went to a window of this session: ${now.class}`);
  else notes.push(`active window changed: ${before.active} → ${after.active} (not one of this session's)`);
}
for (const [label, b, a] of [
  ["~/.config/" + IDENTIFIER, before.config, after.config],
  ["~/.local/share/" + IDENTIFIER + "/localstorage", before.data, after.data],
] as const) {
  const changed = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => b[k] !== a[k]);
  if (changed.length) problems.push(`${label} changed: ${changed.join(", ")}`);
}
if (failedStep) problems.push(`step failed: appdrive ${failedStep}`);
problems.push(...envProblems);

console.log("=".repeat(60));
console.log(`session pids seen: ${ourPids.size}; Hyprland clients polled every 200ms`);
for (const n of notes) console.log(`note: ${n}`);
if (problems.length) {
  for (const p of problems) console.log(`FAIL: ${p}`);
  process.exit(1);
}
console.log("PASS: no window, focus, cursor, monitor, socket or config side effects from appdrive");
