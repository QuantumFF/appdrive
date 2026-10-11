export async function waitFor(
  what: string,
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 200,
  abort?: () => string | null,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    const reason = abort?.();
    if (reason) throw new Error(`${what}: ${reason}`);
    if (Date.now() > end) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
    await Bun.sleep(intervalMs);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

export function pngSize(buf: Uint8Array): { width: number; height: number } {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

export function tail(text: string, lines = 15): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

export function slug(s: string, max = 32): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max) || "shot"
  );
}
