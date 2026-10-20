import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliLocation } from "../cli-agents/discovery.ts";
import { FAKE_MODELS, startFakeServer } from "../http/fake-server.ts";
import type { FakeServer } from "../http/fake-server.ts";
import { configPath } from "./config.ts";
import type { CliProvider, HttpProvider, Provider, Registry } from "./config.ts";
import { ensureRegistry, inspectProvider, inspectProviders } from "./providers.ts";

const FIX = resolve(import.meta.dirname, "../cli-agents/fixtures");
const fixture = (n: string) => join(FIX, n);
const claude: CliProvider = { id: "claude", kind: "cli", label: "Claude Code", agent: "claude", models: [] };
const codex: CliProvider = { id: "codex", kind: "cli", label: "Codex", agent: "codex", models: [] };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "providers-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function stub(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
function fakeClaude(o: { version?: string; helpFile?: string; helpFails?: boolean } = {}) {
  const help = o.helpFails ? "exit 1" : `/bin/cat '${o.helpFile ?? fixture("claude-2.1.288-help.txt")}'`;
  stub("claude", `case "$1" in --version) echo '${o.version ?? "2.1.288 (Claude Code)"}';; --help) ${help};; esac`);
}
function fakeCodex() {
  stub("codex", `case "$1" in --version) echo 'codex-cli 0.159.2';; exec) /bin/cat '${fixture("codex-0.159.2-exec-help.txt")}';; features) /bin/cat '${fixture("codex-0.159.2-features.txt")}';; esac`);
}
const env = () => ({ PATH: dir, SHELL: stub("sh-empty", "exit 0") });
const noModels = { listModels: async () => ({ models: [], confirmed: false }) };

describe("inspectProvider cli", () => {
  it("both CLIs found", async () => {
    fakeClaude(); fakeCodex();
    const [c, x] = await inspectProviders({ providers: [claude, codex], defaults: {} as Registry["defaults"] }, { env: env(), deps: noModels });
    expect(c?.status).toMatchObject({ available: true, version: "2.1.288" });
    expect(x?.status).toMatchObject({ available: true, version: "0.159.2" });
    expect(c?.runtime?.flags.has("--tools")).toBe(true);
    expect(x?.runtime?.flags.has("--sandbox")).toBe(true);
    expect(x?.runtime?.features?.has("shell_tool")).toBe(true);
    expect(x?.runtime?.env.PATH).toBe(dir);
  });

  describe("pinned CLI", () => {
    const PIN_KEYS = ["CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "DISABLE_UPDATES", "CODEX_HOME"];
    const pinLoc = (agent: "claude" | "codex", pinned: boolean) => async (): Promise<CliLocation> => ({
      agent, found: true, path: join(dir, agent), searchPath: dir, version: agent === "claude" ? "2.1.288" : "0.159.2",
      source: pinned ? "pin" : "path", ...(pinned ? { pin: { version: "x", configDir: "/cfg" } } : {}),
    });
    it("claude pin: config dir and update switches in runtime.env, pinned true", async () => {
      fakeClaude();
      const r = await inspectProvider(claude, { env: env(), deps: { ...noModels, locate: pinLoc("claude", true) } });
      expect(r.runtime).toMatchObject({ pinned: true, env: { CLAUDE_CONFIG_DIR: "/cfg", DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1", PATH: dir } });
    });
    it("codex pin: CODEX_HOME", async () => {
      fakeCodex();
      const r = await inspectProvider(codex, { env: env(), deps: { ...noModels, locate: pinLoc("codex", true) } });
      expect(r.runtime).toMatchObject({ pinned: true, env: { CODEX_HOME: "/cfg" } });
      expect(r.runtime?.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    });
    it("pin variables reach the help read", async () => {
      fakeCodex();
      const seen: Array<Record<string, string | undefined>> = [];
      const readHelp = async (_p: string, _a: readonly string[], e: Record<string, string | undefined>) => { seen.push(e); return readFileSync(fixture("codex-0.159.2-exec-help.txt"), "utf8"); };
      await inspectProvider(codex, { env: env(), deps: { ...noModels, locate: pinLoc("codex", true), readHelp } });
      expect(seen[0]?.CODEX_HOME).toBe("/cfg");
    });
    it("PATH binary: no pin keys, pinned unset", async () => {
      fakeClaude();
      const r = await inspectProvider(claude, { env: env(), deps: { ...noModels, locate: pinLoc("claude", false) } });
      for (const k of PIN_KEYS) expect(r.runtime?.env[k]).toBeUndefined();
      expect(r.runtime?.pinned).toBeUndefined();
    });
  });

  it("CLI removed", async () => {
    const r = await inspectProvider(claude, { env: env() });
    expect(r.status.available).toBe(false);
    expect(r.status.reason).toContain("не найдена");
    expect(r.runtime).toBeUndefined();
  });

  it("command not found: status shows search path", async () => {
    const locate = async (agent: "claude" | "codex"): Promise<CliLocation> => ({ agent, found: false, searchPath: "/usr/bin:/bin" });
    const r = await inspectProvider(claude, { env: env(), deps: { locate } });
    expect(r.status.searchPath).toBe("/usr/bin:/bin");
  });

  it("explicit path does not exist", async () => {
    const r = await inspectProvider({ ...claude, path: "/nope/claude" }, { env: env() });
    expect(r.status.available).toBe(false);
    expect(r.status.reason).toContain("/nope/claude");
  });

  it("isolation flag missing", async () => {
    const help = join(dir, "help.txt");
    writeFileSync(help, readFileSync(fixture("claude-2.1.288-help.txt"), "utf8").split("\n").filter((l) => !l.includes("--tools")).join("\n"));
    fakeClaude({ helpFile: help });
    const r = await inspectProvider(claude, { env: env(), deps: noModels });
    expect(r.status.available).toBe(false);
    expect(r.status.reason).toContain("--tools");
    expect(r.status.reason).toContain("2.1.288");
    expect(r.runtime).toBeUndefined();
  });

  it("version newer than verified", async () => {
    fakeClaude({ version: "2.1.999 (Claude Code)" });
    const r = await inspectProvider(claude, { env: env(), deps: noModels });
    expect(r.status.available).toBe(true);
    expect(r.status.warning).toContain("2.1.288–2.1.288");
  });

  it("interface-only version stays available and exposes verified; HTTP provider has none", async () => {
    fakeCodex();
    const r = await inspectProvider(codex, { env: env(), deps: noModels });
    expect(r.status.available).toBe(true);
    expect(r.status.verified).toEqual({ level: "interface", checkedAt: "2026-10-16" });
    expect(r.status.warning).toContain("реальная приёмка отсутствует");
    const h = await inspectProvider({ id: "h", kind: "openai-http", label: "H", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "", models: ["m"] }, { env: env(), deps: noModels });
    expect(h.status.verified).toBeUndefined();
  });

  it("help not readable", async () => {
    fakeClaude({ helpFails: true });
    const r = await inspectProvider(claude, { env: env(), deps: noModels });
    expect(r.status).toMatchObject({ available: false, version: "2.1.288" });
    expect(r.status.reason).toContain("справку");
  });

  it("codex: readFeatures throws — unavailable, reason, no runtime", async () => {
    fakeCodex();
    const r = await inspectProvider(codex, { env: env(), deps: { ...noModels, readFeatures: async () => { throw new Error("boom"); } } });
    expect(r.status).toMatchObject({ available: false, version: "0.159.2" });
    expect(r.status.reason).toContain("codex features list");
    expect(r.runtime).toBeUndefined();
  });

  it("codex: no shell_tool in list — unavailable, reason names it", async () => {
    fakeCodex();
    const list = readFileSync(fixture("codex-0.159.2-features.txt"), "utf8").split("\n").filter((l) => !l.startsWith("shell_tool ")).join("\n");
    const r = await inspectProvider(codex, { env: env(), deps: { ...noModels, readFeatures: async () => list } });
    expect(r.status).toMatchObject({ available: false, version: "0.159.2" });
    expect(r.status.reason).toContain("shell_tool");
    expect(r.runtime).toBeUndefined();
  });
});

describe("models", () => {
  it("list from listModels, owner's edit, withModels:false", async () => {
    fakeClaude();
    const list = vi.fn(async () => ({ models: ["opus", "haiku"], confirmed: true }));
    let r = await inspectProvider(claude, { env: env(), deps: { listModels: list } });
    expect(r.status).toMatchObject({ models: ["opus", "haiku"], modelsConfirmed: true });

    r = await inspectProvider(claude, { env: env(), deps: { listModels: async () => ({ models: [], confirmed: false, reason: "нет данных" }) } });
    expect(r.status).toMatchObject({ models: [], modelsConfirmed: false, modelsReason: "нет данных" });

    list.mockClear();
    r = await inspectProvider({ ...claude, models: ["my-model"] }, { env: env(), deps: { listModels: list } });
    expect(r.status).toMatchObject({ models: ["my-model"], modelsConfirmed: false });
    expect(r.status.modelsReason).toContain("владельцем");

    list.mockClear();
    r = await inspectProvider(claude, { env: env(), withModels: false, deps: { listModels: list } });
    expect(list).not.toHaveBeenCalled();
    expect(r.status.modelsReason).toBeUndefined();
  });
});

describe("order", () => {
  const http: Provider = { id: "gw", kind: "openai-http", label: "GW", models: ["m"], baseUrl: "http://localhost:1", apiKeyEnv: "KEY" };
  it("registry order is kept", async () => {
    fakeClaude();
    const r = await inspectProviders({ providers: [http, claude, codex], defaults: {} as Registry["defaults"] }, { env: env(), deps: noModels });
    expect(r.map((i) => i.status.id)).toEqual(["gw", "claude", "codex"]);
  });
});

describe("inspectProvider openai-http", () => {
  const servers: FakeServer[] = [];
  const serve = async (apiKey?: string) => { const s = await startFakeServer(apiKey ? { apiKey } : {}); servers.push(s); return s; };
  afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
  const prov = (s: { url: string }, extra: Partial<HttpProvider> = {}): HttpProvider => ({ id: "gw", kind: "openai-http", label: "GW", models: [], baseUrl: `${s.url}/`, ...extra });
  const KEY_FILE = "/data/.env";

  for (const extra of [{}, { apiKeyEnv: "" }]) {
    it(`no key ${JSON.stringify(extra)}`, async () => {
      const s = await serve();
      const r = await inspectProvider(prov(s, extra), { env: {} });
      expect(r.status).toMatchObject({ available: true, models: [...FAKE_MODELS], modelsConfirmed: true, baseUrl: s.url });
      expect(r.status).not.toHaveProperty("keyEnv");
      expect(r.status).not.toHaveProperty("keySet");
      expect(r.http?.baseUrl).toBe(s.url);
      expect(s.requests[0]?.authorization).toBeUndefined();
    });
  }

  it("key set: in http, but not in status", async () => {
    const s = await serve("sk-secret-value");
    const r = await inspectProvider(prov(s, { apiKeyEnv: "TEST_KEY" }), { env: { TEST_KEY: "sk-secret-value" } });
    expect(r.status).toMatchObject({ available: true, keyEnv: "TEST_KEY", keySet: true });
    expect(r.http?.apiKey).toBe("sk-secret-value");
    expect(JSON.stringify(r.status)).not.toContain("sk-secret-value");
  });

  for (const value of [undefined, ""]) {
    it(`no key (${JSON.stringify(value)}): unavailable, no requests`, async () => {
      const s = await serve();
      const r = await inspectProvider(prov(s, { apiKeyEnv: "TEST_KEY" }), { env: { TEST_KEY: value }, keyFile: KEY_FILE });
      expect(r.status).toMatchObject({ available: false, keySet: false });
      expect(r.status.reason).toContain("TEST_KEY");
      expect(r.status.reason).toContain(KEY_FILE);
      expect(r.http).toBeUndefined();
      expect(s.requests).toHaveLength(0);
    });
  }

  it("withModels:false does not touch the network", async () => {
    const s = await serve();
    const r = await inspectProvider(prov(s), { env: {}, withModels: false });
    expect(r.status.available).toBe(true);
    expect(r.http).toBeDefined();
    expect(s.requests).toHaveLength(0);
  });

  it("owner's list remains, no request", async () => {
    const s = await serve();
    const r = await inspectProvider(prov(s, { models: ["mine"] }), { env: {} });
    expect(r.status).toMatchObject({ available: true, models: ["mine"], modelsConfirmed: false });
    expect(r.status.modelsReason).toContain("владельцем");
    expect(s.requests).toHaveLength(0);
  });

  it("server closed", async () => {
    const s = await startFakeServer();
    await s.close();
    const r = await inspectProvider(prov(s), { env: {} });
    expect(r.status.available).toBe(false);
    expect(r.status.reason?.startsWith("Эндпоинт недоступен: ")).toBe(true);
    expect(r.http).toBeUndefined();
  });

  it("invalid key", async () => {
    const s = await serve("sk-good");
    const r = await inspectProvider(prov(s, { apiKeyEnv: "TEST_KEY" }), { env: { TEST_KEY: "sk-bad" } });
    expect(r.status.available).toBe(false);
    expect(r.status.reason).toContain("Отказ авторизации");
    expect(JSON.stringify(r.status)).not.toContain("sk-bad");
  });

  it("404 on list: provider available", async () => {
    const reason = "Эндпоинт не отдал перечень моделей: HTTP 404";
    const r = await inspectProvider(prov({ url: "http://x" }), { env: {}, deps: { listHttpModels: async () => ({ models: [], confirmed: false, reason }) } });
    expect(r.status).toMatchObject({ available: true, modelsConfirmed: false, modelsReason: reason });
    expect(r.http).toBeDefined();
  });

  it("listHttpModels throws", async () => {
    const r = await inspectProvider(prov({ url: "http://x" }), { env: {}, deps: { listHttpModels: async () => { throw new Error("boom"); } } });
    expect(r.status).toMatchObject({ available: false, reason: "Осмотр gw завершился ошибкой: boom" });
  });
});

describe("ensureRegistry", () => {
  const loc = (found: string[]) => vi.fn(async (agent: "claude" | "codex"): Promise<CliLocation> => ({ agent, found: found.includes(agent), searchPath: "" }));
  const read = () => JSON.parse(readFileSync(configPath(dir), "utf8")) as Registry;

  it("creates from found CLIs", async () => {
    expect(await ensureRegistry(dir, { env: {}, deps: { locate: loc(["claude", "codex"]) } })).toBe("created");
    let r = read();
    expect(r.providers.map((p) => p.id)).toEqual(["claude", "codex"]);
    expect(r.defaults.participants).toHaveLength(2);

    rmSync(configPath(dir));
    await ensureRegistry(dir, { env: {}, deps: { locate: loc(["codex"]) } });
    r = read();
    expect(r.providers.map((p) => p.id)).toEqual(["codex"]);
    expect(r.defaults.participants).toHaveLength(1);

    rmSync(configPath(dir));
    await ensureRegistry(dir, { env: {}, deps: { locate: loc([]) } });
    expect(read().providers).toEqual([]);
  });

  it("existing file is not touched and CLIs are not searched", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath(dir), "мусор");
    const locate = loc(["claude"]);
    expect(await ensureRegistry(dir, { env: {}, deps: { locate } })).toBe("exists");
    expect(readFileSync(configPath(dir), "utf8")).toBe("мусор");
    expect(locate).not.toHaveBeenCalled();
  });
});

// The attack runs only in a child with a finite watchdog: a vitest timeout cannot interrupt synchronous regex work.
describe("Bounded provider base URL normalization", () => {
  it("child probe: 1,048,576 slashes before 'x' have median <= 1,000 ms and finish before the 5,000 ms watchdog", async () => {
    const probe = fileURLToPath(new URL("../../scenarios/security-provider-url/probe.ts", import.meta.url));
    const providers = fileURLToPath(new URL("./providers.ts", import.meta.url));
    const pending = promisify(execFile)(process.execPath, [probe, providers, String(1 << 20)], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    pending.child.stdin?.end();
    const result = JSON.parse((await pending).stdout) as { n: number; samples: number[]; median: number };
    expect(result.n).toBe(1_048_576);
    expect(result.samples).toHaveLength(3);
    expect(result.median).toBeLessThanOrEqual(1_000);
  }, 15_000);
});
