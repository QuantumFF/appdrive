#!/usr/bin/env bun
// appdrive: launch, drive and screenshot a Tauri/WebKitGTK app on a hidden
// display. No pointer, focus, workspace or monitor side effects.
import { describeWindow, type ListedWindow } from "./native.ts";
import { ensureLayout, findRoot, layout } from "./paths.ts";
import { loadProfile } from "./profile.ts";
import { type LaunchOptions, launchDaemon, Session } from "./session.ts";

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

/** The running session, or exit telling the agent to launch. */
function session(): Session {
  const s = Session.read(L.session);
  if (!s || !s.alive()) die(`no session in ${root}. Run \`appdrive launch\` first.`);
  s.onNotices = (notices) => {
    for (const n of notices) console.error(`appdrive notice: ${n}`);
  };
  return s;
}

async function stopSession(): Promise<void> {
  const s = Session.read(L.session);
  if (!s) return console.log("no session running");
  await s.stop();
  console.log("stopped");
}

function parseSize(v: string | boolean | undefined): { width: number; height: number } | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)x(\d+)$/.exec(v);
  if (!m) die(`size must look like 1280x800, got ${v}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

async function launch({ flags, env }: Parsed): Promise<void> {
  const existing = Session.read(L.session);
  if (existing?.alive()) {
    const st = await existing.status();
    if (flags.restart || !st || ["crashed", "failed", "stopping"].includes(st.phase)) {
      console.error(`appdrive: stopping the previous session (${st?.phase ?? "unresponsive"})`);
      await existing.stop();
    } else {
      console.log(`already running: ${st.app} (${st.phase}) on ${st.display}; dashboard ${st.dashboard}`);
      console.log("Use `appdrive launch --restart` after Rust changes; frontend changes hot-reload.");
      return;
    }
  } else if (existing) {
    await existing.stop();
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
  console.error(`appdrive: launching ${profile.name} from ${root}`);
  let st;
  try {
    st = await launchDaemon(L, opts, (line) => console.error(`appdrive: ${line}`));
  } catch (e) {
    die((e as Error).message);
  }
  console.log(`ready: ${st.app} on hidden display ${st.display} (${st.screen}), dev port ${st.devPort ?? "-"}`);
  for (const [k, v] of Object.entries(st.appEnv ?? {})) console.log(`env: ${k}=${v}`);
  console.log(`dashboard: ${st.dashboard}`);
  console.log(`state: ${L.dir}`);
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
      const s = Session.read(L.session);
      if (!s?.alive()) return print("no session");
      return print((await s.status()) ?? "daemon not responding");
    }
    case "dashboard":
      return print(session().file.url);
  }
  const s = session();
  const api = async <T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> => {
    try {
      return await s.op<T>(op, args);
    } catch (e) {
      die((e as Error).message);
    }
  };
  const need = (n: number, what: string) => {
    if (pos.length < n) die(`${cmd} needs ${what}. See \`appdrive help\`.`);
  };
  switch (cmd) {
    case "outline": {
      const r = await api("outline");
      console.log(`${r.title} — ${r.url} — ${r.viewport}, focused: ${r.focused}`);
      console.log(r.lines.join("\n") || "(no visible controls)");
      return;
    }
    case "query":
      need(1, "a selector");
      return print(await api("query", { sel: pos[0], all: !!flags.all, timeout: common.timeout }));
    case "click":
      need(1, "a selector");
      return print(
        await api("click", {
          sel: pos[0],
          ...common,
          double: !!flags.double,
          force: !!flags.force,
          button: typeof flags.button === "string" ? flags.button : undefined,
        }),
      );
    case "hover":
      need(1, "a selector");
      return print(await api("hover", { sel: pos[0], ...common }));
    case "type":
      if (flags.focused) {
        need(1, "the text");
        return print(await api("type", { focused: true, text: pos.join(" ") }));
      }
      need(2, "a selector and the text");
      return print(await api("type", { sel: pos[0], text: pos.slice(1).join(" "), clear: !!flags.clear, ...common }));
    case "key":
      need(1, "keys");
      return print(await api("key", { keys: pos.join(" ") }));
    case "wait":
      need(1, "a selector");
      return print(await api("wait", { sel: pos[0], gone: !!flags.gone, timeout: common.timeout }));
    case "shot": {
      const r = await api("shot", {
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
      return print(await api("eval", { code: pos.join(" "), timeout: common.timeout }));
    case "resize": {
      need(1, "a size like 1024x768");
      const size = parseSize(pos[0])!;
      return print(await api("resize", size));
    }
    case "reload":
      return print(await api("reload"));
    case "dismiss":
      return print(await api("dismiss"));
    case "windows": {
      const list = await api<ListedWindow[]>("windows");
      for (const w of list) console.log(`${w.app ? "app   " : "native"} ${w.id}  ${describeWindow(w)}`);
      if (!list.length) console.log("no windows");
      return;
    }
    case "xkey":
      need(1, "keys");
      return print(await api("xkey", { keys: pos.join(" "), window: flags.window }));
    case "xtype":
      need(1, "the text");
      return print(await api("xtype", { text: pos.join(" "), window: flags.window }));
    case "xclick":
      need(2, "x and y screen coordinates");
      return print(
        await api("xclick", {
          x: Number(pos[0]),
          y: Number(pos[1]),
          double: !!flags.double,
          button: typeof flags.button === "string" ? flags.button : undefined,
        }),
      );
    case "log": {
      const entries = await api<any[]>("log", { n: num(pos[0]) ?? 30 });
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
