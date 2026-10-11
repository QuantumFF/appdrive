import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionLog, describeArgs, type LogEntry } from "../src/actions.ts";

function log() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "appdrive-log-")), "log.jsonl");
  const started: LogEntry[] = [];
  const recorded: LogEntry[] = [];
  const l = new ActionLog({ file, onStart: (e) => started.push({ ...e }), onRecord: (e) => recorded.push(e) });
  return { l, file, started, recorded };
}

const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((s) => JSON.parse(s));

test("an op's outcome is logged, in memory and in log.jsonl", async () => {
  const { l, file, started, recorded } = log();
  const r = await l.run("click", { sel: "text=Library", double: true }, async () => ({ summary: "double-clicked Library" }));
  expect(r.summary).toBe("double-clicked Library");
  expect(started).toEqual([expect.objectContaining({ op: "click", args: "text=Library --double" })]);
  expect(started[0].ok).toBeUndefined();
  expect(recorded[0]).toMatchObject({ id: 1, op: "click", ok: true, summary: "double-clicked Library" });
  expect(l.last).toBe("✓ click text=Library --double");
  expect(lines(file)).toEqual(recorded);
});

test("a failed op rethrows, is logged, and does not hold up the next", async () => {
  const { l, recorded } = log();
  const bad = l.run("click", { sel: "#gone" }, async () => {
    throw new Error("no element matching");
  });
  const good = l.run("key", { keys: "Escape" }, async () => ({ summary: "pressed Escape" }));
  await expect(bad).rejects.toThrow("no element matching");
  await good;
  expect(recorded.map((e) => [e.op, e.ok, e.error ?? e.summary])).toEqual([
    ["click", false, "no element matching"],
    ["key", true, "pressed Escape"],
  ]);
  expect(l.busy).toBe(false);
});

test("ops run one at a time, in the order they came", async () => {
  const { l } = log();
  const order: string[] = [];
  const op = (name: string, ms: number) =>
    l.run(name, {}, async () => {
      order.push(`${name} start (busy ${l.busy})`);
      await Bun.sleep(ms);
      order.push(`${name} end`);
      return { summary: name };
    });
  await Promise.all([op("slow", 30), op("fast", 0)]);
  expect(order).toEqual(["slow start (busy true)", "slow end", "fast start (busy true)", "fast end"]);
});

test("notes reach the agent once, and are not counted as actions", async () => {
  const { l } = log();
  l.add("launch", true, "walltare on :101");
  l.note("blocked xdg-open https://example.com", false);
  await l.run("outline", {}, async () => ({ summary: "12 items" }));
  expect(l.takeNotices()).toEqual(["blocked xdg-open https://example.com"]);
  expect(l.takeNotices()).toEqual([]);
  expect(l.actions()).toBe(1);
  expect(l.count).toBe(3);
  expect(l.recent(2).map((e) => e.op)).toEqual(["note", "outline"]);
});

test("a failed launch is logged as an error", () => {
  const { l, recorded } = log();
  l.add("launch", false, "build failed");
  expect(recorded[0]).toMatchObject({ op: "launch", ok: false, error: "build failed" });
  expect(recorded[0].summary).toBeUndefined();
  expect(l.last).toBe("✗ launch");
});

test("the previous run's log is kept aside, not appended to", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "appdrive-log-"));
  const file = path.join(dir, "log.jsonl");
  writeFileSync(file, '{"op":"old"}\n');
  new ActionLog({ file }).add("launch", true, "x");
  expect(readFileSync(path.join(dir, "log.prev.jsonl"), "utf8")).toBe('{"op":"old"}\n');
  expect(lines(file).map((e) => e.op)).toEqual(["launch"]);
  expect(existsSync(file)).toBe(true);
});

test("args read the way the CLI took them", () => {
  expect(describeArgs("type", { sel: "input", text: "1920", clear: true })).toBe('input "1920" --clear');
  expect(describeArgs("click", { sel: "a", nth: 2, button: "right" })).toBe("a #2 --button right");
  expect(describeArgs("resize", { width: 800, height: 600 })).toBe("800x600");
});
