import { expect, test } from "bun:test";
import { verdict } from "../hooks/guard-desktop.ts";

test("desktop input is refused with a pointer to appdrive", () => {
  for (const cmd of [
    "ydotool click 0xC0",
    "sudo /usr/bin/ydotool mousemove 1 1",
    "YDOTOOL_SOCKET=/tmp/s ydotool type x",
    "cd /tmp && ydotool key 28:1",
    "echo hi | wtype -",
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

test("reading desktop state, mentions and appdrive itself pass", () => {
  for (const cmd of [
    "hyprctl clients -j",
    "hyprctl cursorpos",
    "hyprctl monitors",
    "appdrive click text=Library",
    "rg ydotoolish src",
    "rg ydotool src",
    "echo ydotool is blocked",
    'git commit -m "drop ydotool and wtype"',
    "rg 'hl.dsp.focus' docs",
  ]) {
    expect(verdict(cmd)).toBeNull();
  }
});
