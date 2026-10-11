# Handoff: appdrive

## Problem
Coding agents verifying the user's desktop apps (first target: walltare, a Tauri 2 + React app at `~/repos/walltare`) drive the user's real Hyprland desktop: `ydotool` clicks and types into whatever window has focus, `hyprctl` moves the cursor and steals focus, `grim` screenshots whatever is on top (cursor included), and dev windows land on the user's workspaces. Recorded harm: an agent shrank the user's kitty window (09-09), another reflowed a workspace, and at least 8 sessions skipped visual checks rather than take the user's pointer.

**Goal:** an `appdrive` CLI that launches, drives and screenshots an app **invisibly**: no pointer, focus, workspace or monitor side effects. The user can watch what an agent does with it from inside Orca.

## User's repro (done = this passes)
An agent in an Orca walltare worktree is asked "verify X in the app" while the user keeps working. The agent launches walltare, clicks, types and screenshots via `appdrive`. The user's cursor, focus, workspaces and monitors stay untouched; their real `~/.config/com.quantumff.walltare/` is unchanged. An Orca browser tab in that worktree shows the latest screenshot and a live action log, and the worktree card comment shows the last action. When only a synthetic test passes, report "verified with <test>, not yet on your repro".

## Ruled out
- **`orca computer`** (Orca 1.4.220, `/opt/stably-orca/resources/computer-use-linux/runtime.py`): uses AT-SPI. Screenshots are hard-disabled when `XDG_SESSION_TYPE=wayland` (line 528), hotkeys need xdotool on X11, typing needs real focus, fallback clicks move the real pointer, and there's no way to target a hidden display. It also can't connect at the moment: the a11y bus socket is dead and agent shells carry `NO_AT_BRIDGE=1`.
- **Hyprland headless output** (`hyprctl output create headless`): there's only one seat, so input still goes to the user's focus. The new output also joins the monitor layout and the bar reacts to it.
- **ydotool** in any form: it's global uinput.

## Proven (2026-10-11, by a research agent; scratch files are gone)
**WebKitWebDriver on a private Xvfb display drives the real walltare debug binary.** Everything needed is already installed (`xorg-server-xvfb`, `webkit2gtk-4.1` 2.54.1 provides `/usr/bin/WebKitWebDriver`). tauri-driver and Cargo features aren't needed: tauri-runtime-wry enables automation whenever `TAURI_WEBVIEW_AUTOMATION=true` is set (`tauri-runtime-wry-2.11.4/src/lib.rs:4792`). The session reports `browserName:"wry"`. Set Window Rect and Take Screenshot worked: a 900x600 Settings screen with nothing on the user's monitors. Mesa falls back to llvmpipe; a "no DRI3" warning is harmless.

```bash
D=:$((90+RANDOM%100)); P=$((4500+RANDOM%400)); W=$PWD/.agent; mkdir -p $W/config
Xvfb $D -screen 0 1024x768x24 -nolisten tcp &
env -u WAYLAND_DISPLAY DISPLAY=$D GDK_BACKEND=x11 \
  dbus-run-session -- env TAURI_WEBVIEW_AUTOMATION=true WALLTARE_DATA_DIR=$PWD/.dev-data \
  XDG_CONFIG_HOME=$W/config WebKitWebDriver --port=$P &
curl -XPOST localhost:$P/session -d '{"capabilities":{"alwaysMatch":{"webkitgtk:browserOptions":{"binary":"'$PWD'/src-tauri/target/debug/walltare","args":[]}}}}'
# then W3C: /element, /element/{id}/click, /element/{id}/value, /actions, /window/rect, /screenshot, /element/{id}/screenshot
```

**Traps (each one leaks onto the user's desktop or data):**
- **Portal leak:** unset `WAYLAND_DISPLAY` **before** `dbus-run-session`. Otherwise the private bus starts xdg-desktop-portal-hyprland against the live session, and the folder picker (Browse) opens on the user's monitors. walltare also has a zenity error box and the opener plugin (`xdg-open`).
- **Window-state leak:** walltare's window-state plugin writes to `$XDG_CONFIG_HOME/com.quantumff.walltare/.window-state.json`. Use a per-run `XDG_CONFIG_HOME`.
- **Wrong frontend:** the debug binary loads the dev server on its compiled-in `devUrl` port (1420), which another checkout may be serving. Build per worktree with `--config '{"build":{"devUrl":"http://localhost:<port>"}}'` and a Vite on that port. `~/repos/walltare/scripts/dev-app.ts` already picks a free port and sets `WALLTARE_DEV_PORT` / `WALLTARE_DATA_DIR`. See `docs/adr/0048-a-dev-run-owns-its-checkout.md` there.
- `bun`/`bunx` instead of npm/npx (walltare convention). The user's shell is fish: wrap bash in `bash -c '…'`. Use `pkill -x`, never `pkill -f`.

**Also proven:** the old Xvfb + `import -window root` route works but has no input. Playwright with Vite and walltare's `tests/ipc-mocks.ts` (`mockBootedApp`) works for layout checks, but it's Chromium rather than WebKitGTK and has no real backend.

## Orca integration facts (Orca 1.4.220, CLI is `orca-ide`; bare `orca` is a 0-byte file or the GNOME screen reader)
- **A plugin panel can't show live data.** The plugin system exists (`orca-plugin.json`, `pluginApi: 1`, `contributes.panels/commands/events/...`, worker `main` forked with full Node). Settings → Plugins → Development loads a plugin from a local folder. But panels are `sandbox="allow-scripts"` iframes with a one-shot `srcDoc` and CSP `connect-src 'none'; img-src data:`, with no worker→panel channel (`out/shared/plugins/plugin-panel-shell.js`). Plugin events carry no tool usage. Inspect the source with `bunx @electron/asar extract /opt/stably-orca/resources/app.asar <dir>`.
- **The live surface that works:** `orca-ide tab create --url http://127.0.0.1:<port> --worktree <sel>` opens an embedded browser tab the user watches, and `orca-ide worktree set --worktree active --comment "<last action>"` sets the card status. Run `orca-ide skills get orca-cli` for the CLI guide.

## Next steps
1. **Core CLI**, in this repo. Make it generic over Tauri/WebKitGTK apps, with per-app launch config (binary, env, dev server). Subcommands along the lines of `launch | click <css> | type <css> <text> | key <keys> | query <css> | shot [css] [--scale] | eval | stop`, with session state per worktree so parallel agents never collide (own display, WebDriver port, config and data dirs). `query` returns text and attributes so most checks need no image. `shot` defaults to small, element-scoped PNGs. Done when every trap above is handled and a walltare session runs end to end while `hyprctl clients` / `hyprctl cursorpos` show no change and the real window-state file's mtime is unchanged.
2. **Dashboard:** `launch` starts a localhost page with the latest screenshot and a live action log (SSE), opens it via `orca-ide tab create`, and each action updates the worktree comment. Done when the user can watch an agent's run inside Orca.
3. **Agent entry point:** a skill (with a description that fires on "computer use", "screenshot/verify in the app", "click through the app") that points agents at `appdrive`.
4. **Ask the user first, since these are outside this repo:**
   - installing the skill into `~/.claude/skills/`;
   - a global `PreToolUse` hook that blocks `ydotool` / `wtype` / `hl.dsp.focus` / `cursor.move` / `hl.dsp.window` and redirects to `appdrive` (it can also log appdrive calls for the dashboard);
   - removing `Bash(ydotool:*)` / `Bash(hyprctl:*)` from `~/repos/walltare/.claude/settings.local.json`;
   - narrowing `~/.claude/skills/computer-use` (an Orca-managed stub, which may be overwritten on Orca updates);
   - walltare `dev-app.ts` changes;
   - the optional Orca dev plugin (an "Open appdrive view" command + notifications; its panel can only be a static launcher). The user hasn't decided on it yet.
   - `pacman -S xdotool` would add OS-level input inside Xvfb as a fallback. It needs sudo, so give the user the exact command.

Not covered by this approach: bugs that only show in a real window on the real compositor (walltare's frame-timing work). Those stay with the user.
