import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkConnection, SERVER_TOOLS } from "./check.ts";

const stub = { command: process.execPath, args: [resolve(import.meta.dirname, "testdata/stub-server.mjs")] };
const mode = (STUB_MODE: string) => ({ extraEnv: { STUB_MODE } });
// Own temp folder: other test files run connection checks in the shared one at the same time.
const sharedTmp = tmpdir();
const ownTmp = mkdtempSync(join(sharedTmp, "connect-check-test-"));
process.env.TMPDIR = ownTmp;
afterAll(() => {
  process.env.TMPDIR = sharedTmp;
  rmSync(ownTmp, { recursive: true, force: true });
});
const checkDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("osen-check-"));

describe("Бесплатная проверка соединения", () => {
  it("passes on the real server and leaves the owner's data folder untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "check-home-"));
    const before = new Set(checkDirs());
    try {
      const r = await checkConnection({ command: process.execPath, args: [resolve(import.meta.dirname, "../../mcp/src/main.ts")] }, { extraEnv: { COUNCIL_DEV: "1", HOME: home } });
      expect(r.ok).toBe(true);
      if (r.ok) for (const t of SERVER_TOOLS) expect(r.tools).toContain(t);
      expect(existsSync(join(home, "Library/Application Support/osen"))).toBe(false);
      expect(existsSync(join(home, "Library/Application Support/model-council"))).toBe(false);
      expect(checkDirs().filter((n) => !before.has(n))).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 30000);

  it("reports spawn_failed for a missing script and a missing binary", async () => {
    for (const e of [{ command: process.execPath, args: ["/nonexistent/main.ts"] }, { command: "/nonexistent/osen-mcp", args: [] }]) {
      const r = await checkConnection(e);
      expect(r).toMatchObject({ ok: false, reason: "spawn_failed" });
      expect(r.durationMs).toBeLessThan(5000);
    }
  });

  it("reports stray_stdout when the server prints a non-JSON-RPC line", async () => {
    expect(await checkConnection(stub, mode("stray"))).toMatchObject({ ok: false, reason: "stray_stdout", detail: "hello" });
  });

  it("reports timeout for a silent server within the deadline", async () => {
    const r = await checkConnection(stub, { ...mode("silent"), timeoutMs: 1500 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(r.durationMs).toBeLessThan(3000);
  });

  it("reports missing_tools naming the absent tool", async () => {
    const r = await checkConnection(stub, mode("six"));
    expect(r).toMatchObject({ ok: false, reason: "missing_tools", detail: "missing: council_continue" });
  });

  it("accepts a complete stub and cleans its temp dir", async () => {
    const before = new Set(checkDirs());
    expect((await checkConnection(stub, mode("ok"))).ok).toBe(true);
    expect(checkDirs().filter((n) => !before.has(n))).toEqual([]);
  });

  it("reports no_entry at once without spawning", async () => {
    const before = checkDirs().length;
    for (const e of [null, undefined]) expect(await checkConnection(e)).toMatchObject({ ok: false, reason: "no_entry" });
    expect(checkDirs().length).toBe(before);
  });
});
