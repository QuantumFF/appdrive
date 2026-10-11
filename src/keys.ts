// "Ctrl+K Escape" → W3C key actions. Chords are space-separated, keys within a
// chord joined by "+"; a lone character is typed as itself.
const NAMED: Record<string, string> = {
  enter: "\uE007",
  return: "\uE007",
  escape: "\uE00C",
  esc: "\uE00C",
  tab: "\uE004",
  backspace: "\uE003",
  delete: "\uE017",
  del: "\uE017",
  insert: "\uE016",
  space: " ",
  arrowleft: "\uE012",
  left: "\uE012",
  arrowup: "\uE013",
  up: "\uE013",
  arrowright: "\uE014",
  right: "\uE014",
  arrowdown: "\uE015",
  down: "\uE015",
  home: "\uE011",
  end: "\uE010",
  pageup: "\uE00E",
  pagedown: "\uE00F",
  shift: "\uE008",
  ctrl: "\uE009",
  control: "\uE009",
  alt: "\uE00A",
  meta: "\uE03D",
  super: "\uE03D",
  cmd: "\uE03D",
  plus: "+",
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = String.fromCharCode(0xe031 + i - 1);

const MODIFIERS = new Set(["\uE008", "\uE009", "\uE00A", "\uE03D"]);

export function keyValue(name: string): string {
  if ([...name].length === 1) return name;
  const v = NAMED[name.toLowerCase()];
  if (!v) throw new Error(`unknown key "${name}" (try Enter, Escape, Tab, ArrowDown, Ctrl+K, F5, a single character)`);
  return v;
}

export interface KeyAction {
  type: "keyDown" | "keyUp";
  value: string;
}

export function chordActions(chord: string): KeyAction[] {
  // "Ctrl++" means Ctrl and "+"
  const parts = chord === "+" ? ["+"] : chord.replace(/\+\+$/, "+plus").split("+").filter(Boolean);
  if (parts.length === 0) throw new Error(`empty key chord in "${chord}"`);
  // "Ctrl+K" means the K key (event.key "k"), not Ctrl+Shift+K.
  const values = parts.map((p) => keyValue(parts.length > 1 && /^[A-Z]$/.test(p) ? p.toLowerCase() : p));
  const mods = values.slice(0, -1);
  for (const m of mods) {
    if (!MODIFIERS.has(m)) throw new Error(`"${chord}": only Ctrl, Shift, Alt and Meta can come before "+"`);
  }
  const key = values[values.length - 1];
  return [
    ...mods.map((value) => ({ type: "keyDown" as const, value })),
    { type: "keyDown", value: key },
    { type: "keyUp", value: key },
    ...mods.reverse().map((value) => ({ type: "keyUp" as const, value })),
  ];
}

export function parseKeys(spec: string): KeyAction[] {
  const chords = spec.trim().split(/\s+/).filter(Boolean);
  if (chords.length === 0) throw new Error("no keys given");
  return chords.flatMap(chordActions);
}

export function textActions(text: string): KeyAction[] {
  return [...text].flatMap((ch) => [
    { type: "keyDown" as const, value: ch },
    { type: "keyUp" as const, value: ch },
  ]);
}
