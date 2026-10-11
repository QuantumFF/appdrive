import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expand, loadProfile } from "../src/profile.ts";

function checkout(conf: object, cargoName = "demo", override?: object): string {
  const root = mkdtempSync(path.join(tmpdir(), "appdrive-profile-"));
  mkdirSync(path.join(root, "src-tauri"));
  writeFileSync(path.join(root, "src-tauri", "tauri.conf.json"), JSON.stringify(conf));
  writeFileSync(path.join(root, "src-tauri", "Cargo.toml"), `[package]\nname = "${cargoName}"\nversion = "0.1.0"\n`);
  if (override) writeFileSync(path.join(root, ".appdrive.json"), JSON.stringify(override));
  return root;
}

test("a generic Tauri app keeps its fixed dev port and bakes it into the build", () => {
  const p = loadProfile(
    checkout({
      identifier: "com.example.demo",
      productName: "Demo",
      build: { devUrl: "http://localhost:5173", beforeDevCommand: "bun run dev" },
      app: { windows: [{ width: 900, height: 600 }] },
    }),
  );
  expect(p.binary).toBe(path.join("src-tauri", "target", "debug", "demo"));
  expect(p.devServer).toMatchObject({ cmd: ["sh", "-c", "bun run dev"], port: 5173, scan: 0 });
  expect(expand(p.build!.env.TAURI_CONFIG, { port: 5173 })).toBe('{"build":{"devUrl":"http://localhost:5173"}}');
  expect(p.window).toEqual({ width: 900, height: 600 });
});

test("walltare moves its port and keeps its dev data in the checkout", () => {
  const root = checkout(
    {
      identifier: "com.quantumff.walltare",
      productName: "walltare",
      build: { devUrl: "http://localhost:1420", beforeDevCommand: "bun run dev" },
      app: { windows: [{ width: 1280, height: 800 }] },
    },
    "walltare",
  );
  const p = loadProfile(root);
  expect(p.name).toBe("walltare");
  expect(p.devServer).toMatchObject({ port: 1420, scan: 100, env: { WALLTARE_DEV_PORT: "{port}" } });
  expect(expand(p.env.WALLTARE_DATA_DIR, { root })).toBe(`${root}/.dev-data`);
});

test(".appdrive.json overrides the rest", () => {
  const p = loadProfile(
    checkout(
      { identifier: "com.example.demo", build: { devUrl: "http://localhost:5173", beforeDevCommand: "x" } },
      "demo",
      { args: ["--flag"], env: { A: "1" }, devServer: null, window: { width: 640 } },
    ),
  );
  expect(p.args).toEqual(["--flag"]);
  expect(p.env).toEqual({ A: "1" });
  expect(p.devServer).toBeNull();
  expect(p.window).toEqual({ width: 640, height: 800 });
});

test("a checkout with neither tauri.conf.json nor .appdrive.json is refused", () => {
  const root = mkdtempSync(path.join(tmpdir(), "appdrive-profile-"));
  expect(() => loadProfile(root)).toThrow(/no src-tauri\/tauri.conf.json/);
});
