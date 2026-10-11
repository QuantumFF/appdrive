// A stand-in for src/daemon.ts that speaks the same session protocol: it
// writes the session file, walks through a few phases and answers ops.
// `opts.env.MODE` picks the behaviour: "ok", "fail" (launch fails) or "die"
// (exits during launch).
import { writeFileSync } from "node:fs";
import { layout } from "../../src/paths.ts";
import type { LaunchOptions, OpReply, Phase, SessionFile, Status } from "../../src/session.ts";

const opts: LaunchOptions = JSON.parse(process.argv[2]);
const mode = opts.env.MODE ?? "ok";
const L = layout(opts.root);
if (mode === "die") {
  console.log("fake daemon: giving up");
  process.exit(3);
}
let phase: Phase = "building";
const notices = ["native window on the hidden display"];
const status = (): Status => ({
  phase,
  detail: phase === "building" ? "cargo build" : "",
  failure: phase === "failed" ? "build failed" : null,
  app: "demo",
  root: opts.root,
  display: ":150",
  screen: "800x600",
  devPort: null,
  appPid: null,
  appEnv: opts.env,
  dashboard: `http://127.0.0.1:${server.port}/`,
  pid: process.pid,
  startedAt: 1,
  actions: 0,
  frameVersion: 0,
  shots: L.shots,
  logs: L.logs,
});
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/status") return Response.json(status());
    const { op, args } = await req.json();
    const reply = (r: OpReply) => Response.json(r);
    if (op === "stop") {
      setTimeout(() => process.exit(0), 50);
      return reply({ ok: true, result: { stopping: true } });
    }
    if (op === "echo") return reply({ ok: true, result: args, notices: notices.splice(0) });
    return reply({ ok: false, error: `unknown op ${op}`, notices: notices.splice(0) });
  },
});
const file: SessionFile = { pid: process.pid, port: server.port!, url: "", root: opts.root, app: "demo", display: 150, startedAt: 1, groups: {} };
writeFileSync(L.session, JSON.stringify(file));
setTimeout(() => (phase = mode === "fail" ? "failed" : "ready"), 700);
