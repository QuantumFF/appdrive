import { expect, test } from "bun:test";
import { type Display, NativeWindows } from "../src/native.ts";
import type { XWindow } from "../src/xproto.ts";

const APP = 4242;

function win(id: number, name: string, pid = 0): XWindow {
  return { id, name, pid, x: 0, y: 0, width: 400, height: 300 };
}

/**
 * A hidden display where Escape closes the focused window, except that a
 * window listed in `popups` first loses its popup, and a `stubborn` one ignores
 * Escape altogether.
 */
function fakeDisplay(initial: XWindow[], o: { popups?: number[]; stubborn?: number[] } = {}) {
  const state = {
    windows: [...initial],
    focused: 0,
    input: [] as string[],
    connects: 0,
    failNext: false,
    popups: new Set(o.popups ?? []),
  };
  const display: Display = {
    async windows() {
      if (state.failNext) {
        state.failNext = false;
        throw new Error("X connection lost");
      }
      return state.windows;
    },
    async focus(id) {
      state.focused = id;
    },
    async keys(chord) {
      state.input.push(`${state.focused}:${chord.join("+")}`);
      if (chord.length !== 1 || chord[0] !== 0xff1b || o.stubborn?.includes(state.focused)) return;
      if (state.popups.delete(state.focused)) return;
      state.windows = state.windows.filter((w) => w.id !== state.focused);
    },
    async type(text) {
      state.input.push(`${state.focused}:type ${text}`);
    },
    async click(x, y, button, count) {
      state.input.push(`click ${x},${y} b${button} x${count}`);
    },
    close() {},
  };
  const killed: number[] = [];
  const native = new NativeWindows({
    connect: async () => (state.connects++, display),
    helpers: async () => new Map([[77, "zenity"]]),
    kill: (pid) => {
      killed.push(pid);
      state.windows = state.windows.filter((w) => w.pid !== pid);
    },
    pause: async () => {},
  });
  native.appPid = APP;
  return { native, state, killed };
}

test("the app's own window is listed but is not native", async () => {
  const { native } = fakeDisplay([win(1, "walltare", APP), win(2, "Select Folder")]);
  expect((await native.all()).map((w) => [w.id, w.app])).toEqual([
    [1, true],
    [2, false],
  ]);
  expect((await native.native()).map((w) => w.id)).toEqual([2]);
});

test("appeared() reports only windows that are new since it last looked", async () => {
  const { native, state } = fakeDisplay([win(1, "walltare", APP), win(2, "already open")]);
  expect(await native.appeared()).toEqual([]);
  state.windows.push(win(3, "Select Folder"));
  expect((await native.appeared()).map((w) => w.name)).toEqual(["Select Folder"]);
  expect(await native.appeared()).toEqual([]);
});

test("keys go to the topmost native window, or the one asked for", async () => {
  const { native, state } = fakeDisplay([win(1, "walltare", APP), win(2, "chooser"), win(3, "zenity")]);
  expect((await native.keys("Ctrl+L"))?.id).toBe(3);
  expect((await native.type("/tmp", 2))?.id).toBe(2);
  expect(state.input).toEqual([`3:${0xffe3}+${0x6c}`, "2:type /tmp"]);
  await expect(native.keys("Escape", 99)).rejects.toThrow(/no native window 99/);
});

test("with no native window, keys go to whatever has focus", async () => {
  const { native, state } = fakeDisplay([win(1, "walltare", APP)]);
  expect(await native.keys("Escape")).toBeNull();
  expect(state.input).toEqual([`0:${0xff1b}`]);
});

test("a bad key spec is refused before anything is pressed", async () => {
  const { native, state } = fakeDisplay([win(2, "chooser")]);
  await expect(native.keys("Bogus")).rejects.toThrow();
  expect(state.input).toEqual([]);
});

test("clicks are whole pixels and need coordinates", async () => {
  const { native, state } = fakeDisplay([]);
  expect(await native.click(10.4, 20.6, { button: "right", double: true })).toEqual({ x: 10, y: 21 });
  expect(state.input).toEqual(["click 10,21 b3 x2"]);
  await expect(native.click(NaN, 1)).rejects.toThrow(/screen coordinates/);
});

test("dismiss presses Escape until a dialog with a popup is gone", async () => {
  const { native, killed } = fakeDisplay([win(1, "walltare", APP), win(2, "chooser")], { popups: [2] });
  const r = await native.dismiss();
  expect(r.done).toEqual(['Escape → "chooser" 400x300+0+0']);
  expect(r.remaining).toEqual([]);
  expect(killed).toEqual([]);
});

test("dismiss ends the helpers when Escape is not enough", async () => {
  const { native, killed } = fakeDisplay([win(1, "walltare", APP), win(2, "error", 77)], { stubborn: [2] });
  const r = await native.dismiss();
  expect(killed).toEqual([77]);
  expect(r.done).toEqual(['Escape → "error" 400x300+0+0', "ended zenity"]);
  expect(r.remaining).toEqual([]);
});

test("a lost connection is reopened on the next call", async () => {
  const { native, state } = fakeDisplay([win(2, "chooser")]);
  state.failNext = true;
  await expect(native.native()).rejects.toThrow(/connection lost/);
  expect(await native.native()).toHaveLength(1);
  expect(state.connects).toBe(2);
});
