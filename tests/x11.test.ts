import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claimDisplay, displaysInUse } from "../src/x11.ts";

function fakeTmp(entries: string[], locks: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), "appdrive-x11-"));
  const sockets = path.join(root, ".X11-unix");
  mkdirSync(sockets);
  for (const e of entries) writeFileSync(path.join(sockets, e), "");
  for (const l of locks) writeFileSync(path.join(root, `.X${l}-lock`), "");
  return { root, sockets };
}

// Hyprland's XWayland on 2026-10-11: filesystem sockets X1 and X1_, no
// abstract socket. -displayfd took :1 because only the abstract name was free.
test("a display with only filesystem sockets counts as in use", () => {
  const { root, sockets } = fakeTmp(["X0", "X0_", "X1", "X1_"], ["1"]);
  const used = displaysInUse("", sockets, root);
  expect(used.has(0)).toBe(true);
  expect(used.has(1)).toBe(true);
});

test("abstract and unlinked sockets in /proc/net/unix count", () => {
  const proc = [
    "0000000000000000: 00000002 00000000 00010000 0001 01 20482 @/tmp/.X11-unix/X0",
    "0000000000000000: 00000002 00000000 00010000 0001 01 16876 /tmp/.X11-unix/X1",
    "0000000000000000: 00000002 00000000 00010000 0001 01 16877 @/tmp/.X11-unix/X104",
  ].join("\n");
  const { root, sockets } = fakeTmp([], []);
  expect([...displaysInUse(proc, sockets, root)].sort((a, b) => a - b)).toEqual([0, 1, 104]);
});

test("claims skip used numbers and live claims, and take over dead ones", () => {
  const claims = mkdtempSync(path.join(tmpdir(), "appdrive-claims-"));
  writeFileSync(path.join(claims, "display-101.claim"), String(process.pid)); // alive
  writeFileSync(path.join(claims, "display-102.claim"), "999999999"); // dead
  const c = claimDisplay(claims, 100, 110, new Set([100]));
  expect(c.display).toBe(102);
  const d = claimDisplay(claims, 100, 110, new Set([100]));
  expect(d.display).toBe(103);
  c.release();
  d.release();
});

test("no free display is an error, not a guess", () => {
  const claims = mkdtempSync(path.join(tmpdir(), "appdrive-claims-"));
  expect(() => claimDisplay(claims, 100, 102, new Set([100, 101]))).toThrow(/no free X display/);
});
