import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { layout } from "../src/paths.ts";
import { type LaunchOptions, launchDaemon, pidAlive, Session } from "../src/session.ts";

const FAKE = path.join(import.meta.dir, "fixtures", "fake-daemon.ts");
const started: Session[] = [];

afterEach(async () => {
  for (const s of started.splice(0)) await s.stop(1000);
});

function checkout() {
  const root = mkdtempSync(path.join(tmpdir(), "appdrive-session-"));
  const L = layout(root);
  mkdirSync(L.logs, { recursive: true });
  return L;
}

function options(root: string, mode: string): LaunchOptions {
  return { root, build: false, orca: false, fresh: false, screen: null, idleMinutes: 1, env: { MODE: mode } };
}

async function launch(mode: string, progress: string[] = []) {
  const L = checkout();
  const st = await launchDaemon(L, options(L.root, mode), (l) => progress.push(l), { script: FAKE, timeoutMs: 10_000 });
  const s = Session.read(L.session)!;
  started.push(s);
  return { L, st, s };
}

test("launch reports each phase and returns the ready status", async () => {
  const progress: string[] = [];
  const { st, s } = await launch("ok", progress);
  expect(st).toMatchObject({ phase: "ready", app: "demo", display: ":150", appEnv: { MODE: "ok" } });
  expect(progress).toEqual(["building: cargo build"]);
  expect(s.alive()).toBe(true);
  expect((await s.status())?.phase).toBe("ready");
});

test("a failed launch throws the daemon's reason", async () => {
  const L = checkout();
  const p = launchDaemon(L, options(L.root, "fail"), () => {}, { script: FAKE, timeoutMs: 10_000 });
  await expect(p).rejects.toThrow(/launch failed: build failed/);
  started.push(Session.read(L.session)!);
});

test("a daemon that dies during launch is reported with its log", async () => {
  const L = checkout();
  const p = launchDaemon(L, options(L.root, "die"), () => {}, { script: FAKE, timeoutMs: 10_000 });
  await expect(p).rejects.toThrow(/exited during launch:\nfake daemon: giving up/);
});

test("ops return their result, and notices reach the caller even when an op fails", async () => {
  const { s } = await launch("ok");
  const heard: string[] = [];
  s.onNotices = (n) => heard.push(...n);
  expect(await s.op<{ sel: string }>("echo", { sel: "a" })).toEqual({ sel: "a" });
  expect(heard).toEqual(["native window on the hidden display"]);
  await expect(s.op("bogus")).rejects.toThrow("unknown op bogus");
});

test("stop ends the daemon and removes the session file", async () => {
  const { L, s } = await launch("ok");
  await s.stop();
  expect(s.alive()).toBe(false);
  expect(existsSync(L.session)).toBe(false);
  expect(Session.read(L.session)).toBeNull();
});

test("a dead daemon's process groups are killed on stop", async () => {
  const L = checkout();
  const orphan = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  writeFileSync(L.session, JSON.stringify({ pid: 999999999, port: 1, url: "", root: L.root, app: "x", display: null, startedAt: 1, groups: { xvfb: orphan.pid } }));
  const s = Session.read(L.session)!;
  expect(s.alive()).toBe(false);
  await s.stop();
  await new Promise((r) => orphan.once("exit", r));
  expect(pidAlive(orphan.pid!)).toBe(false);
  expect(existsSync(L.session)).toBe(false);
});

test("an op on a daemon that does not answer says so", async () => {
  const L = checkout();
  writeFileSync(L.session, JSON.stringify({ pid: process.pid, port: 1, url: "", root: L.root, app: "x", display: null, startedAt: 1, groups: {} }));
  await expect(Session.read(L.session)!.op("outline", {}, 1000)).rejects.toThrow(/cannot reach the session daemon/);
});
