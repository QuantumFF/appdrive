// How to build, serve and launch one app. A generic profile is read from the
// checkout's tauri.conf.json; a built-in override per app identifier fills in
// what the conf cannot say; `<root>/.appdrive.json` overrides both.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Command {
  cmd: string[];
  env: Record<string, string>;
}

export interface DevServer extends Command {
  /** The port to try first. */
  port: number;
  /** How many ports from `port` to scan for a free one; 0 when the app cannot move it. */
  scan: number;
}

export interface Profile {
  name: string;
  identifier: string | null;
  /** Relative to the checkout root. */
  binary: string;
  args: string[];
  /** Page to navigate to once the session is up, for browsers that start blank (MiniBrowser --automation). */
  url?: string;
  /** Extra env for the app. `{root}` and `{port}` expand at launch. */
  env: Record<string, string>;
  /** Run before every launch; cargo makes it a no-op when nothing changed. */
  build: Command | null;
  devServer: DevServer | null;
  window: { width: number; height: number };
}

type Override = Partial<Omit<Profile, "build" | "devServer">> & {
  build?: Command | null;
  devServer?: Partial<DevServer> | null;
};

// Built-in knowledge, keyed by Tauri identifier.
const BUILTIN: Record<string, Override> = {
  "com.quantumff.walltare": {
    name: "walltare",
    // ADR 0048 in walltare: a dev run reads `.dev-data` in its checkout, never
    // the installed app's database.
    env: { WALLTARE_DATA_DIR: "{root}/.dev-data" },
    // vite.config.ts takes its port from WALLTARE_DEV_PORT (scripts/dev-app.ts).
    devServer: { env: { WALLTARE_DEV_PORT: "{port}" }, port: 1420, scan: 100 },
  },
};

export function expand(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function expandEnv(env: Record<string, string>, vars: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expand(v, vars)]));
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}

function cargoPackageName(cargoToml: string): string | null {
  if (!existsSync(cargoToml)) return null;
  const m = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m.exec(readFileSync(cargoToml, "utf8"));
  return m ? m[1] : null;
}

/** Profile for a Tauri 2 checkout, from src-tauri/tauri.conf.json alone. */
export function tauriProfile(root: string): Profile | null {
  const confPath = path.join(root, "src-tauri", "tauri.conf.json");
  if (!existsSync(confPath)) return null;
  const conf = readJson(confPath);
  const identifier: string | null = conf.identifier ?? null;
  const binName =
    conf.mainBinaryName ?? cargoPackageName(path.join(root, "src-tauri", "Cargo.toml")) ?? conf.productName ?? "app";
  const win = conf.app?.windows?.[0] ?? {};

  let devServer: DevServer | null = null;
  const devUrl: string | undefined = conf.build?.devUrl;
  const before = conf.build?.beforeDevCommand;
  const beforeCmd: string | undefined = typeof before === "string" ? before : before?.script;
  const portMatch = devUrl ? /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?/.exec(devUrl) : null;
  if (portMatch && beforeCmd) {
    devServer = { cmd: ["sh", "-c", beforeCmd], env: {}, port: Number(portMatch[1] ?? 80), scan: 0 };
  }

  // The devUrl is compiled into a debug binary, so the build bakes in the
  // port the dev server will use. With the same TAURI_CONFIG that
  // `tauri dev --config` passes, cargo reuses that build.
  const buildEnv: Record<string, string> = devServer
    ? { TAURI_CONFIG: JSON.stringify({ build: { devUrl: "http://localhost:{port}" } }) }
    : {};
  return {
    name: conf.productName ?? binName,
    identifier,
    binary: path.join("src-tauri", "target", "debug", binName),
    args: [],
    env: {},
    build: { cmd: ["cargo", "build", "--manifest-path", "src-tauri/Cargo.toml"], env: buildEnv },
    devServer,
    window: { width: win.width ?? 1280, height: win.height ?? 800 },
  };
}

function apply(base: Profile, o: Override): Profile {
  const out: Profile = { ...base, ...o, env: { ...base.env, ...o.env } } as Profile;
  if (o.build !== undefined) out.build = o.build;
  if (o.devServer === null) out.devServer = null;
  else if (o.devServer) {
    const prev = base.devServer ?? { cmd: [], env: {}, port: 0, scan: 0 };
    out.devServer = { ...prev, ...o.devServer, env: { ...prev.env, ...o.devServer.env } };
  }
  if (o.window) out.window = { ...base.window, ...o.window };
  return out;
}

export function loadProfile(root: string): Profile {
  let profile = tauriProfile(root);
  const overridePath = path.join(root, ".appdrive.json");
  const local: Override | null = existsSync(overridePath) ? readJson(overridePath) : null;
  if (!profile) {
    if (!local?.binary) {
      throw new Error(`${root} has no src-tauri/tauri.conf.json and no .appdrive.json naming a binary`);
    }
    profile = {
      name: path.basename(root),
      identifier: null,
      binary: local.binary,
      args: [],
      env: {},
      build: null,
      devServer: null,
      window: { width: 1280, height: 800 },
    };
  }
  const builtin = profile.identifier ? BUILTIN[profile.identifier] : undefined;
  if (builtin) profile = apply(profile, builtin);
  if (local) profile = apply(profile, local);
  return profile;
}

/** The dev server port compiled into a debug binary, if one is visible in it. */
export async function bakedDevPort(binary: string): Promise<number | null> {
  if (!existsSync(binary)) return null;
  const proc = Bun.spawn(["grep", "-a", "-o", "-m", "1", "http://localhost:[0-9]\\+", binary], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const m = /:(\d+)/.exec(out.split("\n")[0] ?? "");
  return m ? Number(m[1]) : null;
}
