---
name: appdrive
description: >-
  Drive a Tauri/WebKitGTK desktop app (walltare and others) on a hidden display with `appdrive`:
  launch it, click, type, press keys, read the DOM, take screenshots. Use for computer use on the
  user's apps, to verify or screenshot something in the app, or to click through the app; the
  user's pointer, focus and monitors stay theirs.
---

# appdrive

`appdrive` runs the app from the current checkout on a **hidden display** (its own Xvfb, private
D-Bus, private config/data/cache dirs) and drives it through WebKitWebDriver. Every action stays
on the hidden display, so the user keeps working while you do. All input to the app goes through
`appdrive`; the user's desktop is theirs.

Command: `appdrive` if it is on PATH, else `~/repos/appdrive/bin/appdrive`. `appdrive help` lists
every command and flag.

## Steps

1. **Launch** from inside the checkout: `appdrive launch`. It builds (cargo reuses an unchanged
   build), starts the dev server on a free port, and prints `ready` with a dashboard URL. In Orca
   the dashboard opens as a tab in this worktree, and the worktree card shows your last action:
   the user watches there. Rust changes need `appdrive launch --restart`; frontend changes
   hot-reload.
2. **Read before you look.** `appdrive outline` lists the visible controls, each with a selector
   to paste. `appdrive query <sel>` returns text, attributes, value, focus and rect as JSON. Most
   checks are a query; take an image only when the question is visual.
3. **Act** with `click`, `type`, `key`, `hover`, then re-`query` to confirm the effect. A failed
   action exits non-zero with the reason. Lines starting `appdrive notice:` report something
   that happened beside your action (a native dialog opened, an opener was blocked); read them.
4. **Screenshot** when the answer is visual: `appdrive shot <sel>` captures one element,
   `appdrive shot` the window (scaled to 800px), `appdrive shot --screen` the whole hidden
   display including native dialogs. It prints a PNG path; read the image.
5. **Stop** when you are done: `appdrive stop`. Sessions also stop after 30 idle minutes.

The work is done when every claim you report rests on a query result or a screenshot you read
from this run.

## Selectors

CSS by default. `text=Library` matches the innermost element whose visible text, aria-label,
title or placeholder is exactly that; `text~=libr` is a case-insensitive substring; `xpath=...`
is XPath. `a >> b` searches for b inside each match of a: `[role=tab] >> text=Rank`. Repeated
matches take `--nth N` (0-based, visible matches first). Actions wait up to 5s for the element;
`query` waits 1s; `--timeout MS` changes either. `appdrive wait <sel> [--gone]` waits for
something to appear or go.

Keys: `appdrive key "Ctrl+K"`, `appdrive key "ArrowDown ArrowDown Enter"`. Typing:
`appdrive type <sel> <text> [--clear]`, or `type --focused <text>`.

`appdrive eval '<js>'` runs in the page and returns JSON (an expression, or a body with
`return`; promises are awaited). Tauri commands are reachable as
`window.__TAURI_INTERNALS__.invoke("cmd", {args})`. Visual state reads as text too:
`appdrive eval 'getComputedStyle(document.body).backgroundColor'`, or the `<html>` class for a
theme.

## Native windows

File choosers, zenity message boxes and file managers open on the hidden display, where
WebDriver cannot reach them. A notice tells you when one appears. `appdrive windows` lists them;
`appdrive xkey`, `appdrive xtype` and `appdrive xclick <x> <y>` send X-level input to them
(screen pixels, from `shot --screen --max 0`). In a GTK file chooser, `xkey Ctrl+L`, then
`xtype /some/path`, then `xkey Enter` picks a path. `appdrive dismiss` closes them all.
URL and folder openers (`xdg-open` and friends) are blocked and logged instead.

## walltare

The app reads `<checkout>/.dev-data`, the dev database every dev run shares (ADR 0048 in
walltare), and its Library root is the user's real wallpaper folder: a Soft reject in the app
moves a real file. When the check writes (votes, rejects, settings), launch on a copy:
`appdrive launch --env WALLTARE_DATA_DIR=<copy dir>`, seeding the copy with
`VACUUM INTO` from `.dev-data/walltare.db` as `scripts/dev-app.ts` does.

## Reporting

Say how it was verified. "Verified in the app with appdrive (`<checkout>`)" when you drove the
real app. When only a synthetic test passed, say "verified with <test>, not yet on your repro".
Bugs that show only in a real window on the real compositor (frame timing, Hyprland rules) are
outside appdrive's reach; hand those to the user with what you found.

When something fails, the session's process logs are in `<checkout>/.appdrive/logs/`
(`daemon.log`, `webdriver.log`, `devserver.log`, `build.log`) and `appdrive log` shows the action
history.
