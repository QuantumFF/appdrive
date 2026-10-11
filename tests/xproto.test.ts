import { expect, test } from "bun:test";
import { keysym, parseXKeys } from "../src/xproto.ts";

test("named keys and characters map to keysyms", () => {
  expect(keysym("Escape")).toBe(0xff1b);
  expect(keysym("a")).toBe(0x61);
  expect(keysym("/")).toBe(0x2f);
  expect(keysym("F1")).toBe(0xffbe);
  expect(keysym("€")).toBe(0x01000000 + 0x20ac);
});

test("chords parse like WebDriver keys", () => {
  expect(parseXKeys("Ctrl+L Escape")).toEqual([[0xffe3, 0x6c], [0xff1b]]);
  expect(parseXKeys("Ctrl++")).toEqual([[0xffe3, 0x2b]]);
});
