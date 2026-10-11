#!/usr/bin/env bun
// appdrive: launch, drive and screenshot a Tauri/WebKitGTK app on a hidden
// display. No pointer, focus, workspace or monitor side effects.
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { LaunchOptions } from "./daemon.ts";
import { findRoot, layout, ensureLayout } from "./paths.ts";
import { loadProfile } from "./profile.ts";
import { tail } from "./util.ts";

const USAGE = `appdrive: drive a Tauri app on a hidden display (no pointer, focus or monitor side effects)

  appdrive launch [--restart] [--fresh] [--no-build] [--no-orca] [--size WxH] [--idle MIN] [--env K=V]...
  appdrive status
  appdrive outline                           visible controls, each with a selector to use
  appdrive query <sel> [--all] [--timeout MS]   text, attributes, value, rect as JSON
  appdrive click <sel> [--nth N] [--double] [--button right] [--force]
  appdrive hover <sel>
  appdrive type <sel> <text> [--clear]  |  appdrive type --focused <text>
  appdrive key <keys>                        e.g. "Ctrl+K", "Escape", "ArrowDown ArrowDown Enter"
  appdrive wait <sel> [--gone] [--timeout MS]
  appdrive shot [sel] [--screen] [--max PX] [--name NAME]   prints the PNG path
  appdrive eval <js>                         expression or body with return; awaits promises
  appdrive resize <W>x<H>
  appdrive reload
  appdrive dismiss                           close native dialogs (portal file chooser, zenity): Escape, then end them
  appdrive windows                           X windows on the hidden display (the app's and native ones)
  appdrive xkey <keys> [--window ID]         X-level keys to the topmost native window, e.g. "Ctrl+L", "Escape"
  appdrive xtype <text> [--window ID]        X-level typing, e.g. a path into a file chooser after Ctrl+L
  appdrive xclick <x> <y> [--double] [--button right]   X-level click at screen pixels (shot --screen --max 0)
  appdrive log [N]
  appdrive dashboard                         print the dashboard URL
  appdrive stop

Selectors: CSS by default, or text=Exact label, text~=substring (case-insensitive), xpath=...
Chain with >> to search inside earlier matches: '[role=tab] >> text=Rank', 'dialog >> text=Save'.
Elements are found with a wait (5s for actions, 1s for query). --nth picks among matches (0-based).
State lives in <checkout>/.appdrive/ (screenshots in shots/, process logs in logs/).`;

interface Parsed {
  pos: string[];
  flags: Record<string, string | boolean>;
  env: string[];
}

const VALUED = new Set(["nth", "timeout", "max", "name", "size", "idle", "button", "window"]);

function parse(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const env: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) {
      pos.push(a);
      continue;
    }
    const [, key, inline] = m;
    if (key === "env") {
      const v = inline ?? argv[++i];
      if (!v || !v.includes("=")) die("--env takes KEY=VALUE");
      env.push(v);
    } else if (inline !== undefined) flags[key] = inline;
    else if (VALUED.has(key)) {
      if (i + 1 >= argv.length) die(`--${key} needs a value`);
      flags[key] = argv[++i];
    } else flags[key] = true;
  }
  return { pos, flags, env };
}

function die(msg: string, code = 1): never {
  console.error(`appdrive: ${msg}`);
  process.exit(code);
}

const root = findRoot();
const L = layout(root);

interface SessionFile {
  pid: number;
  port: number;
  url: string;
  groups: Record<string, number>;
}

function readSession(): SessionFile | null {
  try {
    return JSON.parse(readFileSync(L.session, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function api<T = any>(s: SessionFile, op: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${s.port}/api/op`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    die(`cannot reach the session daemon (pid ${s.pid}): ${(e as Error).message}`);
  }
  const body = (await res.json()) as { ok: boolean; result?: T; error?: string; notices?: string[] };
  for (const n of body.notices ?? []) console.error(`appdrive notice: ${n}`);
  if (!body.ok) die(body.error ?? "failed");
  return body.result as T;
}

async function getStatus(s: SessionFile): Promise<any | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/status`, { signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch {
    return null;
  }
}

/** The running session, or exit telling the agent to launch. */
async function session(): Promise<SessionFile> {
  const s = readSession();
  if (!s || !alive(s.pid)) die(`no session in ${root}. Run \`appdrive launch\` first.`);
  return s;
}

function killGroups(s: SessionFile): void {
  for (const pgid of Object.values(s.groups ?? {})) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }
}

async function stopSession(quiet = false): Promise<void> {
  const s = readSession();
  if (!s) {
    if (!quiet) console.log("no session running");
    return;
  }
  if (alive(s.pid)) {
    try {
      await fetch(`http://127.0.0.1:${s.port}/api/op`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "stop" }),
        signal: AbortSignal.timeout(3000),
      });
    } catch {}
    const end = Date.now() + 15_000;
    while (alive(s.pid) && Date.now() < end) await Bun.sleep(200);
    if (alive(s.pid)) {
      try {
        process.kill(s.pid, "SIGKILL");
      } catch {}
    }
  }
  // Whatever the daemon could not take down (it was killed, or crashed).
  killGroups(s);
  rmSync(L.session, { force: true });
  if (!quiet) console.log("stopped");
}

function parseSize(v: string | boolean | undefined): { width: number; height: number } | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)x(\d+)$/.exec(v);
  if (!m) die(`size must look like 1280x800, got ${v}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

async function launch({ flags, env }: Parsed): Promise<void> {
  const existing = readSession();
  if (existing && alive(existing.pid)) {
    const st = await getStatus(existing);
    if (flags.restart || !st || ["crashed", "failed", "stopping"].includes(st.phase)) {
      console.error(`appdrive: stopping the previous session (${st?.phase ?? "unresponsive"})`);
      await stopSession(true);
    } else {
      console.log(`already running: ${st.app} (${st.phase}) on ${st.display}; dashboard ${st.dashboard}`);
      console.log("Use `appdrive launch --restart` after Rust changes; frontend changes hot-reload.");
      return;
    }
  } else if (existing) {
    killGroups(existing);
    rmSync(L.session, { force: true });
  }

  let profile;
  try {
    profile = loadProfile(root);
  } catch (e) {
    die((e as Error).message);
  }
  ensureLayout(L);
  const opts: LaunchOptions = {
    root,
    build: !flags["no-build"],
    orca: !flags["no-orca"],
    fresh: !!flags.fresh,
    screen: parseSize(flags.size),
    idleMinutes: Number(flags.idle ?? 30),
    env: Object.fromEntries(env.map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)])),
  };
  const logFile = path.join(L.logs, "daemon.log");
  const fd = openSync(logFile, "w");
  const child = spawn(process.execPath, [path.join(import.meta.dir, "daemon.ts"), JSON.stringify(opts)], {
    cwd: root,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  console.error(`appdrive: launching ${profile.name} from ${root}`);

  let last = "";
  const end = Date.now() + 30 * 60_000;
  for (;;) {
    await Bun.sleep(300);
    const s = readSession();
    const st = s ? await getStatus(s) : null;
    if (!alive(child.pid!)) {
      const log = existsSync(logFile) ? tail(readFileSync(logFile, "utf8"), 20) : "";
      die(`the session daemon exited during launch:\n${log}`);
    }
    if (!st) continue;
    const line = `${st.phase}${st.detail ? `: ${st.detail}` : ""}`;
    if (line !== last && st.phase !== "ready" && st.phase !== "failed") console.error(`appdrive: ${line}`);
    last = line;
    if (st.phase === "ready") {
      console.log(`ready: ${st.app} on hidden display ${st.display} (${st.screen}), dev port ${st.devPort ?? "-"}`);
      for (const [k, v] of Object.entries(st.appEnv ?? {})) console.log(`env: ${k}=${v}`);
      console.log(`dashboard: ${st.dashboard}`);
      console.log(`state: ${L.dir}`);
      return;
    }
    if (st.phase === "failed") die(`launch failed: ${st.failure}\n(logs in ${L.logs})`);
    if (Date.now() > end) die("launch is taking over 30 minutes; check .appdrive/logs/");
  }
}

function num(v: string | boolean | undefined): number | undefined {
  if (v === undefined || typeof v === "boolean") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) die(`expected a number, got ${v}`);
  return n;
}

function print(v: unknown): void {
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const parsed = parse(rest);
  const { pos, flags } = parsed;
  const common = { nth: num(flags.nth), timeout: num(flags.timeout) };
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    case "launch":
      return launch(parsed);
    case "stop":
      return stopSession();
    case "status": {
      const s = readSession();
      if (!s || !alive(s.pid)) return print("no session");
      return print((await getStatus(s)) ?? "daemon not responding");
    }
    case "dashboard":
      return print((await session()).url);
  }
  const s = await session();
  const need = (n: number, what: string) => {
    if (pos.length < n) die(`${cmd} needs ${what}. See \`appdrive help\`.`);
  };
  switch (cmd) {
    case "outline": {
      const r = await api(s, "outline");
      console.log(`${r.title} — ${r.url} — ${r.viewport}, focused: ${r.focused}`);
      console.log(r.lines.join("\n") || "(no visible controls)");
      return;
    }
    case "query":
      need(1, "a selector");
      return print(await api(s, "query", { sel: pos[0], all: !!flags.all, timeout: common.timeout }));
    case "click":
      need(1, "a selector");
      return print(
        await api(s, "click", {
          sel: pos[0],
          ...common,
          double: !!flags.double,
          force: !!flags.force,
          button: typeof flags.button === "string" ? flags.button : undefined,
        }),
      );
    case "hover":
      need(1, "a selector");
      return print(await api(s, "hover", { sel: pos[0], ...common }));
    case "type":
      if (flags.focused) {
        need(1, "the text");
        return print(await api(s, "type", { focused: true, text: pos.join(" ") }));
      }
      need(2, "a selector and the text");
      return print(await api(s, "type", { sel: pos[0], text: pos.slice(1).join(" "), clear: !!flags.clear, ...common }));
    case "key":
      need(1, "keys");
      return print(await api(s, "key", { keys: pos.join(" ") }));
    case "wait":
      need(1, "a selector");
      return print(await api(s, "wait", { sel: pos[0], gone: !!flags.gone, timeout: common.timeout }));
    case "shot": {
      const r = await api(s, "shot", {
        sel: pos[0],
        nth: common.nth,
        screen: !!flags.screen,
        max: num(flags.max),
        name: typeof flags.name === "string" ? flags.name : undefined,
      });
      const scaled = r.scaledFrom ? ` (scaled from ${r.scaledFrom.width}x${r.scaledFrom.height})` : "";
      console.log(`${r.path}  ${r.width}x${r.height}${scaled}`);
      return;
    }
    case "eval":
      need(1, "JavaScript");
      return print(await api(s, "eval", { code: pos.join(" "), timeout: common.timeout }));
    case "resize": {
      need(1, "a size like 1024x768");
      const size = parseSize(pos[0])!;
      return print(await api(s, "resize", size));
    }
    case "reload":
      return print(await api(s, "reload"));
    case "dismiss":
      return print(await api(s, "dismiss"));
    case "windows": {
      const list = await api<any[]>(s, "windows");
      for (const w of list) {
        console.log(`${w.app ? "app   " : "native"} ${w.id}  ${w.name ? JSON.stringify(w.name) : "untitled"} ${w.width}x${w.height}+${w.x}+${w.y}`);
      }
      if (!list.length) console.log("no windows");
      return;
    }
    case "xkey":
      need(1, "keys");
      return print(await api(s, "xkey", { keys: pos.join(" "), window: flags.window }));
    case "xtype":
      need(1, "the text");
      return print(await api(s, "xtype", { text: pos.join(" "), window: flags.window }));
    case "xclick":
      need(2, "x and y screen coordinates");
      return print(
        await api(s, "xclick", {
          x: Number(pos[0]),
          y: Number(pos[1]),
          double: !!flags.double,
          button: typeof flags.button === "string" ? flags.button : undefined,
        }),
      );
    case "log": {
      const entries = await api<any[]>(s, "log", { n: num(pos[0]) ?? 30 });
      for (const e of entries) {
        const t = new Date(e.t).toLocaleTimeString();
        const mark = e.ok === false ? "✗" : "✓";
        console.log(`${t} ${mark} ${e.op}${e.args ? ` ${e.args}` : ""}${e.summary ? ` → ${e.summary}` : ""}${e.error ? ` → ${e.error}` : ""}`);
      }
      return;
    }
    default:
      die(`unknown command ${cmd}. See \`appdrive help\`.`);
  }
}

await main();
