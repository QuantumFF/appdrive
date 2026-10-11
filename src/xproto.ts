// Just enough of the X11 core protocol (and XTEST) to see and poke native
// windows on the hidden display: a portal file chooser, a zenity box, a file
// manager. WebDriver only reaches the webview; this reaches the rest.
//
// It connects to the hidden display's own socket by path, never to DISPLAY,
// so it cannot touch the user's desktop. No xwininfo/xdotool needed.
import { connect, type Socket } from "node:net";

export interface XWindow {
  id: number;
  name: string;
  /** _NET_WM_PID, 0 when the window does not say. */
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const OP = {
  GetWindowAttributes: 3,
  GetGeometry: 14,
  QueryTree: 15,
  GetProperty: 20,
  WarpPointer: 41,
  SetInputFocus: 42,
  GetInputFocus: 43,
  InternAtom: 16,
  QueryExtension: 98,
  GetKeyboardMapping: 101,
} as const;
const ATOM_WM_NAME = 39;
const ANY_PROPERTY_TYPE = 0;

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

export class XConnection {
  private buf = Buffer.alloc(0);
  private waiters: { seq: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private seq = 0;
  private setupResolve!: (b: Buffer) => void;
  private setupReject!: (e: Error) => void;
  private setupDone = false;
  root = 0;
  minKeycode = 8;
  maxKeycode = 255;

  private constructor(private sock: Socket) {}

  static async open(display: number, timeoutMs = 3000): Promise<XConnection> {
    const sock = connect(`/tmp/.X11-unix/X${display}`);
    const x = new XConnection(sock);
    const setup = new Promise<Buffer>((resolve, reject) => {
      x.setupResolve = resolve;
      x.setupReject = reject;
    });
    const timer = setTimeout(() => x.setupReject(new Error(`X :${display}: setup timed out`)), timeoutMs);
    sock.on("data", (d) => x.onData(d as Buffer));
    sock.on("error", (e) => x.fail(e));
    sock.on("close", () => x.fail(new Error("X connection closed")));
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
    // Little-endian, protocol 11.0, no authorization (Xvfb grants local clients).
    const hello = Buffer.alloc(12);
    hello.write("l", 0);
    hello.writeUInt16LE(11, 2);
    hello.writeUInt16LE(0, 4);
    sock.write(hello);
    const s = await setup.finally(() => clearTimeout(timer));
    const vendorLen = s.readUInt16LE(24);
    const formats = s.readUInt8(29);
    x.minKeycode = s.readUInt8(34);
    x.maxKeycode = s.readUInt8(35);
    const screenOffset = 40 + vendorLen + pad4(vendorLen) + formats * 8;
    x.root = s.readUInt32LE(screenOffset);
    return x;
  }

  close(): void {
    this.sock.destroy();
  }

  private fail(e: Error): void {
    if (!this.setupDone) this.setupReject?.(e);
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    if (!this.setupDone) {
      if (this.buf.length < 8) return;
      const total = 8 + this.buf.readUInt16LE(6) * 4;
      if (this.buf.length < total) return;
      const status = this.buf[0];
      const block = this.buf.subarray(0, total);
      this.buf = this.buf.subarray(total);
      this.setupDone = true;
      if (status !== 1) {
        const reasonLen = block[1];
        this.setupReject(new Error(`X refused the connection: ${block.subarray(8, 8 + reasonLen).toString()}`));
        return;
      }
      this.setupResolve(block);
    }
    while (this.buf.length >= 32) {
      const kind = this.buf[0];
      const total = kind === 1 ? 32 + this.buf.readUInt32LE(4) * 4 : 32;
      if (this.buf.length < total) return;
      const pkt = this.buf.subarray(0, total);
      this.buf = this.buf.subarray(total);
      const seq = pkt.readUInt16LE(2);
      if (kind === 0 || kind === 1) {
        const i = this.waiters.findIndex((w) => w.seq === seq);
        if (i < 0) continue;
        const [w] = this.waiters.splice(i, 1);
        if (kind === 0) w.reject(new Error(`X error ${pkt[1]} on request ${pkt[10]}`));
        else w.resolve(Buffer.from(pkt));
      }
      // events (kind >= 2) are ignored
    }
  }

  /** Sends a request; resolves with the reply when `reply` is set. */
  private request(opcode: number, data: Buffer, byte1 = 0, reply = true): Promise<Buffer> {
    const body = Buffer.concat([data, Buffer.alloc(pad4(data.length))]);
    const head = Buffer.alloc(4);
    head[0] = opcode;
    head[1] = byte1;
    head.writeUInt16LE((4 + body.length) / 4, 2);
    this.seq = (this.seq + 1) & 0xffff;
    const seq = this.seq;
    const p = reply
      ? new Promise<Buffer>((resolve, reject) => this.waiters.push({ seq, resolve, reject }))
      : Promise.resolve(Buffer.alloc(0));
    this.sock.write(Buffer.concat([head, body]));
    return p;
  }

  private u32(...vals: number[]): Buffer {
    const b = Buffer.alloc(vals.length * 4);
    vals.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
    return b;
  }

  /** A round trip, so every request before it has been handled. */
  async sync(): Promise<void> {
    await this.request(OP.GetInputFocus, Buffer.alloc(0));
  }

  async children(win = this.root): Promise<number[]> {
    const r = await this.request(OP.QueryTree, this.u32(win));
    const n = r.readUInt16LE(16);
    return Array.from({ length: n }, (_, i) => r.readUInt32LE(32 + i * 4));
  }

  async attributes(win: number): Promise<{ viewable: boolean; overrideRedirect: boolean }> {
    const r = await this.request(OP.GetWindowAttributes, this.u32(win));
    return { viewable: r[26] === 2, overrideRedirect: r[27] === 1 };
  }

  async geometry(win: number): Promise<{ x: number; y: number; width: number; height: number }> {
    const r = await this.request(OP.GetGeometry, this.u32(win));
    return { x: r.readInt16LE(12), y: r.readInt16LE(14), width: r.readUInt16LE(16), height: r.readUInt16LE(18) };
  }

  private atoms = new Map<string, number>();

  async atom(name: string): Promise<number> {
    const known = this.atoms.get(name);
    if (known) return known;
    const n = Buffer.from(name);
    const head = Buffer.alloc(4);
    head.writeUInt16LE(n.length, 0);
    const r = await this.request(OP.InternAtom, Buffer.concat([head, n]), 0);
    const atom = r.readUInt32LE(8);
    this.atoms.set(name, atom);
    return atom;
  }

  private async property(win: number, atom: number): Promise<string> {
    const r = await this.request(OP.GetProperty, this.u32(win, atom, ANY_PROPERTY_TYPE, 0, 64));
    const len = r.readUInt32LE(16);
    return r.subarray(32, 32 + len).toString("utf8");
  }

  async wmPid(win: number): Promise<number> {
    const r = await this.request(OP.GetProperty, this.u32(win, await this.atom("_NET_WM_PID"), ANY_PROPERTY_TYPE, 0, 1));
    return r.readUInt32LE(16) >= 1 && r[1] === 32 ? r.readUInt32LE(32) : 0;
  }

  /** _NET_WM_NAME (what GTK sets), else WM_NAME. */
  async wmName(win: number): Promise<string> {
    return (await this.property(win, await this.atom("_NET_WM_NAME"))) || (await this.property(win, ATOM_WM_NAME));
  }

  /** Top-level windows a person would see: mapped, not override-redirect, bigger than a dot. Bottom to top. */
  async windows(): Promise<XWindow[]> {
    const out: XWindow[] = [];
    for (const id of await this.children()) {
      const a = await this.attributes(id).catch(() => null);
      if (!a?.viewable || a.overrideRedirect) continue;
      const g = await this.geometry(id).catch(() => null);
      if (!g || g.width <= 1 || g.height <= 1) continue;
      out.push({ id, name: await this.wmName(id).catch(() => ""), pid: await this.wmPid(id).catch(() => 0), ...g });
    }
    return out;
  }

  // ------------------------------------------------------------ input (XTEST)

  private xtestOpcode: number | null = null;
  private keymap: Map<number, { code: number; shift: boolean }> | null = null;

  private async xtest(): Promise<number> {
    if (this.xtestOpcode !== null) return this.xtestOpcode;
    const name = Buffer.from("XTEST");
    const head = Buffer.alloc(4);
    head.writeUInt16LE(name.length, 0);
    const r = await this.request(OP.QueryExtension, Buffer.concat([head, name]));
    if (!r[8]) throw new Error("the hidden display has no XTEST extension");
    this.xtestOpcode = r[9];
    return this.xtestOpcode;
  }

  private async fake(type: number, detail: number, x = 0, y = 0): Promise<void> {
    const op = await this.xtest();
    const b = Buffer.alloc(36); // FakeInput is 9 words
    b[0] = op;
    b[1] = 2; // FakeInput
    b.writeUInt16LE(9, 2);
    b[4] = type;
    b[5] = detail;
    b.writeUInt32LE(0, 8); // time: now
    b.writeUInt32LE(type === 6 ? this.root : 0, 12);
    b.writeInt16LE(x, 24);
    b.writeInt16LE(y, 26);
    this.seq = (this.seq + 1) & 0xffff;
    this.sock.write(b);
  }

  async type(text: string): Promise<void> {
    for (const ch of text) await this.keys([keysym(ch)]);
  }

  async click(x: number, y: number, button = 1, count = 1): Promise<void> {
    await this.fake(6, 0, x, y); // MotionNotify, absolute
    for (let i = 0; i < count; i++) {
      await this.fake(4, button); // ButtonPress
      await this.fake(5, button); // ButtonRelease
    }
    await this.sync();
  }

  async focus(win: number): Promise<void> {
    // revert-to Parent(2), time CurrentTime
    await this.request(OP.SetInputFocus, this.u32(win, 0), 2, false);
    await this.sync();
  }

  private async keycodes(): Promise<Map<number, { code: number; shift: boolean }>> {
    if (this.keymap) return this.keymap;
    const count = this.maxKeycode - this.minKeycode + 1;
    const req = Buffer.alloc(4);
    req[0] = this.minKeycode;
    req[1] = count;
    const r = await this.request(OP.GetKeyboardMapping, req);
    const per = r[1];
    const map = new Map<number, { code: number; shift: boolean }>();
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < Math.min(per, 2); j++) {
        const sym = r.readUInt32LE(32 + (i * per + j) * 4);
        if (sym && !map.has(sym)) map.set(sym, { code: this.minKeycode + i, shift: j === 1 });
      }
    }
    this.keymap = map;
    return map;
  }

  /** Presses a chord of keysyms (modifiers first), then releases in reverse. */
  async keys(chord: number[]): Promise<void> {
    const map = await this.keycodes();
    const shift = map.get(0xffe1)!;
    const codes: number[] = [];
    for (const sym of chord) {
      const k = map.get(sym);
      if (!k) throw new Error(`no keycode for keysym 0x${sym.toString(16)} on the hidden display`);
      if (k.shift && shift && !codes.includes(shift.code)) codes.push(shift.code);
      codes.push(k.code);
    }
    for (const c of codes) await this.fake(2, c); // KeyPress
    for (const c of [...codes].reverse()) await this.fake(3, c); // KeyRelease
    await this.sync();
    // Toolkits react to some keys by opening popups (GTK's location
    // completion); a beat between keys lets them settle like a typist would.
    await Bun.sleep(25);
  }
}

const KEYSYMS: Record<string, number> = {
  escape: 0xff1b,
  esc: 0xff1b,
  enter: 0xff0d,
  return: 0xff0d,
  tab: 0xff09,
  backspace: 0xff08,
  delete: 0xffff,
  del: 0xffff,
  left: 0xff51,
  arrowleft: 0xff51,
  up: 0xff52,
  arrowup: 0xff52,
  right: 0xff53,
  arrowright: 0xff53,
  down: 0xff54,
  arrowdown: 0xff54,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  space: 0x20,
  shift: 0xffe1,
  ctrl: 0xffe3,
  control: 0xffe3,
  alt: 0xffe9,
  super: 0xffeb,
  meta: 0xffeb,
  plus: 0x2b,
};
for (let i = 1; i <= 12; i++) KEYSYMS[`f${i}`] = 0xffbe + i - 1;

export function keysym(name: string): number {
  const cps = [...name];
  if (cps.length === 1) {
    const cp = cps[0].codePointAt(0)!;
    return cp < 0x100 ? cp : 0x01000000 + cp;
  }
  const k = KEYSYMS[name.toLowerCase()];
  if (k === undefined) throw new Error(`unknown key "${name}"`);
  return k;
}

/** "Ctrl+L Escape" → [[ctrl, l], [escape]] as keysyms. */
export function parseXKeys(spec: string): number[][] {
  return spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((chord) => {
      const parts = chord === "+" ? ["+"] : chord.replace(/\+\+$/, "+plus").split("+").filter(Boolean);
      // "Ctrl+L" means the L key, not Ctrl+Shift+L.
      return parts.map((p) => keysym(parts.length > 1 && /^[A-Z]$/.test(p) ? p.toLowerCase() : p));
    });
}
