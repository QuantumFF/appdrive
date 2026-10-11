import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProcessGroups } from "../src/procs.ts";

function groups(events: string[] = []) {
  const logs = mkdtempSync(path.join(tmpdir(), "appdrive-procs-"));
  return new ProcessGroups({ cwd: logs, logs, onExit: (name, how) => events.push(`${name}:${how}`) });
}

test("a group that ends says why, with the tail of its log", async () => {
  const events: string[] = [];
  const g = groups(events).start("build", "sh", ["-c", "echo compiling; echo boom >&2; exit 3"], process.env);
  expect(await g.exited).toBe(3);
  expect(g.ended()).toBe("build exited (3):\ncompiling\nboom");
  expect(events).toEqual(["build:3"]);
});

test("a running group has not ended, and is listed by its pgid", async () => {
  const pg = groups();
  const g = pg.start("xvfb", "sleep", ["30"], process.env);
  expect(g.ended()).toBeNull();
  expect(pg.pgids()).toEqual({ xvfb: g.pid });
  g.signal("SIGKILL");
  expect(await g.exited).toBeNull();
  expect(g.ended()).toStartWith("xvfb exited (SIGKILL)");
  expect(pg.pgids()).toEqual({});
});

test("a missing program is reported, not thrown", async () => {
  const g = groups().start("driver", "appdrive-no-such-program", [], process.env);
  await g.exited;
  expect(g.ended()).toMatch(/^driver (could not start|exited)/);
});

test("stopAll takes down the whole tree, and kills what ignores SIGTERM", async () => {
  const events: string[] = [];
  const pg = groups(events);
  // The grandchild is in the group too: one signal reaches it.
  const tree = pg.start("devserver", "sh", ["-c", "sleep 30 & wait"], process.env);
  const stubborn = pg.start("webdriver", "sh", ["-c", "trap '' TERM; sleep 30 & wait; sleep 30"], process.env);
  await Bun.sleep(100);
  const t0 = Date.now();
  await pg.stopAll(["webdriver", "devserver"], 500);
  await Promise.all([tree.exited, stubborn.exited]);
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(pg.pgids()).toEqual({});
  expect(events.sort()).toEqual(["devserver:SIGTERM", "webdriver:SIGKILL"]);
});
