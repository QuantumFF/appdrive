import { createServer } from "node:net";

// Free on both loopbacks: Vite's `localhost` resolves to ::1 here, and a port
// another server holds on ::1 still binds fine on 127.0.0.1.
export function isFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function isFreeEverywhere(port: number): Promise<boolean> {
  return (await isFree(port, "127.0.0.1")) && (await isFree(port, "::1"));
}

export async function freePort(from: number, count = 100): Promise<number> {
  for (let port = from; port < from + count; port++) {
    if (await isFreeEverywhere(port)) return port;
  }
  throw new Error(`no free port in ${from}..${from + count - 1}`);
}

/** A port the kernel picks, for things nobody needs to remember. */
export function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}
