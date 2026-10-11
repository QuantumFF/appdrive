# appdrive

Launch, drive and screenshot a Tauri / WebKitGTK app **invisibly**, so a coding agent can verify
work in the real app while the user keeps working. The pointer, focus, workspaces and monitors are
never touched, and neither is the app's real config or storage. The user watches the run from a
dashboard tab in Orca.

```
appdrive launch                     # in the app's checkout: build, dev server, hidden display, app
appdrive outline                    # visible controls, each with a selector
appdrive click 'text=Library'
appdrive type 'input[aria-label="Screen width"]' 1920 --clear
appdrive key Escape
appdrive query '[role=tab][aria-selected=true]'
appdrive shot '[role=tablist]'      # prints a PNG path
appdrive stop
```

`appdrive help` has every command. The agent-facing guide is the skill in
[`skill/appdrive/SKILL.md`](skill/appdrive/SKILL.md).

Requirements: `bun`, `xorg-server-xvfb`, `webkit2gtk-4.1` (provides `/usr/bin/WebKitWebDriver`),
`dbus`, ImageMagick (`import`, `magick`). No xdotool: X-level input to native dialogs speaks
XTEST directly (`src/xproto.ts`).

## How it works

One **session** per checkout (git toplevel), owned by a detached daemon (`src/daemon.ts`):

1. **Build.** `cargo build` with `TAURI_CONFIG={"build":{"devUrl":"http://localhost:<port>"}}`, the
   same string `tauri dev --config` passes, so an unchanged build is reused (0.3s) and the binary
   loads *this* checkout's dev server. The port is the one already baked into the binary when it
   is free, else the first free one from the profile's base.
2. **Display.** `Xvfb :N` on a number ≥100 that no X server, lock file, socket or other session
   holds, claimed with an O_EXCL file first (`src/x11.ts`).
3. **Dev server** on that port (walltare: `bun run dev` with `WALLTARE_DEV_PORT`).
4. **Driver.** `dbus-run-session -- WebKitWebDriver` under the sandbox environment
   (`src/sandbox.ts`); the app starts through a W3C session (`TAURI_WEBVIEW_AUTOMATION=true` makes
   wry automatable, no tauri-driver needed).
5. **Serve** the CLI's API, the dashboard and an SSE stream on a stable 127.0.0.1 port per
   checkout, so a dashboard tab left open in Orca reconnects to the next session.

The CLI (`src/cli.ts`) talks to the daemon over HTTP; `src/session.ts` holds both sides of that
protocol (session file, status, op replies, the launch handshake, stopping). The daemon is the
wiring; the parts with behaviour of their own are modules with tests: `src/procs.ts` (process
groups), `src/native.ts` (native windows on the hidden display), `src/actions.ts` (the action log).
State lives in `<checkout>/.appdrive/` (self-ignoring: it writes its own `.gitignore`): `shots/`,
`logs/`, `log.jsonl`, the private XDG homes in `home/`. Domain terms are in `GLOSSARY.md`.

Profiles (`src/profile.ts`) come from `src-tauri/tauri.conf.json`, then a built-in override per
app identifier (walltare's port variable and data dir), then `<checkout>/.appdrive.json`
(`binary`, `args`, `url`, `env`, `build`, `devServer`, `window`). Any WebKitGTK binary that
accepts WebDriver works, MiniBrowser included (`"args": ["--automation"], "url": "…"`).

## What keeps it invisible

Each row was a leak, seen or plausible:

| Path to the user's desktop or data | Closed by |
|---|---|
| Input via ydotool / hyprctl focus and cursor moves | No OS input at all: WebDriver events go into the webview; XTEST goes only to the hidden display's socket |
| Screenshots of whatever is on top | WebDriver screenshots of the webview; `import` of the hidden display's root |
| Folder picker on the real monitors (portal started against the live session) | `WAYLAND_DISPLAY` and `HYPRLAND_INSTANCE_SIGNATURE` removed *before* `dbus-run-session`; private bus; `XDG_CURRENT_DESKTOP=X-appdrive` |
| Window state written to `~/.config/<id>/.window-state.json` | Private `XDG_CONFIG_HOME` |
| Webview localStorage and caches in `~/.local/share/<id>/` | Private `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` |
| Sockets found by default paths (Wayland, Hyprland IPC, session bus) | Private `XDG_RUNTIME_DIR` (`$XDG_RUNTIME_DIR/appdrive/<hash>`) |
| Wrong frontend from another checkout's dev server on 1420 | Port baked per build, dev server started on it by the session |
| `xdg-open` / `gio open` opening the user's browser or file manager | Shims on `PATH` that log the request instead |
| zenity / file manager windows | Allowed, on the hidden display; reported as notices and drivable with `xkey`/`xclick`/`dismiss` |
| Theme mismatch (private config hides `prefer-dark`) | `dconf/user` and GTK settings *copied* into the private config each launch |

**The `:1` incident (2026-10-11).** An early smoke test used `Xvfb -displayfd`. It took `:1`,
the user's XWayland display. Hyprland's XWayland listens only on filesystem sockets
(`/tmp/.X11-unix/X1`, `X1_`), so the abstract name was free, and Xvfb unlinked and replaced the
`X1` path. For about a minute, new X11 clients on the desktop could reach the hidden display. The
path was restored as a hard link to `X1_`. Hence `src/x11.ts`: a number is free only when none of
its markers exist, and the daemon kills Xvfb at once if any socket of a display below 100
vanishes while it starts.

Out of reach by design: bugs that only show in a real window on the real compositor (frame timing,
window rules). Those stay with the user.

## Testing

```
bun test                                   # unit tests
bunx tsc --noEmit
bun scripts/check-invisible.ts ~/repos/walltare -- --env WALLTARE_DATA_DIR=/path/to/copy
```

`check-invisible.ts` runs a full walltare session (launch, outline, clicks, typing, keys, element
and screen shots, a native folder picker driven with X keys and dismissed, stop). It polls
`hyprctl clients` every 200ms, checks cursor, focus, monitors, workspaces and X sockets before and
after, compares mtimes under `~/.config/com.quantumff.walltare` and the real webview storage, and
reads the running app's `/proc/<pid>/environ` to confirm every isolation variable.

## Orca

`launch` opens the dashboard with `orca-ide tab create --worktree path:<checkout>` (once; later
sessions reuse the tab) and keeps the worktree card's comment on the last action through
`orca-ide worktree set --comment`. `stop` restores the card's previous comment. Orca's CLI drops
an empty comment, so a card that had none keeps the session's final status. `--no-orca` skips
all of it. A plugin panel cannot show live data (sandboxed one-shot `srcDoc`, `connect-src
'none'`), which is why the dashboard is a browser tab.

## Orca plugin

`orca-plugin/` is a dev plugin (`quantumff.appdrive`). Load it once in Orca: Settings → Plugins →
Development → load `~/repos/appdrive/orca-plugin`, and accept its capabilities (read the focused
worktree, show notifications, own storage, agent-status events). It adds:

- **appdrive: Open this worktree's dashboard**: switches to the dashboard tab, or opens it
- **appdrive: Open every running dashboard**
- **appdrive: Show running sessions**: a notification listing app, worktree, phase, last action
- a notification when a session crashes or fails to launch (checked when an agent's status
  changes, since Orca reaps idle plugin workers; once per session)
- a static panel describing the above (Orca panels get a one-shot `srcDoc` and no network)

It finds sessions through the registry each daemon writes to
`$XDG_RUNTIME_DIR/appdrive/sessions/<hash>.json` while running.

## Installed on this machine

- `~/.local/bin/appdrive` → `bin/appdrive`
- `~/.claude/skills/appdrive` → `skill/appdrive` (edits here are live)
- `hooks/guard-desktop.ts` as a global `PreToolUse` Bash hook in `~/.claude/settings.json`. It
  refuses ydotool and wtype in command position, and `hyprctl` calls that move focus, windows,
  workspaces or the pointer (`dispatch focuswindow`/`movecursor`/…, `hl.dsp.focus`,
  `hl.dsp.window`, `cursor.move`); reading state (`hyprctl clients`) and mere mentions pass.
