// The session's action log: every op the agent runs, plus the launch, the
// stop and notes (things the agent should hear about). Kept in memory for the
// dashboard and `appdrive log`, appended to log.jsonl, and run one at a time.
import { appendFileSync, existsSync, renameSync } from "node:fs";

export interface LogEntry {
  id: number;
  t: number;
  op: string;
  args?: string;
  ok?: boolean;
  ms?: number;
  summary?: string;
  error?: string;
  shot?: string;
}

export interface ActionLogOptions {
  /** log.jsonl. A previous run's file is kept as .prev.jsonl. */
  file: string;
  /** An op has started (the entry has no outcome yet). */
  onStart?: (e: LogEntry) => void;
  /** An entry is final: an op's outcome, a launch, a stop or a note. */
  onRecord?: (e: LogEntry) => void;
}

const KEEP = 500;
const KEEP_NOTICES = 20;
/** Entries the session makes itself, not the agent's actions. */
const OWN = new Set(["launch", "stop", "note"]);

export class ActionLog {
  /** An op is running. */
  busy = false;
  /** The latest entry in one line, e.g. "✓ click text=Library". */
  last = "";
  private seq = 0;
  private history: LogEntry[] = [];
  private notices: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private o: ActionLogOptions) {
    if (existsSync(o.file)) renameSync(o.file, o.file.replace(/\.jsonl$/, ".prev.jsonl"));
  }

  /**
   * Runs `fn` after every op queued before it, and logs its outcome. A failed
   * op rethrows, and does not hold up the ones after it.
   */
  run<T extends { summary: string; shot?: string }>(op: string, args: Record<string, any>, fn: () => Promise<T>): Promise<T> {
    const go = async () => {
      this.busy = true;
      const entry: LogEntry = { id: ++this.seq, t: Date.now(), op, args: describeArgs(op, args) };
      this.o.onStart?.(entry);
      try {
        const r = await fn();
        this.record(Object.assign(entry, { ok: true, ms: Date.now() - entry.t, summary: r.summary, shot: r.shot }));
        return r;
      } catch (e) {
        this.record(Object.assign(entry, { ok: false, ms: Date.now() - entry.t, error: (e as Error)?.message ?? String(e) }));
        throw e;
      } finally {
        this.busy = false;
      }
    };
    const p = this.queue.then(go, go);
    this.queue = p.catch(() => {});
    return p;
  }

  /** An entry for something the session did itself: `launch` or `stop`. */
  add(op: string, ok: boolean, text: string): void {
    this.record({ id: ++this.seq, t: Date.now(), op, ok, ...(ok ? { summary: text } : { error: text }) });
  }

  /** Something the agent should hear about on its next command. */
  note(summary: string, ok: boolean): void {
    this.notices.push(summary);
    if (this.notices.length > KEEP_NOTICES) this.notices.shift();
    this.record({ id: ++this.seq, t: Date.now(), op: "note", ok, summary });
  }

  /** The notes since the last call. */
  takeNotices(): string[] {
    return this.notices.splice(0);
  }

  recent(n: number): LogEntry[] {
    return this.history.slice(-n);
  }

  /** Entries so far, the session's own included. */
  get count(): number {
    return this.seq;
  }

  /** The agent's actions so far, not counting launch, stop and notes. */
  actions(): number {
    return this.history.filter((e) => !OWN.has(e.op)).length;
  }

  private record(entry: LogEntry): void {
    this.last = `${entry.ok === false ? "✗" : "✓"} ${entry.op}${entry.args ? ` ${entry.args}` : ""}`.slice(0, 200);
    this.history.push(entry);
    if (this.history.length > KEEP) this.history.shift();
    appendFileSync(this.o.file, JSON.stringify(entry) + "\n");
    this.o.onRecord?.(entry);
  }
}

/** An op's arguments in one line, the way the CLI took them. */
export function describeArgs(op: string, a: Record<string, any>): string {
  const bits: string[] = [];
  if (a.sel) bits.push(a.sel);
  if (op === "type") bits.push(JSON.stringify(a.text ?? ""));
  if (op === "key") bits.push(a.keys);
  if (op === "eval") bits.push(String(a.code).slice(0, 60));
  if (op === "resize") bits.push(`${a.width}x${a.height}`);
  if (a.nth) bits.push(`#${a.nth}`);
  for (const f of ["double", "force", "screen", "gone", "all", "focused", "clear"]) if (a[f]) bits.push(`--${f}`);
  if (a.button && a.button !== "left") bits.push(`--button ${a.button}`);
  return bits.join(" ");
}
