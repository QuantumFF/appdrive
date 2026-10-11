#!/usr/bin/env bun
// Claude Code PreToolUse hook for Bash: refuses commands that drive the user's
// real desktop (global uinput, focus and cursor moves, window moves) and points
// the agent at appdrive instead. Not installed by default; see README.
//
//   "hooks": { "PreToolUse": [{ "matcher": "Bash",
//     "hooks": [{ "type": "command", "command": "bun ~/repos/appdrive/hooks/guard-desktop.ts" }] }] }

export const RULES: { pattern: RegExp; what: string }[] = [
  { pattern: /\bydotool\b/, what: "ydotool types and clicks into whatever window has the user's focus" },
  { pattern: /\bwtype\b/, what: "wtype types into the user's focused window" },
  { pattern: /\bhl\.dsp\.(focus|window)/, what: "it moves focus or windows on the user's desktop" },
  { pattern: /\bcursor\.move/, what: "it moves the user's pointer" },
  {
    pattern:
      /\bhyprctl\s+(?:--\S+\s+)*dispatch\s+(focuswindow|focusmonitor|movecursor|movecursortocorner|movewindow|movewindowpixel|resizeactive|resizewindowpixel|movetoworkspace|movetoworkspacesilent|workspace|fullscreen|togglefloating)\b/,
    what: "it moves focus, windows, workspaces or the pointer on the user's desktop",
  },
];

export function verdict(command: string): string | null {
  const hit = RULES.find((r) => r.pattern.test(command));
  if (!hit) return null;
  return (
    `Blocked: ${hit.what}. Drive the app on a hidden display instead: ` +
    "`appdrive launch` from the checkout, then `appdrive outline`/`click`/`type`/`key`/`shot` " +
    "(skill: appdrive; ~/repos/appdrive/bin/appdrive). Leave the user's desktop to the user."
  );
}

if (import.meta.main) {
  const input = JSON.parse((await Bun.stdin.text()) || "{}");
  const command = input?.tool_name === "Bash" ? String(input?.tool_input?.command ?? "") : "";
  const reason = verdict(command);
  if (reason) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
      }),
    );
  }
}
