import { expect, test } from "bun:test";
import { chordActions, keyValue, parseKeys, textActions } from "../src/keys.ts";

test("a lone key is pressed and released", () => {
  expect(parseKeys("Escape")).toEqual([
    { type: "keyDown", value: "\uE00C" },
    { type: "keyUp", value: "\uE00C" },
  ]);
});

test("modifiers wrap the key and release in reverse", () => {
  expect(chordActions("Ctrl+Shift+k").map((a) => `${a.type}:${a.value}`)).toEqual([
    "keyDown:\uE009",
    "keyDown:\uE008",
    "keyDown:k",
    "keyUp:k",
    "keyUp:\uE008",
    "keyUp:\uE009",
  ]);
});

test("chords are space\u002Dseparated", () => {
  expect(parseKeys("ArrowDown ArrowDown Enter")).toHaveLength(6);
});

test("Ctrl++ means Ctrl and plus", () => {
  expect(chordActions("Ctrl++").map((a) => a.value)).toEqual(["\uE009", "+", "+", "\uE009"]);
});

test("names are case\u002Dinsensitive and F\u002Dkeys map", () => {
  expect(keyValue("enter")).toBe(keyValue("Enter"));
  expect(keyValue("F5")).toBe("\uE035");
});

test("unknown keys and misplaced modifiers are refused", () => {
  expect(() => keyValue("Bogus")).toThrow(/unknown key/);
  expect(() => chordActions("a+b")).toThrow(/only Ctrl, Shift, Alt and Meta/);
  expect(() => parseKeys("  ")).toThrow(/no keys/);
});

test("text types every character", () => {
  expect(textActions("hé").map((a) => a.value)).toEqual(["h", "h", "é", "é"]);
});

test("a capital letter in a chord is the plain key", () => {
  expect(chordActions("Ctrl+K").map((a) => a.value)).toEqual(["\uE009", "k", "k", "\uE009"]);
  expect(chordActions("K").map((a) => a.value)).toEqual(["K", "K"]);
});
