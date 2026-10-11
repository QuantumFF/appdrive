// A minimal W3C WebDriver client: just what WebKitWebDriver needs to drive wry.
export const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
export type ElementRef = { [ELEMENT_KEY]: string };

export class WebDriverError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function elementId(ref: ElementRef): string {
  return ref[ELEMENT_KEY];
}

export class WebDriver {
  sessionId: string | null = null;

  constructor(public base: string) {}

  async request<T = any>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new WebDriverError("bad response", `HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok || json?.value?.error) {
      throw new WebDriverError(json?.value?.error ?? `HTTP ${res.status}`, json?.value?.message ?? text.slice(0, 200));
    }
    return json.value as T;
  }

  private s(path: string): string {
    if (!this.sessionId) throw new WebDriverError("no session", "the app is not running");
    return `/session/${this.sessionId}${path}`;
  }

  async ready(): Promise<boolean> {
    try {
      const v = await this.request<{ ready: boolean }>("GET", "/status", undefined, 2000);
      return !!v?.ready;
    } catch {
      return false;
    }
  }

  async newSession(binary: string, args: string[]): Promise<Record<string, unknown>> {
    const v = await this.request<{ sessionId: string; capabilities: Record<string, unknown> }>(
      "POST",
      "/session",
      { capabilities: { alwaysMatch: { "webkitgtk:browserOptions": { binary, args } } } },
      120_000,
    );
    this.sessionId = v.sessionId;
    return v.capabilities;
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.request("DELETE", this.s(""), undefined, 10_000);
    } finally {
      this.sessionId = null;
    }
  }

  execute<T = any>(script: string, args: unknown[] = []): Promise<T> {
    return this.request<T>("POST", this.s("/execute/sync"), { script, args });
  }

  /** The script gets a callback as its last argument. */
  executeAsync<T = any>(script: string, args: unknown[] = [], timeoutMs = 30_000): Promise<T> {
    return this.request<T>("POST", this.s("/execute/async"), { script, args }, timeoutMs + 5000);
  }

  setTimeouts(t: { script?: number; pageLoad?: number; implicit?: number }): Promise<void> {
    return this.request("POST", this.s("/timeouts"), t);
  }

  click(id: string): Promise<void> {
    return this.request("POST", this.s(`/element/${id}/click`), {});
  }

  clear(id: string): Promise<void> {
    return this.request("POST", this.s(`/element/${id}/clear`), {});
  }

  sendKeys(id: string, text: string): Promise<void> {
    return this.request("POST", this.s(`/element/${id}/value`), { text });
  }

  actions(actions: unknown[]): Promise<void> {
    return this.request("POST", this.s("/actions"), { actions });
  }

  releaseActions(): Promise<void> {
    return this.request("DELETE", this.s("/actions"));
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from(await this.request<string>("GET", this.s("/screenshot")), "base64");
  }

  async elementScreenshot(id: string): Promise<Buffer> {
    return Buffer.from(await this.request<string>("GET", this.s(`/element/${id}/screenshot`)), "base64");
  }

  windowRect(): Promise<Rect> {
    return this.request<Rect>("GET", this.s("/window/rect"));
  }

  setWindowRect(r: Partial<Rect>): Promise<Rect> {
    return this.request<Rect>("POST", this.s("/window/rect"), r);
  }

  navigate(url: string): Promise<void> {
    return this.request("POST", this.s("/url"), { url }, 60_000);
  }

  url(): Promise<string> {
    return this.request<string>("GET", this.s("/url"));
  }

  title(): Promise<string> {
    return this.request<string>("GET", this.s("/title"));
  }
}
