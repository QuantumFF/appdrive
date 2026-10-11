#!/usr/bin/env bun
// Claude Code PreToolUse hook for Bash: refuses commands that drive the user's
// real desktop (global uinput, focus and cursor moves, window moves) and points
// the agent at appdrive instead. Installed globally in ~/.claude/settings.json:
//
//   "hooks": { "PreToolUse": [{ "matcher": "Bash",
//     "hooks": [{ "type": "command", "command": "bun ~/repos/appdrive/hooks/guard-desktop.ts" }] }] }

// A program in command position: start of a line, or after ; & | ( $( or a
// backtick, past any env assignments, sudo/exec/env/timeout and a directory.
// A mere mention (rg ydotool, a commit message) passes.
const CMD = String.raw`(?:^|[;&|(\x60]|\$\()\s*(?:(?:sudo|exec|env|command|nohup|timeout\s+\S+)\s+|\w+=\S*\s+)*(?:\S*/)?`;
const run = (prog: string) => new RegExp(`${CMD}${prog}(?=\\s|$|[;&|)])`, "m");
const viaHyprctl = (expr: string) => new RegExp(String.raw`\bhyprctl\b[^\n;&|]*` + expr);

export const RULES: { pattern: RegExp; what: string }[] = [
  { pattern: run("ydotool"), what: "ydotool types and clicks into whatever window has the user's focus" },
  { pattern: run("wtype"), what: "wtype types into the user's focused window" },
  { pattern: viaHyprctl(String.raw`\bhl\.dsp\.(focus|window)`), what: "it moves focus or windows on the user's desktop" },
  { pattern: viaHyprctl(String.raw`\bcursor\.move`), what: "it moves the user's pointer" },
  {
    pattern: viaHyprctl(
      String.raw`\bdispatch\s+(focuswindow|focusmonitor|movecursor|movecursortocorner|movewindow|movewindowpixel|resizeactive|resizewindowpixel|movetoworkspace|movetoworkspacesilent|workspace|fullscreen|togglefloating)\b`,
    ),
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
