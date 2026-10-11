import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-ignore: plain ESM, as Orca's worker loads it
import activate, { focusedWorktreePath, openDashboard, sessions } from "../orca-plugin/main.mjs";

type Call = (args: string[]) => Promise<any>;

function fakeCtx(context: unknown) {
  const handlers = new Map<string, (a?: unknown) => Promise<unknown>>();
  const events = new Map<string, (p: unknown) => Promise<void>>();
  const calls: { method: string; params: any }[] = [];
  const storage = new Map<string, unknown>();
  const ctx = {
    commands: { register: (id: string, fn: any) => handlers.set(id, fn) },
    events: { on: (e: string, fn: any) => events.set(e, fn) },
    host: {
      async call(method: string, params: any) {
        calls.push({ method, params });
        if (method === "workspace.readContext") return context;
        if (method === "storage.get") return { value: storage.get(params.key) ?? null };
        if (method === "storage.set") storage.set(params.key, params.value);
        return { ok: true };
      },
    },
    log() {},
  };
  return { ctx, handlers, events, calls };
}

const session = (over: object = {}) => ({
  root: "/w/walltare",
  app: "walltare",
  url: "http://127.0.0.1:47778/",
  pid: process.pid,
  phase: "ready",
  startedAt: 1,
  ...over,
});

test("the focused worktree comes from its terminal ids, not its ambiguous name", async () => {
  const { ctx } = fakeCtx({ branch: "main", displayName: "main", terminals: [{ id: "repo::/w/walltare@@1" }] });
  const never: Call = async () => {
    throw new Error("no CLI lookup needed");
  };
  expect(await focusedWorktreePath(ctx, never)).toBe("/w/walltare");
});

test("without terminals, a unique name and branch still resolve", async () => {
  const { ctx } = fakeCtx({ branch: "feat", displayName: "feat", terminals: [] });
  const call: Call = async () => ({
    worktrees: [
      { path: "/w/a", displayName: "main", branch: "refs/heads/main" },
      { path: "/w/b", displayName: "feat", branch: "refs/heads/feat" },
    ],
  });
  expect(await focusedWorktreePath(ctx, call)).toBe("/w/b");
});

test("an open dashboard tab is switched to, not duplicated", async () => {
  const seen: string[][] = [];
  const call: Call = async (args) => {
    seen.push(args);
    return args[1] === "list" ? { tabs: [{ url: "http://127.0.0.1:47778/", browserPageId: "p1" }] } : {};
  };
  await openDashboard(session(), call);
  expect(seen[1]).toEqual(["tab", "switch", "--page", "p1", "--worktree", "path:/w/walltare"]);
  seen.length = 0;
  const empty: Call = async (args) => (seen.push(args), args[1] === "list" ? { tabs: [] } : {});
  await openDashboard(session(), empty);
  expect(seen[1]).toEqual(["tab", "create", "--url", "http://127.0.0.1:47778/", "--worktree", "path:/w/walltare"]);
});

test("a crashed session is announced once", async () => {
  const { ctx, events, calls } = fakeCtx(null);
  await activate(ctx, { sessions: () => [session({ phase: "crashed", failure: "webdriver exited" })], orca: async () => ({}) });
  const fire = events.get("agent.status.changed")!;
  await fire({});
  await fire({});
  const shown = calls.filter((c) => c.method === "notifications.show");
  expect(shown).toHaveLength(1);
  expect(shown[0].params.title).toBe("appdrive: walltare crashed in walltare");
});

test("open-dashboard says so when the worktree has no session", async () => {
  const { ctx, handlers, calls } = fakeCtx({ branch: "x", displayName: "x", terminals: [{ id: "r::/w/other@@1" }] });
  await activate(ctx, { sessions: () => [session()], orca: async () => ({}) });
  expect(await handlers.get("open-dashboard")!()).toEqual({ opened: false });
  expect(calls.at(-1)?.params.body).toContain("No appdrive session in other");
});

test("the registry skips dead sessions and junk", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "appdrive-reg-"));
  writeFileSync(path.join(dir, "a.json"), JSON.stringify(session()));
  writeFileSync(path.join(dir, "b.json"), JSON.stringify(session({ pid: 999999999 })));
  writeFileSync(path.join(dir, "c.json"), "{");
  expect(sessions(dir).map((s: any) => s.root)).toEqual(["/w/walltare"]);
});
