import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateCli, parseVersion, pinnedEnv, resetDiscoveryCache } from "./discovery.ts";
import { writeExecutable } from "../executable.testutil.ts";
import { installPin, pinsPath, usePin } from "./pins.ts";
import type { PackageSource } from "./pins.ts";
import { VERIFIED_FILE, addLocalEntry } from "./verified-record.ts";
import type { VerifiedEntry, VerifiedRecord } from "./verified-record.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "discovery-"));
  resetDiscoveryCache();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  return writeExecutable(file, `#!/bin/sh\n${body}\n`);
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

  it("real loginShellPath: value between markers, junk around it is ignored", { timeout: 60_000 }, async () => {
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

  it("not found with a data folder: nothing is installed, cli/ is not created", async () => {
    const data = join(tmp, "data");
    mkdirSync(data);
    const r = await locateCli("claude", { env: { PATH: join(tmp, "empty") }, dataDir: data, deps: noLogin });
    expect(r.found).toBe(false);
    expect(existsSync(join(data, "cli"))).toBe(false);
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

// Search order: explicit path, then the Osen pin, then PATH.
describe("locateCli search order and pins", () => {
  const entry = (version: string): VerifiedEntry => ({ agent: "claude", version, level: "real", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 2 });
  const record: VerifiedRecord = { entries: [entry("1.0.0"), entry("1.1.0")] };
  const source: PackageSource = {
    async fetch(agent, version, d) {
      const exe = join(d, "node_modules", "pkg", "bin", agent);
      mkdirSync(join(d, "node_modules", "pkg", "bin"), { recursive: true });
      writeExecutable(exe, `#!/bin/sh\necho "$CLAUDE_CONFIG_DIR|$DISABLE_UPDATES" > "$0.env"; echo "${version}"\n`);
      return { executable: exe, source: `fake:${agent}@${version}` };
    },
  };
  const data = () => join(tmp, "data");
  const pin = async (version = "1.0.0") => {
    const r = await installPin(data(), "claude", { version }, { source, record });
    if (!r.ok) throw new Error(JSON.stringify(r));
  };
  const pathCounter = () => join(tmp, "path-version-runs");
  const pathBin = () => script(join(tmp, "bin"), "claude", `echo x >> '${pathCounter()}'; echo '9.9.9 (Claude Code)'`);
  const opts = (extra: object = {}) => ({ env: { PATH: join(tmp, "bin") }, dataDir: data(), deps: { ...noLogin, record }, ...extra });

  it("a pin beats claude on PATH; its --version probe runs with the pinned env", async () => {
    pathBin();
    await pin();
    const r = await locateCli("claude", opts());
    expect(r).toMatchObject({ found: true, source: "pin", version: "1.0.0" });
    expect(r.path).toContain(join(data(), "cli"));
    expect(r.pin?.version).toBe("1.0.0");
    expect(existsSync(pathCounter())).toBe(false);
    expect(readFileSync(`${r.path}.env`, "utf8").trim()).toBe(`${r.pin!.configDir}|1`);
  });

  it("explicit path beats the pin", async () => {
    await pin();
    const other = script(join(tmp, "other"), "claude", "echo '2.1.288 (Claude Code)'");
    const r = await locateCli("claude", opts({ explicitPath: other }));
    expect(r).toMatchObject({ found: true, source: "explicit", path: other });
    expect(r.pin).toBeUndefined();
  });

  it("no pin: PATH, source path", async () => {
    pathBin();
    const r = await locateCli("claude", opts());
    expect(r).toMatchObject({ found: true, source: "path", version: "9.9.9" });
    expect(r.pin).toBeUndefined();
  });

  it("the pin file is gone while PATH has claude: not found, reason names the pin path, PATH binary is not run", async () => {
    pathBin();
    await pin();
    const p = (await locateCli("claude", opts())).path!;
    rmSync(p);
    resetDiscoveryCache();
    const r = await locateCli("claude", opts());
    expect(r.found).toBe(false);
    expect(r.source).toBe("pin");
    expect(r.reason).toContain(p);
    expect(existsSync(pathCounter())).toBe(false);
  });

  it("a rejected pins.json: PATH is used, the warning names the pins file", async () => {
    pathBin();
    mkdirSync(join(data(), "cli"), { recursive: true });
    writeFileSync(pinsPath(data()), "{ nope");
    const r = await locateCli("claude", opts());
    expect(r).toMatchObject({ found: true, source: "path" });
    expect(r.warning).toContain(pinsPath(data()));
  });

  it("a rejected pins.json and nothing on PATH: not found, the warning is still returned", async () => {
    mkdirSync(join(data(), "cli"), { recursive: true });
    writeFileSync(pinsPath(data()), "{ nope");
    const r = await locateCli("claude", { env: { PATH: join(tmp, "empty") }, dataDir: data(), deps: { ...noLogin, record } });
    expect(r.found).toBe(false);
    expect(r.reason).toContain("не найдена");
    expect(r.warning).toContain(pinsPath(data()));
  });

  it("real cache: a use switch between two calls is seen", async () => {
    await pin("1.0.0");
    await pin("1.1.0");
    // the real record (no injected deps) must hold real entries for the pinned versions
    for (const v of ["1.0.0", "1.1.0"]) expect(addLocalEntry(data(), entry(v)).ok).toBe(true);
    const o = { env: { PATH: join(tmp, "empty") }, dataDir: data() };
    expect((await locateCli("claude", o)).pin?.version).toBe("1.0.0");
    expect(usePin(data(), "claude", "1.1.0", { record }).ok).toBe(true);
    expect((await locateCli("claude", o)).pin?.version).toBe("1.1.0");
  });

  it("pinnedEnv", () => {
    expect(pinnedEnv("claude", "/c")).toEqual({ CLAUDE_CONFIG_DIR: "/c", DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1" });
    expect(pinnedEnv("codex", "/c")).toEqual({ CODEX_HOME: "/c" });
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
