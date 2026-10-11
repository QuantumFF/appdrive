import { expect, test } from "bun:test";
import { verdict } from "../hooks/guard-desktop.ts";

test("desktop input is refused with a pointer to appdrive", () => {
  for (const cmd of [
    "ydotool click 0xC0",
    "sleep 1 && wtype hello",
    "hyprctl dispatch focuswindow class:walltare",
    "hyprctl dispatch movecursor 100 100",
    "hyprctl --batch dispatch movetoworkspacesilent 3",
    "hyprctl eval 'hl.dsp.focus({window = \"x\"})'",
    "hyprctl eval 'cursor.move(1, 2)'",
  ]) {
    expect(verdict(cmd)).toContain("appdrive launch");
  }
});

test("reading desktop state and appdrive itself pass", () => {
  for (const cmd of [
    "hyprctl clients -j",
    "hyprctl cursorpos",
    "hyprctl monitors",
    "appdrive click text=Library",
    "rg ydotoolish src", // a word that merely contains it
  ]) {
    expect(verdict(cmd)).toBeNull();
  }
});
