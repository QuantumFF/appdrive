// The environment the app runs in. Every variable here closes a path by which
// the app, or something it spawns, could reach the user's desktop or data.
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Layout } from "./paths.ts";

// Appearance the app should share with the real desktop. Copied, never linked,
// so whatever the app writes stays in the private config. dconf holds
// color-scheme (prefer-dark), which the private portal reports to WebKit.
const APPEARANCE = ["dconf/user", "gtk-3.0/settings.ini", "gtk-4.0/settings.ini", "fontconfig/fonts.conf"];

export function seedAppearance(base: NodeJS.ProcessEnv, l: Layout): void {
  const realConfig = base.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  for (const rel of APPEARANCE) {
    const from = path.join(realConfig, rel);
    if (!existsSync(from)) continue;
    const to = path.join(l.home, "config", rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

// Removed outright: each one names a live socket or session of the user's.
const STRIP = [
  "WAYLAND_DISPLAY", // must be gone *before* dbus-run-session, or the private bus starts
  "WAYLAND_SOCKET", //  xdg-desktop-portal-hyprland on the live session (folder picker leak)
  "HYPRLAND_INSTANCE_SIGNATURE",
  "HYPRLAND_CMD",
  "SWAYSOCK",
  "I3SOCK",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_ACTIVATION_TOKEN",
  "DESKTOP_STARTUP_ID",
  "EGL_PLATFORM",
  "MOZ_ENABLE_WAYLAND",
  "SESSION_MANAGER",
];

export interface SandboxOptions {
  display: number;
  layout: Layout;
  /** Daemon URL the shims report to. */
  daemonUrl: string;
  appEnv: Record<string, string>;
}

export function sandboxEnv(base: NodeJS.ProcessEnv, o: SandboxOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || STRIP.includes(k) || k.startsWith("ORCA_")) continue;
    env[k] = v;
  }
  const h = o.layout.home;
  Object.assign(env, {
    DISPLAY: `:${o.display}`,
    GDK_BACKEND: "x11",
    QT_QPA_PLATFORM: "xcb",
    XDG_SESSION_TYPE: "x11",
    // Not Hyprland: portals.conf would route to the hyprland backend.
    XDG_CURRENT_DESKTOP: "X-appdrive",
    NO_AT_BRIDGE: "1",
    // Window state, webview storage (localStorage lives in the data home) and
    // caches go here, never to ~/.config/<id> or ~/.local/share/<id>.
    XDG_CONFIG_HOME: path.join(h, "config"),
    XDG_DATA_HOME: path.join(h, "data"),
    XDG_CACHE_HOME: path.join(h, "cache"),
    XDG_STATE_HOME: path.join(h, "state"),
    XDG_RUNTIME_DIR: o.layout.runtime,
    PATH: `${o.layout.bin}:${base.PATH ?? "/usr/bin:/bin"}`,
    APPDRIVE_URL: o.daemonUrl,
    TAURI_WEBVIEW_AUTOMATION: "true",
    ...o.appEnv,
  });
  return env;
}

// Opening a URL or folder would land on the user's monitors through their
// browser or file manager. The shims record the request in the action log.
const BLOCKED_OPENERS = [
  "xdg-open",
  "gnome-open",
  "kde-open",
  "kde-open5",
  "kde-open6",
  "wslview",
  "x-www-browser",
  "sensible-browser",
  "www-browser",
];

function report(kind: string): string {
  return `curl -s -m 2 -o /dev/null -X POST -H 'content-type: application/json' \\
  --data-binary "$(printf '%s\\0' "$@" | bun -e 'const a=(await Bun.stdin.text()).split("\\0").slice(0,-1);console.log(JSON.stringify({op:"note",args:{kind:"${kind}",argv:[process.env.SHIM_NAME,...a]}}))')" \\
  "$APPDRIVE_URL/api/op" || true`;
}

export function writeShims(binDir: string): void {
  const write = (name: string, body: string) => {
    const file = path.join(binDir, name);
    writeFileSync(file, `#!/bin/bash\n# appdrive shim: see src/sandbox.ts\nSHIM_NAME=${name}\nexport SHIM_NAME\n${body}\n`);
    chmodSync(file, 0o755);
  };
  for (const name of BLOCKED_OPENERS) write(name, `${report("blocked")}\nexit 0`);
  // gio does more than open; only `gio open` is blocked.
  write(
    "gio",
    `if [ "$1" = open ]; then\n${report("blocked")}\nexit 0\nfi\nexec /usr/bin/gio "$@"`,
  );
  // Native dialogs are allowed: they open on the hidden display. The note tells
  // the agent one is up, since WebDriver cannot see it (use \`shot --screen\`).
  write("zenity", `${report("dialog")}\nexec /usr/bin/zenity "$@"`);
}
