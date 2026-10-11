// One per checkout. Owns the hidden display, the dev server, WebKitWebDriver
// and the app session; serves the CLI's API and the dashboard on 127.0.0.1.
// Started detached by `appdrive launch`; its stdout is .appdrive/logs/daemon.log.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ActionLog, describeArgs } from "./actions.ts";
import { parseKeys, textActions } from "./keys.ts";
import { describeWindow, helpersInGroup, NativeWindows, xDisplay } from "./native.ts";
import { Orca } from "./orca.ts";
import { BRIEF, DESCRIBE, evalScript, FIND, OUTLINE, QUERY, SETTLE } from "./page.ts";
import { ensureLayout, layout, rootHash } from "./paths.ts";
import { ephemeralPort, freePort, isFreeEverywhere } from "./ports.ts";
import { ProcessGroups } from "./procs.ts";
import { bakedDevPort, expand, expandEnv, loadProfile } from "./profile.ts";
import { sandboxEnv, seedAppearance, writeShims } from "./sandbox.ts";
import type { LaunchOptions, OpReply, Phase, RegistryEntry, SessionFile, Status } from "./session.ts";
import { pngSize, slug, waitFor, withTimeout } from "./util.ts";
import { type ElementRef, elementId, WebDriver } from "./webdriver.ts";
import { claimDisplay, type DisplayClaim, socketSnapshot, vanishedSockets } from "./x11.ts";

const opts: LaunchOptions = JSON.parse(process.argv[2] ?? "{}");
const L = layout(opts.root);
if (opts.fresh) rmSync(L.home, { recursive: true, force: true });
ensureLayout(L);

const profile = loadProfile(opts.root);
const binary = path.resolve(opts.root, profile.binary);
const screen = opts.screen ?? profile.window;

let phase: Phase = "starting";
let detail = "";
let failure: string | null = null;
let stopping = false;
let display: number | null = null;
let claim: DisplayClaim | null = null;
let devPort: number | null = null;
let wdPort: number | null = null;
let lastActivity = Date.now();
let frameVersion = 0;
let lastFrameAt = 0;
const startedAt = Date.now();
const log = new ActionLog({
  file: L.log,
  onStart: (e) => broadcast("busy", e),
  onRecord(e) {
    publish();
    broadcast("action", e);
  },
});
const wd = new WebDriver("http://127.0.0.1:0");

function diag(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ---------------------------------------------------------------- dashboard server

const enc = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function broadcast(event: string, data: unknown): void {
  const chunk = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

const dashboardHtml = readFileSync(path.join(import.meta.dir, "dashboard.html"), "utf8");

function startServer(): ReturnType<typeof Bun.serve> {
  // Stable per checkout, so a dashboard tab left open in Orca reconnects to the
  // next session instead of a new tab opening each launch.
  const base = 47100 + (parseInt(rootHash(opts.root).slice(0, 6), 16) % 800);
  let lastError: unknown;
  for (let port = base; port < base + 40; port++) {
    try {
      return Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 0, fetch: route });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/" && req.method === "GET") {
    return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (p === "/events") {
    let ctl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        clients.add(c);
        c.enqueue(enc.encode(`event: hello\ndata: ${JSON.stringify({ status: status(), log: log.recent(200) })}\n\n`));
        if (phase === "ready") void captureFrame();
      },
      cancel() {
        clients.delete(ctl);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }
  if (p === "/frame.png") {
    if (!existsSync(L.frame)) return new Response("no frame yet", { status: 404 });
    return new Response(Bun.file(L.frame), { headers: { "cache-control": "no-store", "content-type": "image/png" } });
  }
  const shot = /^\/shots\/([\w.-]+\.png)$/.exec(p);
  if (shot) {
    const file = path.join(L.shots, shot[1]);
    if (!existsSync(file)) return new Response("gone", { status: 404 });
    return new Response(Bun.file(file), { headers: { "content-type": "image/png" } });
  }
  if (p === "/api/status") return Response.json(status());
  if (p === "/api/op" && req.method === "POST") {
    let body: { op?: string; args?: Record<string, any> };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: "body must be JSON" } satisfies OpReply, { status: 400 });
    }
    const op = String(body.op);
    // Notices go to the agent's next real command, not to the shims' own notes.
    const drain = () => (op === "note" ? [] : log.takeNotices());
    try {
      const result = await handleOp(op, body.args ?? {});
      return Response.json({ ok: true, result, notices: drain() } satisfies OpReply);
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message, notices: drain() } satisfies OpReply);
    }
  }
  return new Response("not found", { status: 404 });
}

const server = startServer();
const dashboardUrl = `http://127.0.0.1:${server.port}/`;
const orca = new Orca(opts.root, diag);

// ---------------------------------------------------------------- session file

function persist(): void {
  const file: SessionFile = {
    pid: process.pid,
    port: server.port!,
    url: dashboardUrl,
    root: opts.root,
    app: profile.name,
    display,
    startedAt,
    groups: groups.pgids(),
  };
  writeFileSync(L.session, JSON.stringify(file, null, 2));
}

function status(): Status {
  return {
    phase,
    detail,
    failure,
    app: profile.name,
    root: opts.root,
    display: display === null ? null : `:${display}`,
    screen: `${screen.width}x${screen.height}`,
    devPort,
    appPid: native.appPid || null,
    appEnv: opts.env ?? {},
    dashboard: dashboardUrl,
    pid: process.pid,
    startedAt,
    actions: log.count,
    frameVersion,
    shots: L.shots,
    logs: L.logs,
  };
}

function setPhase(p: Phase, d = ""): void {
  phase = p;
  detail = d;
  diag(`phase ${p}${d ? `: ${d}` : ""}`);
  broadcast("status", status());
  publish();
}

/** The machine-wide registry entry (see Layout.registry). */
function publish(): void {
  const entry: RegistryEntry = {
    root: opts.root,
    app: profile.name,
    url: dashboardUrl,
    pid: process.pid,
    phase,
    failure,
    startedAt,
    lastAction: log.last,
  };
  try {
    writeFileSync(L.registry, JSON.stringify(entry));
  } catch {}
}

// ---------------------------------------------------------------- processes

const groups = new ProcessGroups({
  cwd: opts.root,
  logs: L.logs,
  onChange: persist,
  onExit(name, how) {
    diag(`${name} exited (${how})`);
    if (!stopping && phase === "ready" && name !== "build") {
      failure = `${name} exited (${how}); see ${path.join(L.logs, `${name}.log`)}`;
      setPhase("crashed", failure);
      orca.comment(`appdrive ▸ ${profile.name} crashed: ${name} exited`);
    }
  },
});

// ---------------------------------------------------------------- launch

async function chooseDevPort(): Promise<number | null> {
  const ds = profile.devServer;
  if (!ds) return null;
  if (ds.scan === 0) {
    if (!(await isFreeEverywhere(ds.port))) {
      throw new Error(`port ${ds.port} is in use and ${profile.name}'s dev server cannot move (set devServer in .appdrive.json)`);
    }
    return ds.port;
  }
  // Reusing the port already compiled into the binary saves a rebuild.
  const baked = await bakedDevPort(binary);
  if (baked && (await isFreeEverywhere(baked))) return baked;
  if (!opts.build) {
    throw new Error(`the binary's dev port ${baked ?? "?"} is taken and --no-build forbids rebuilding for another`);
  }
  return freePort(ds.port, ds.scan);
}

async function build(vars: Record<string, string | number>): Promise<void> {
  if (!profile.build || !opts.build) return;
  setPhase("building", `${profile.build.cmd.join(" ")} (log: ${path.join(L.logs, "build.log")})`);
  const child = groups.start("build", profile.build.cmd[0], profile.build.cmd.slice(1), {
    ...process.env,
    ...expandEnv(profile.build.env, vars),
  });
  if ((await child.exited) !== 0) throw new Error(`build failed: ${child.ended()}`);
}

async function startDisplay(): Promise<void> {
  setPhase("display");
  claim = claimDisplay(L.claims);
  display = claim.display;
  const before = socketSnapshot();
  const xvfb = groups.start(
    "xvfb",
    "Xvfb",
    [`:${display}`, "-screen", "0", `${screen.width}x${screen.height}x24`, "-nolisten", "tcp"],
    process.env,
  );
  await waitFor(
    `Xvfb on :${display}`,
    () => existsSync(`/tmp/.X11-unix/X${display}`),
    10_000,
    100,
    xvfb.ended,
  );
  // Belt and braces for the :1 incident: if any desktop display's socket went
  // away while Xvfb started, take Xvfb down at once and say so loudly.
  const gone = vanishedSockets(before, display).filter((s) => {
    const m = /X(\d+)_?$/.exec(s);
    return m && Number(m[1]) < 100;
  });
  if (gone.length) {
    xvfb.signal("SIGKILL");
    throw new Error(`STOPPED: X sockets vanished while Xvfb :${display} started: ${gone.join(", ")}. Check the desktop's X display.`);
  }
}

async function startDevServer(vars: Record<string, string | number>): Promise<void> {
  const ds = profile.devServer;
  if (!ds || devPort === null) return;
  setPhase("devserver", `${ds.cmd.join(" ")} on port ${devPort}`);
  if (!(await isFreeEverywhere(devPort))) throw new Error(`dev port ${devPort} was taken before the dev server started`);
  const child = groups.start("devserver", ds.cmd[0], ds.cmd.slice(1), { ...process.env, ...expandEnv(ds.env, vars) });
  const up = async (host: string) => {
    try {
      await fetch(`http://${host}:${devPort}/`, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      return false;
    }
  };
  await waitFor(
    `the dev server on port ${devPort}`,
    async () => (await up("127.0.0.1")) || (await up("[::1]")),
    90_000,
    250,
    child.ended,
  );
}

async function startApp(vars: Record<string, string | number>): Promise<void> {
  setPhase("driver");
  wdPort = await ephemeralPort();
  wd.base = `http://127.0.0.1:${wdPort}`;
  writeShims(L.bin);
  seedAppearance(process.env, L);
  const env = sandboxEnv(process.env, {
    display: display!,
    layout: L,
    daemonUrl: dashboardUrl.replace(/\/$/, ""),
    appEnv: { ...expandEnv(profile.env, vars), ...(opts.env ?? {}) },
  });
  // The env (WAYLAND_DISPLAY already gone) is set on dbus-run-session itself, so
  // the private bus and everything it activates never see the live session.
  const driver = groups.start("webdriver", "dbus-run-session", ["--", "WebKitWebDriver", `--port=${wdPort}`], env);
  const dead = driver.ended;
  await waitFor("WebKitWebDriver", () => wd.ready(), 15_000, 200, dead);

  setPhase("app", binary);
  if (!existsSync(binary)) throw new Error(`no binary at ${binary}; build it or drop --no-build`);
  const caps = await wd.newSession(binary, profile.args);
  native.appPid = Number(caps["webkit:processID"] ?? 0);
  diag(`session ${wd.sessionId} ${JSON.stringify(caps)}`);
  await wd.setTimeouts({ script: 30_000, implicit: 0 });
  await wd.setWindowRect({ x: 0, y: 0, width: screen.width, height: screen.height }).catch((e) => diag(`window rect: ${e.message}`));
  if (profile.url) await wd.navigate(expand(profile.url, vars));
  await waitFor(
    "the page to load",
    async () => {
      try {
        return await wd.execute<boolean>("return document.readyState === 'complete' && !!document.body && document.body.children.length > 0");
      } catch {
        return false;
      }
    },
    60_000,
    250,
    dead,
  );
}

async function launch(): Promise<void> {
  persist();
  if (opts.orca && (await orca.init())) {
    await orca.openTab(dashboardUrl);
    orca.comment(`appdrive ▸ launching ${profile.name}`);
  }
  devPort = await chooseDevPort();
  const vars = { root: opts.root, port: devPort ?? "" };
  await build(vars);
  await startDisplay();
  await startDevServer(vars);
  await startApp(vars);
  await native.appeared().catch(() => []);
  setPhase("ready");
  await captureFrame();
  const url = await wd.url().catch(() => "?");
  log.add("launch", true, `${profile.name} on :${display} (${url})`);
  orca.comment(`appdrive ▸ ${profile.name} running on hidden display :${display}`);
}

// ---------------------------------------------------------------- frames & shots

let capturing: Promise<void> | null = null;

/** The whole hidden screen, native dialogs included, for the dashboard. */
function captureFrame(): Promise<void> {
  if (display === null) return Promise.resolve();
  if (capturing) return capturing;
  capturing = (async () => {
    const tmp = L.frame.replace(/\.png$/, ".tmp.png");
    const proc = Bun.spawn(["import", "-display", `:${display}`, "-window", "root", tmp], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await proc.exited) === 0) {
      renameSync(tmp, L.frame);
      frameVersion++;
      lastFrameAt = Date.now();
      broadcast("frame", { v: frameVersion });
    }
  })().finally(() => (capturing = null));
  return capturing;
}

// Keep the dashboard live while someone is watching and the agent is quiet.
setInterval(() => {
  if (clients.size && phase === "ready" && !log.busy && Date.now() - lastFrameAt > 1500) void captureFrame();
}, 1000);
setInterval(() => {
  for (const c of clients) {
    try {
      c.enqueue(enc.encode(": ping\n\n"));
    } catch {
      clients.delete(c);
    }
  }
}, 15_000);

async function scaleDown(png: Buffer, max: number): Promise<Buffer> {
  const { width, height } = pngSize(png);
  if (width <= max && height <= max) return png;
  const proc = Bun.spawn(["magick", "png:-", "-resize", `${max}x${max}>`, "png:-"], {
    stdin: png,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = Buffer.from(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0) return png;
  return out;
}

function pruneShots(keep = 100): void {
  const files = readdirSync(L.shots).filter((f) => f.endsWith(".png")).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(path.join(L.shots, f), { force: true });
}

// ---------------------------------------------------------------- ops

type Args = Record<string, any>;
interface OpResult {
  data: unknown;
  summary: string;
  shot?: string;
  /** Changes the page, so the dashboard frame should refresh after it. */
  mutates?: boolean;
}

async function findAll(sel: string): Promise<ElementRef[]> {
  return wd.execute<ElementRef[]>(FIND, [sel]);
}

async function findOne(sel: string, nth = 0, timeout = 5000): Promise<ElementRef> {
  if (!sel) throw new Error("a selector is required");
  const end = Date.now() + timeout;
  for (;;) {
    const els = await findAll(sel);
    if (els.length > nth) return els[nth];
    if (Date.now() >= end) {
      const what = nth ? `${nth + 1} elements` : "element";
      throw new Error(
        `no ${what} matching ${JSON.stringify(sel)} after ${timeout}ms (found ${els.length}). Try \`appdrive outline\` for selectors.`,
      );
    }
    await Bun.sleep(150);
  }
}

// Things the agent should hear about on its next command: native windows that
// appeared, openers that were blocked.
function notice(summary: string, ok: boolean): void {
  log.note(summary, ok);
  orca.comment(`appdrive ▸ ${summary}`);
}

const native = new NativeWindows({
  connect: xDisplay(() => display),
  helpers: () => helpersInGroup(groups.get("webdriver")?.pid),
});

setInterval(async () => {
  if (phase !== "ready" || log.busy) return;
  const fresh = await native.appeared().catch(() => []);
  if (fresh.length) {
    notice(
      `native window on the hidden display: ${fresh.map(describeWindow).join(", ")}. WebDriver cannot reach it: ` +
        "`appdrive shot --screen` to see it, `appdrive xkey`/`xtype`/`xclick` to drive it, `appdrive dismiss` to close it",
      true,
    );
    void captureFrame();
  }
}, 1000);

async function settle(): Promise<void> {
  try {
    await wd.executeAsync(SETTLE, [], 2000);
  } catch {}
}

function pointer(actions: unknown[]) {
  return [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }];
}

const OPS: Record<string, (a: Args) => Promise<OpResult>> = {
  async click(a) {
    const el = await findOne(a.sel, a.nth ?? 0, a.timeout ?? 5000);
    const label = await wd.execute<string>(BRIEF, [el]);
    const button = a.button === "right" ? 2 : a.button === "middle" ? 1 : 0;
    if (a.force) {
      await wd.execute("arguments[0].click()", [el]);
    } else if (a.double || button !== 0) {
      const press = [
        { type: "pointerDown", button },
        { type: "pointerUp", button },
      ];
      await wd.actions(pointer([{ type: "pointerMove", origin: el, x: 0, y: 0 }, ...press, ...(a.double ? press : [])]));
      await wd.releaseActions();
    } else {
      await wd.click(elementId(el));
    }
    const how = a.double ? "double-clicked" : button === 2 ? "right-clicked" : "clicked";
    return { data: { [how]: label }, summary: `${how} ${label}`, mutates: true };
  },

  async hover(a) {
    const el = await findOne(a.sel, a.nth ?? 0, a.timeout ?? 5000);
    const label = await wd.execute<string>(BRIEF, [el]);
    await wd.actions(pointer([{ type: "pointerMove", origin: el, x: 0, y: 0 }]));
    return { data: { hovered: label }, summary: `hovered ${label}`, mutates: true };
  },

  async type(a) {
    const text = String(a.text ?? "");
    if (a.focused) {
      await wd.actions([{ type: "key", id: "keyboard", actions: textActions(text) }]);
      await wd.releaseActions();
      return { data: { typed: text }, summary: `typed ${JSON.stringify(text)} into the focused element`, mutates: true };
    }
    const el = await findOne(a.sel, a.nth ?? 0, a.timeout ?? 5000);
    const label = await wd.execute<string>(BRIEF, [el]);
    if (a.clear) await wd.clear(elementId(el));
    await wd.sendKeys(elementId(el), text);
    const value = await wd.execute("return arguments[0].value ?? arguments[0].textContent", [el]);
    return { data: { typed: text, into: label, value }, summary: `typed ${JSON.stringify(text)} into ${label}`, mutates: true };
  },

  async key(a) {
    const spec = String(a.keys ?? "");
    await wd.actions([{ type: "key", id: "keyboard", actions: parseKeys(spec) }]);
    await wd.releaseActions();
    return { data: { pressed: spec }, summary: `pressed ${spec}`, mutates: true };
  },

  async query(a) {
    const timeout = a.timeout ?? 1000;
    const end = Date.now() + timeout;
    let r: { count: number; items: unknown[] };
    for (;;) {
      r = await wd.execute(QUERY, [a.sel, !!a.all]);
      if (r.count > 0 || Date.now() >= end) break;
      await Bun.sleep(150);
    }
    return { data: r, summary: `${a.sel} → ${r.count} match${r.count === 1 ? "" : "es"}` };
  },

  async wait(a) {
    const timeout = a.timeout ?? 10_000;
    const t0 = Date.now();
    const want = a.gone ? "gone" : "present";
    await waitFor(`${a.sel} to be ${want}`, async () => ((await findAll(a.sel)).length > 0) !== !!a.gone, timeout, 150);
    return { data: { [want]: a.sel, ms: Date.now() - t0 }, summary: `${a.sel} ${want} after ${Date.now() - t0}ms` };
  },

  async outline() {
    const r = await wd.execute<{ lines: string[]; title: string; url: string; viewport: string; focused: string }>(OUTLINE);
    return { data: r, summary: `${r.lines.length} items` };
  },

  async shot(a) {
    const max = Number(a.max ?? 800);
    let png: Buffer;
    let what: string;
    if (a.screen) {
      await captureFrame();
      png = readFileSync(L.frame);
      what = "screen";
    } else if (a.sel) {
      const el = await findOne(a.sel, a.nth ?? 0, a.timeout ?? 5000);
      try {
        png = await wd.elementScreenshot(elementId(el));
      } catch (e) {
        const d = await wd.execute(DESCRIBE, [el]).catch(() => null);
        const r = d?.rect;
        const why = r && (r.w <= 2 || r.h <= 2) ? " It is visually hidden or empty; shoot a container instead." : "";
        throw new Error(`could not capture ${a.sel}${r ? ` (${r.w}x${r.h} at ${r.x},${r.y})` : ""}: ${(e as Error).message}.${why}`);
      }
      what = a.sel;
    } else {
      png = await wd.screenshot();
      what = "window";
    }
    const full = pngSize(png);
    png = await scaleDown(png, max);
    const size = pngSize(png);
    const name = `${String(++shotSeq).padStart(4, "0")}-${slug(a.name ?? what)}.png`;
    const file = path.join(L.shots, name);
    writeFileSync(file, png);
    pruneShots();
    const scaled = size.width !== full.width ? ` (scaled from ${full.width}x${full.height})` : "";
    return {
      data: { path: file, width: size.width, height: size.height, scaledFrom: scaled ? full : undefined },
      summary: `${what} → ${name} ${size.width}x${size.height}${scaled}`,
      shot: name,
    };
  },

  async eval(a) {
    const r = await wd.executeAsync<{ ok: boolean; value?: unknown; error?: string }>(evalScript(String(a.code ?? "")), [], a.timeout ?? 30_000);
    if (!r.ok) throw new Error(`page threw: ${r.error}`);
    const text = JSON.stringify(r.value);
    return { data: r.value, summary: text && text.length > 80 ? text.slice(0, 79) + "…" : String(text), mutates: true };
  },

  async resize(a) {
    const width = Math.min(Number(a.width), screen.width);
    const height = Math.min(Number(a.height), screen.height);
    const r = await wd.setWindowRect({ x: 0, y: 0, width, height });
    const clamped = width < Number(a.width) || height < Number(a.height) ? ` (clamped to the ${screen.width}x${screen.height} screen; relaunch with --size for more)` : "";
    return { data: r, summary: `window ${r.width}x${r.height}${clamped}`, mutates: true };
  },

  async windows() {
    const list = await native.all();
    const lines = list.map((w) => `${w.app ? "app   " : "native"} ${w.id}  ${describeWindow(w)}`);
    return { data: list, summary: lines.join("\n") || "no windows" };
  },

  async xkey(a) {
    const target = await native.keys(String(a.keys ?? ""), a.window);
    const to = target ? describeWindow(target) : "the app window";
    return { data: { pressed: a.keys, window: target?.id ?? null }, summary: `X keys ${a.keys} → ${to}`, mutates: true };
  },

  async xtype(a) {
    const target = await native.type(String(a.text ?? ""), a.window);
    return { data: { typed: a.text, window: target?.id ?? null }, summary: `X typed ${JSON.stringify(a.text)}`, mutates: true };
  },

  async xclick(a) {
    const at = await native.click(Number(a.x), Number(a.y), { button: a.button, double: !!a.double });
    return { data: at, summary: `X click at ${at.x},${at.y}`, mutates: true };
  },

  async dismiss() {
    const { done, remaining } = await native.dismiss();
    return {
      data: { done, remaining },
      summary: done.length
        ? `${done.join("; ")}${remaining.length ? ` · still open: ${remaining.map(describeWindow).join(", ")}` : ""}`
        : "no native window open",
      mutates: true,
    };
  },

  async reload() {
    await wd.execute("location.reload()");
    await Bun.sleep(300);
    await waitFor("reload", async () => (await wd.execute<string>("return document.readyState").catch(() => "")) === "complete", 30_000);
    return { data: { url: await wd.url() }, summary: "reloaded", mutates: true };
  },
};
let shotSeq = existsSync(L.shots) ? readdirSync(L.shots).filter((f) => f.endsWith(".png")).length : 0;

async function handleOp(op: string, a: Args): Promise<unknown> {
  switch (op) {
    case "status":
      return status();
    case "log":
      return log.recent(Number(a.n) || 30);
    case "note": {
      const argv: string[] = Array.isArray(a.argv) ? a.argv.map(String) : [];
      const summary =
        a.kind === "dialog"
          ? `native dialog opened on the hidden display: ${argv.join(" ").slice(0, 200)} (see \`appdrive shot --screen\`)`
          : `blocked ${argv.join(" ").slice(0, 200)} (would have opened on the user's desktop)`;
      notice(summary, a.kind === "dialog");
      return { noted: true };
    }
    case "stop":
      setTimeout(() => void stop("stopped by `appdrive stop`"), 10);
      return { stopping: true };
  }
  const fn = OPS[op];
  if (!fn) throw new Error(`unknown op ${op}`);
  if (phase !== "ready") throw new Error(`the session is ${phase}${failure ? `: ${failure}` : detail ? `: ${detail}` : ""}`);
  lastActivity = Date.now();
  const what = `${op} ${describeArgs(op, a)}`.trim();
  try {
    const r = await log.run(op, a, async () => {
      const r = await fn(a);
      if (r.mutates) {
        await settle();
        await captureFrame();
      }
      return r;
    });
    orca.comment(`appdrive ▸ ${what} ✓`.replace(/\s+/g, " "));
    return r.data;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    orca.comment(`appdrive ▸ ${what} ✗ ${msg}`.replace(/\s+/g, " "));
    if (/invalid session id|no such window/i.test(msg)) {
      failure = `the app window is gone (${msg})`;
      setPhase("crashed", failure);
    } else {
      void captureFrame();
    }
    throw e;
  }
}

// ---------------------------------------------------------------- stop

async function stop(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  setPhase("stopping", reason);
  log.add("stop", true, reason);
  if (wd.sessionId) await withTimeout(wd.deleteSession(), 5000, "closing the app").catch((e) => diag(e.message));
  await groups.stopAll(["webdriver", "devserver", "build", "xvfb"]);
  native.close();
  claim?.release();
  rmSync(L.runtime, { recursive: true, force: true });
  await orca.restore(`appdrive ▸ stopped after ${log.actions()} actions (${reason})`).catch(() => {});
  broadcast("status", { ...status(), phase: "stopped", detail: reason });
  rmSync(L.session, { force: true });
  rmSync(L.registry, { force: true });
  diag(`stopped: ${reason}`);
  for (const c of clients) {
    try {
      c.close();
    } catch {}
  }
  server.stop(true);
  process.exit(0);
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void stop(`daemon got ${sig}`));

setInterval(() => {
  if (phase === "ready" && Date.now() - lastActivity > opts.idleMinutes * 60_000) {
    void stop(`idle for ${opts.idleMinutes} minutes`);
  }
}, 30_000);

launch().catch(async (e: Error) => {
  failure = e.message;
  diag(`launch failed: ${e.stack ?? e.message}`);
  setPhase("failed", e.message);
  log.add("launch", false, e.message);
  orca.comment(`appdrive ▸ launch failed: ${e.message.split("\n")[0]}`);
  // Leave the failure readable for a moment, then clean up everything.
  await Bun.sleep(3000);
  await stop("launch failed");
});
