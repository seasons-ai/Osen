import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateCli, parseVersion, resetDiscoveryCache } from "./discovery.ts";
import { VERIFIED_FILE } from "./verified-record.ts";
import type { VerifiedEntry } from "./verified-record.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "discovery-"));
  resetDiscoveryCache();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
const bin = (out: string, name = "claude") => script(join(tmp, "bin"), name, `echo '${out}'`);
const noLogin = { loginShellPath: async () => undefined };

describe("locateCli", () => {
  it("finds the CLI in the process PATH, real isExecutable and runVersion", async () => {
    const file = bin("2.1.288 (Claude Code)");
    const r = await locateCli("claude", { env: { PATH: join(tmp, "bin") }, deps: { loginShellPath: async () => undefined } });
    expect(r).toMatchObject({ found: true, path: file, version: "2.1.288" });
    expect(r.warning).toBeUndefined();
  });

  it("trimmed PATH: takes the folder from the login shell", async () => {
    const file = bin("2.1.288 (Claude Code)");
    const r = await locateCli("claude", {
      env: { PATH: "/usr/bin:/bin" },
      deps: { loginShellPath: async () => `/usr/bin${delimiter}${join(tmp, "bin")}` },
    });
    expect(r).toMatchObject({ found: true, path: file });
    expect(r.searchPath.split(delimiter)).toEqual(["/usr/bin", "/bin", join(tmp, "bin")]);
  });

  it("real loginShellPath: value between markers, junk around it is ignored", async () => {
    const file = bin("2.1.288 (Claude Code)");
    const shell = script(tmp, "fakesh", `echo junk; printf '\\n__COUNCIL_PATH__${join(tmp, "bin")}__COUNCIL_PATH__\\n'; echo more junk`);
    const r = await locateCli("claude", { env: { PATH: "/usr/bin:/bin", SHELL: shell } });
    expect(r).toMatchObject({ found: true, path: file, version: "2.1.288" });
  });

  it("shell fails or prints no markers: not found", async () => {
    for (const body of ["exit 3", "echo nothing here"]) {
      resetDiscoveryCache();
      const shell = script(tmp, "badsh", body);
      const r = await locateCli("claude", { env: { PATH: "/usr/bin:/bin", SHELL: shell } });
      expect(r.found).toBe(false);
      expect(r.reason).toBe("Команда claude не найдена: её нет ни в PATH процесса, ни в PATH оболочки входа");
    }
  });

  it("explicit path does not exist: not found, PATH is not searched", async () => {
    bin("2.1.288 (Claude Code)");
    const missing = join(tmp, "nope", "claude");
    const r = await locateCli("claude", { explicitPath: missing, env: { PATH: join(tmp, "bin") }, deps: noLogin });
    expect(r.found).toBe(false);
    expect(r.reason).toBe(`Команда claude не найдена по заданному пути ${missing}`);
  });

  it("explicit path takes precedence over PATH", async () => {
    bin("2.1.288 (Claude Code)");
    const other = script(join(tmp, "other"), "claude", "echo '2.1.288 (Claude Code)'");
    const r = await locateCli("claude", { explicitPath: other, env: { PATH: join(tmp, "bin") }, deps: noLogin });
    expect(r).toMatchObject({ found: true, path: other });
  });

  it("version warnings", async () => {
    const env = { PATH: join(tmp, "bin") };
    bin("2.1.300 (Claude Code)");
    expect((await locateCli("claude", { env, deps: noLogin })).warning).toBe("Версия claude 2.1.300 новее проверенного диапазона 2.1.288–2.1.288");
    bin("2.0.999 (Claude Code)");
    expect((await locateCli("claude", { env, deps: noLogin })).warning).toBe("Версия claude 2.0.999 старше проверенного диапазона 2.1.288–2.1.288");
    bin("2.1.1000 (Claude Code)");
    expect((await locateCli("claude", { env, deps: noLogin })).warning).toContain("новее");
    script(join(tmp, "bin"), "claude", "exit 1");
    const failed = await locateCli("claude", { env, deps: noLogin });
    expect(failed).toMatchObject({ found: true });
    expect(failed.version).toBeUndefined();
    expect(failed.warning).toContain("Версию claude определить не удалось");
    bin("hello");
    const noVer = await locateCli("claude", { env, deps: noLogin });
    expect(noVer.version).toBeUndefined();
    expect(noVer.warning).toContain("Версию claude определить не удалось");
  });

  it("cache: --version runs once before resetDiscoveryCache", async () => {
    const counter = join(tmp, "count");
    script(join(tmp, "bin"), "claude", `echo x >> '${counter}'; echo '2.1.288 (Claude Code)'`);
    const opts = { env: { PATH: join(tmp, "bin") } };
    await locateCli("claude", opts);
    await locateCli("claude", opts);
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
    resetDiscoveryCache();
    await locateCli("claude", opts);
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("does not pick a different name", async () => {
    bin("0.159.2", "codex");
    const r = await locateCli("claude", { env: { PATH: join(tmp, "bin") }, deps: noLogin });
    expect(r.found).toBe(false);
  });
});

describe("parseVersion", () => {
  it("parses real lines and junk", () => {
    expect(parseVersion("2.1.288 (Claude Code)")).toBe("2.1.288");
    expect(parseVersion("codex-cli 0.159.2")).toBe("0.159.2");
    expect(parseVersion("no version")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
  });
});

// The attack runs only in a child with a finite watchdog: a vitest timeout cannot interrupt synchronous regex work.
describe("Bounded CLI version extraction", () => {
  it("child probe: '9'.repeat(1,048,576) has median <= 1,000 ms and finishes before the 5,000 ms watchdog", async () => {
    const probe = fileURLToPath(new URL("../../scenarios/security-cli-version/probe.ts", import.meta.url));
    const discovery = fileURLToPath(new URL("./discovery.ts", import.meta.url));
    const pending = promisify(execFile)(process.execPath, [probe, discovery, String(1 << 20)], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    pending.child.stdin?.end();
    const result = JSON.parse((await pending).stdout) as { n: number; samples: number[]; median: number };
    expect(result.n).toBe(1_048_576);
    expect(result.samples).toHaveLength(3);
    expect(result.median).toBeLessThanOrEqual(1_000);
  }, 15_000);
});

describe("locateCli verified record", () => {
  const env = () => ({ PATH: join(tmp, "bin") });
  const entry = (o: Partial<VerifiedEntry>): VerifiedEntry =>
    ({ agent: "claude", version: "2.1.288", level: "interface", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0", ...o });
  const data = () => join(tmp, "data");
  const writeLocal = (entries: unknown[]) => { mkdirSync(data(), { recursive: true }); writeFileSync(join(data(), VERIFIED_FILE), JSON.stringify({ schemaVersion: 1, entries })); };
  const logLines = () => (existsSync(join(data(), "logs", "app.log")) ? readFileSync(join(data(), "logs", "app.log"), "utf8").trim().split("\n") : []);

  it("real entry: no warning and verified level real", async () => {
    bin("2.1.288 (Claude Code)");
    const r = await locateCli("claude", { env: env(), deps: noLogin });
    expect(r.warning).toBeUndefined();
    expect(r.verified).toEqual({ level: "real", checkedAt: "2026-10-07" });
  });

  it("interface-only entry: interface warning", async () => {
    bin("codex-cli 0.159.2", "codex");
    const r = await locateCli("codex", { env: env(), deps: noLogin });
    expect(r.warning).toBe("Версия codex 0.159.2: интерфейс проверен, реальная приёмка отсутствует");
    expect(r.verified).toEqual({ level: "interface", checkedAt: "2026-10-16" });
  });

  it("not in the record: newer, older and unknown version", async () => {
    bin("2.1.289 (Claude Code)");
    const n = await locateCli("claude", { env: env(), deps: noLogin });
    expect(n.warning).toBe("Версия claude 2.1.289 новее проверенного диапазона 2.1.288–2.1.288");
    expect(n.verified).toEqual({ level: "none", checkedAt: null });
    bin("2.1.287 (Claude Code)");
    expect((await locateCli("claude", { env: env(), deps: noLogin })).warning).toContain("старше");
    bin("hello");
    const u = await locateCli("claude", { env: env(), deps: noLogin });
    expect(u.warning).toContain("Версию claude определить не удалось");
    expect(u.verified).toEqual({ level: "none", checkedAt: null });
  });

  it("between recorded versions: not-recorded warning with the recorded list", async () => {
    bin("2.2.0 (Claude Code)");
    const record = { entries: [entry({}), entry({ version: "2.3.0" })] };
    const r = await locateCli("claude", { env: env(), deps: { ...noLogin, record } });
    expect(r.warning).toBe("Версии claude 2.2.0 нет в записи проверенных версий (записаны: 2.1.288, 2.3.0)");
  });

  it("local real entry removes the warning; a rewritten file is noticed without resetting the cache", async () => {
    bin("codex-cli 0.159.2", "codex");
    writeLocal([entry({ agent: "codex", version: "0.159.2", level: "real", modelCalls: 1 })]);
    const opts = { env: env(), dataDir: data() };
    const a = await locateCli("codex", opts);
    expect(a.warning).toBeUndefined();
    expect(a.verified?.level).toBe("real");
    writeLocal([entry({ agent: "codex", version: "0.159.2", level: "real", modelCalls: 1, checkedAt: "2026-10-21" })]);
    expect((await locateCli("codex", opts)).verified?.checkedAt).toBe("2026-10-21");
    rmSync(join(data(), VERIFIED_FILE));
    const c = await locateCli("codex", opts);
    expect(c.verified?.level).toBe("interface");
    expect(c.warning).toContain("реальная приёмка отсутствует");
  });

  it("rejected local file: CLI stays found, reason in the warning, file untouched, one log line, nothing created", async () => {
    bin("2.1.288 (Claude Code)");
    writeLocal([entry({ level: "real" })]);
    const file = join(data(), VERIFIED_FILE);
    const before = readFileSync(file);
    const opts = { env: env(), dataDir: data() };
    const r = await locateCli("claude", opts);
    expect(r.found).toBe(true);
    expect(r.warning).toContain("cli-verified.json");
    expect(r.warning).toContain("modelCalls");
    expect(r.verified?.level).toBe("real");
    await locateCli("claude", opts);
    await locateCli("claude", { ...opts, explicitPath: join(tmp, "bin", "claude") });
    expect(readFileSync(file).equals(before)).toBe(true);
    const lines = logLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cli-verified.json");
  });

  it("absent local file is never created", async () => {
    bin("2.1.288 (Claude Code)");
    mkdirSync(data(), { recursive: true });
    await locateCli("claude", { env: env(), dataDir: data() });
    expect(existsSync(join(data(), VERIFIED_FILE))).toBe(false);
    expect(logLines()).toEqual([]);
  });
});
