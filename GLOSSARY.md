# appdrive

Driving a desktop app on a display the user cannot see, so an agent can verify work in the real app
while the user keeps their pointer, focus, monitors and data.

## Language

**Checkout**:
The app's source tree an agent works in (a git toplevel). It has at most one session.
_Avoid_: repo, project, workspace

**Session**:
One run of the app for one checkout, from launch to stop, with its own hidden display, ports and
private homes.
_Avoid_: run, instance

**Daemon**:
The detached process that owns a session and answers the CLI and the dashboard.
_Avoid_: server, backend

**Phase**:
Where a session is in its life: launching through a named step, ready, crashed, failed or stopping.
_Avoid_: state, status

**Profile**:
How to build, serve and start one app: binary, args, env, build command, dev server, window size.
_Avoid_: config, app config

**Hidden display**:
The private X server a session's app runs on, numbered 100 or above and claimed so nothing else
uses it.
_Avoid_: virtual screen, Xvfb (that is the program, not the concept)

**Process group**:
One of a session's child processes (build, Xvfb, dev server, driver) together with everything it
spawned, ended as a unit.
_Avoid_: child, service

**Native window**:
A window on the hidden display that is not the app's own: a portal file chooser, a zenity box, a
file manager. The webview driver cannot reach it.
_Avoid_: dialog (too narrow), popup

**Op**:
One thing the agent asks a session to do: click, type, key, query, shot, dismiss and the rest.
_Avoid_: command (that is the CLI word), request

**Action log**:
The ordered record of a session's ops and outcomes, plus its launch, stop and notes.
_Avoid_: history, events

**Notice**:
Something the agent should hear about on its next op: a native window appeared, an opener was
blocked.
_Avoid_: warning, alert

**Frame**:
The latest picture of the whole hidden display, shown on the dashboard.
_Avoid_: screenshot (that is a shot)

**Shot**:
A PNG the agent asked for: the app window, one element, or the whole hidden display.
_Avoid_: screenshot, capture

**Dashboard**:
The page a user watches a session on: phase, latest frame, live action log.
_Avoid_: panel (an Orca panel cannot show it), viewer

**Registry**:
The machine-wide list of running sessions, one entry each, that lets the Orca plugin find
dashboards.
_Avoid_: index, session list

**Leak**:
Any path by which a session could reach the user's desktop or data. The README's leak table is
the contract.
_Avoid_: side effect (too broad)
