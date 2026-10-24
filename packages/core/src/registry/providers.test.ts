import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliLocation } from "../cli-agents/discovery.ts";
import { FAKE_MODELS, startFakeServer } from "../http/fake-server.ts";
import type { FakeServer } from "../http/fake-server.ts";
import { linkExecutable, writeExecutable } from "../executable.testutil.ts";
import { configPath, initialRegistry, readRegistry } from "./config.ts";
import { setProcessLanguage } from "../i18n/index.ts";
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
  return linkExecutable(p, `#!/bin/sh\n${body}\n`);
}
// The script is constant (one shared inode); per-test values live in plain data files next to it.
function fakeClaude(o: { version?: string; helpFile?: string; helpFails?: boolean } = {}) {
  const p = stub("claude", `case "$1" in --version) /bin/cat "$0.version";; --help) if [ -e "$0.helpfail" ]; then exit 1; fi; /bin/cat "$(/bin/cat "$0.help")";; esac`);
  writeFileSync(`${p}.version`, `${o.version ?? "2.1.288 (Claude Code)"}\n`);
  writeFileSync(`${p}.help`, o.helpFile ?? fixture("claude-2.1.288-help.txt"));
  rmSync(`${p}.helpfail`, { force: true });
  if (o.helpFails) writeFileSync(`${p}.helpfail`, "");
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
    it("status.source carries the location source for explicit / pin / path", async () => {
      fakeClaude();
      for (const source of ["explicit", "pin", "path"] as const) {
        const locate = async (): Promise<CliLocation> => ({ agent: "claude", found: true, path: join(dir, "claude"), searchPath: dir, version: "2.1.288", source, ...(source === "pin" ? { pin: { version: "x", configDir: "/cfg" } } : {}) });
        const r = await inspectProvider(claude, { env: env(), deps: { ...noModels, locate } });
        expect(r.status.source).toBe(source);
      }
    });
    it("status.source stays unset when the location has no source", async () => {
      fakeClaude();
      const locate = async (): Promise<CliLocation> => ({ agent: "claude", found: true, path: join(dir, "claude"), searchPath: dir, version: "2.1.288" });
      expect((await inspectProvider(claude, { env: env(), deps: { ...noModels, locate } })).status.source).toBeUndefined();
    });
    it("unavailable CLI status keeps source pin when the pinned install failed the pre-launch check", async () => {
      const reason = "Pinned install claude 2.1.288 changed after install";
      const locate = async (): Promise<CliLocation> => ({ agent: "claude", found: false, source: "pin", searchPath: dir, reason });
      const r = await inspectProvider(claude, { env: env(), deps: { ...noModels, locate } });
      expect(r.status).toMatchObject({ source: "pin", available: false, reason });
      expect(r.runtime).toBeUndefined();
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
    r = await inspectProvider(claude, { env: env(), withModels: false, deps: { listModels: list } });
    expect(list).not.toHaveBeenCalled();
    expect(r.status.modelsReason).toBeUndefined();
  });
});

describe("Ручная модель не отключает обновление", () => {
  const cliDeps = (listModels: NonNullable<Parameters<typeof inspectProvider>[1]["deps"]>["listModels"]) => ({ listModels });
  const httpP = (models: string[]): HttpProvider => ({ id: "gw", kind: "openai-http", label: "GW", models, baseUrl: "http://127.0.0.1:1/v1" });

  it("CLI: list is requested with owner models, merged without duplicates", async () => {
    fakeClaude();
    const list = vi.fn(async () => ({ models: ["a", "b"], confirmed: true }));
    const r = await inspectProvider({ ...claude, models: ["b", "mine"] }, { env: env(), deps: cliDeps(list) });
    expect(list).toHaveBeenCalledOnce();
    expect(r.status).toMatchObject({ models: ["a", "b", "mine"], modelsConfirmed: true });
  });

  it("CLI: unconfirmed list keeps its reason and owner models", async () => {
    fakeClaude();
    const r = await inspectProvider({ ...claude, models: ["mine"] }, { env: env(), deps: cliDeps(async () => ({ models: [], confirmed: false, reason: "нет данных" })) });
    expect(r.status).toMatchObject({ models: ["mine"], modelsConfirmed: false, modelsReason: "нет данных" });
  });

  it("HTTP: list is requested with owner models, merged without duplicates", async () => {
    const listHttpModels = vi.fn(async () => ({ models: ["a", "b"], confirmed: true }));
    const r = await inspectProvider(httpP(["b", "mine"]), { env: {}, deps: { listHttpModels } });
    expect(listHttpModels).toHaveBeenCalledOnce();
    expect(r.status).toMatchObject({ available: true, models: ["a", "b", "mine"], modelsConfirmed: true });
    expect(r.http).toBeDefined();
  });

  it("HTTP: no list from the endpoint — stays available with owner models and the reason", async () => {
    const r = await inspectProvider(httpP(["mine"]), { env: {}, deps: { listHttpModels: async () => ({ models: [], confirmed: false, unavailable: true, reason: "нет списка" }) } });
    expect(r.status).toMatchObject({ available: true, models: ["mine"], modelsConfirmed: false, modelsReason: "нет списка" });
    expect(r.http).toBeDefined();
  });

  it("HTTP: no list and no owner models — unavailable as before", async () => {
    const r = await inspectProvider(httpP([]), { env: {}, deps: { listHttpModels: async () => ({ models: [], confirmed: false, unavailable: true, reason: "нет списка" }) } });
    expect(r.status).toMatchObject({ available: false, reason: "нет списка" });
    expect(r.http).toBeUndefined();
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

  it("Ручная модель не отключает обновление: HTTP merges the endpoint list with the owner's models", async () => {
    const s = await serve();
    const r = await inspectProvider(prov(s, { models: [FAKE_MODELS[0]!, "mine"] }), { env: {} });
    expect(s.requests.length).toBeGreaterThan(0);
    expect(r.status).toMatchObject({ available: true, models: [...FAKE_MODELS, "mine"], modelsConfirmed: true });
    expect(r.status.modelsReason).toBeUndefined();
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

describe("Сведения о доступности провайдера: Логин и пароль в адресе", () => {
  afterEach(() => setProcessLanguage("ru"));
  const http = (id: string, baseUrl: string): HttpProvider => ({ id, kind: "openai-http", label: id, models: ["m"], baseUrl });
  const counted = () => { const calls: unknown[] = []; return { calls, deps: { listHttpModels: async (h: unknown) => { calls.push(h); return { models: ["m"], confirmed: true }; } } }; };

  for (const [lang, word] of [["ru", "логин или пароль"], ["en", "login or password"]] as const) {
    for (const [what, url] of [["login and password", "http://user:SECRETPASS@127.0.0.1:9/v1"], ["login only", "http://user@127.0.0.1:9/v1"]] as const) {
      it(`${lang}: ${what} in baseUrl is unavailable, the address is not echoed, no request`, async () => {
        setProcessLanguage(lang);
        const { calls, deps } = counted();
        const r = await inspectProvider(http("gw", url), { env: {}, deps });
        expect(r.status.available).toBe(false);
        expect(r.status.reason).toContain("gw");
        expect(r.status.reason).toContain("baseUrl");
        expect(r.status.reason).toContain(word);
        expect(r.status).not.toHaveProperty("baseUrl");
        const text = JSON.stringify(r);
        for (const leak of ["SECRETPASS", "user", "127.0.0.1"]) expect(text).not.toContain(leak);
        expect(r.http).toBeUndefined();
        expect(calls).toHaveLength(0);
      });
    }
  }

  it("a neighbour without userinfo (with a query) stays available; readRegistry keeps both", async () => {
    const bad = http("bad", "http://user:SECRETPASS@127.0.0.1:9/v1");
    const good = http("good", "http://127.0.0.1:9/v1?api-version=1");
    writeFileSync(configPath(dir), JSON.stringify({ ...initialRegistry([]), providers: [bad, good] }));
    const reg = readRegistry(dir);
    expect(reg.providers.map((p) => p.id)).toEqual(["bad", "good"]);
    const { calls, deps } = counted();
    const [b, g] = await inspectProviders(reg, { env: {}, deps });
    expect(b?.status.available).toBe(false);
    expect(g?.status).toMatchObject({ available: true, baseUrl: "http://127.0.0.1:9/v1?api-version=1" });
    expect(g?.http).toBeDefined();
    expect(calls).toHaveLength(1);
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

describe("first registry with a failed pin", () => {
  it("first registry: a pin that failed its check is kept, an unfound CLI without a pin is not", async () => {
    const locate = vi.fn(async (agent: "claude" | "codex"): Promise<CliLocation> => agent === "claude"
      ? { agent, found: false, source: "pin", searchPath: "", reason: "pin check failed" }
      : { agent, found: false, searchPath: "", reason: "not found" });
    expect(await ensureRegistry(dir, { env: {}, deps: { locate } })).toBe("created");
    const r = JSON.parse(readFileSync(configPath(dir), "utf8")) as Registry;
    expect(r.providers.map((p) => p.id)).toEqual(["claude"]);
  });
  it("first registry: claude without a pin and not found is not added", async () => {
    const locate = vi.fn(async (agent: "claude" | "codex"): Promise<CliLocation> => ({ agent, found: false, searchPath: "", reason: "not found" }));
    expect(await ensureRegistry(dir, { env: {}, deps: { locate } })).toBe("created");
    expect((JSON.parse(readFileSync(configPath(dir), "utf8")) as Registry).providers).toEqual([]);
  });
});

describe("pinned codex inspection args", () => {
  const UPDATE_OFF = ["-c", "check_for_update_on_startup=false"];
  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  it("pinned codex help and features list get -c check_for_update_on_startup=false; other sources and claude are unchanged", async () => {
    const cases = (["claude", "codex"] as const).flatMap((agent) => (["explicit", "pin", "path"] as const).flatMap((source) => [true, false].map((found) => ({ agent, source, found }))));
    const rand = mulberry32(204);
    cases.sort(() => rand() - 0.5);
    for (const { agent, source, found } of cases) {
      const helpArgs: string[][] = [];
      const featureArgs: string[][] = [];
      const locate = async (): Promise<CliLocation> => ({
        agent, found, searchPath: dir, source, ...(found ? { path: join(dir, agent), version: "1.0.0" } : {}),
        ...(source === "pin" ? { pin: { version: "x", configDir: "/cfg" } } : {}),
      });
      await inspectProvider(agent === "claude" ? claude : codex, {
        env: env(),
        deps: { locate, listModels: noModels.listModels, readHelp: async (_p, a) => { helpArgs.push([...a]); return ""; }, readFeatures: async (_p, a) => { featureArgs.push([...a]); return ""; } },
      });
      const label = `${agent}/${source}/found=${found}`;
      if (!found) { expect(helpArgs, label).toEqual([]); expect(featureArgs, label).toEqual([]); continue; }
      if (agent === "claude") { expect(helpArgs, label).toEqual([["--help"]]); expect(featureArgs, label).toEqual([]); continue; }
      const extra = source === "pin" ? UPDATE_OFF : [];
      expect(helpArgs, label).toEqual([["exec", "--help", ...extra]]);
      expect(featureArgs, label).toEqual([["features", "list", ...extra]]);
    }
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

describe("CLI participants: keys from .env files stay out of the CLI environment", () => {
  const rand = () => Math.random().toString(36).slice(2, 10).toUpperCase();
  const keyA = `OSEN_T238_A_${rand()}`;
  const keyB = `OSEN_T238_B_${rand()}`;
  const fromShell = `OSEN_T238_SHELL_${rand()}`;
  type E = Record<string, string | undefined>;

  it("help, features, locate, models, runtime.env and the turn environment lack the file keys; HTTP still sees its key", async () => {
    const dataDir = join(dir, "data");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, ".env"), `${keyA}=secret-a\n${keyB}=secret-b\n`);
    const merged = { ...env(), [keyA]: "secret-a", [keyB]: "secret-b", [fromShell]: "1" };
    const seen: Record<string, E> = {};
    const exe = stub("claude-env", '/usr/bin/env');
    const deps = {
      locate: async (_a: string, o: { env: E }): Promise<CliLocation> => { seen.locate = o.env; return { agent: "codex", found: true, path: exe, searchPath: dir, version: "0.159.2" }; },
      readHelp: async (_p: string, _a: readonly string[], e: E) => { seen.help = e; return readFileSync(fixture("codex-0.159.2-exec-help.txt"), "utf8"); },
      readFeatures: async (_p: string, _a: readonly string[], e: E) => { seen.features = e; return readFileSync(fixture("codex-0.159.2-features.txt"), "utf8"); },
      listModels: async (_a: string, o: { env: E }) => { seen.models = o.env; return { models: [], confirmed: false }; },
    };
    const r = await inspectProvider(codex, { env: merged, dataDir, deps });
    for (const e of [seen.locate, seen.help, seen.features, seen.models, r.runtime?.env]) {
      expect(e).toBeDefined();
      expect(e).not.toHaveProperty(keyA);
      expect(e).not.toHaveProperty(keyB);
      expect(e?.[fromShell]).toBe("1");
      expect(e?.PATH).toBeDefined();
    }
    // the turn environment as the CLI driver builds it
    const { stdout } = await promisify(execFile)(exe, [], { env: { ...r.runtime!.env, COUNCIL_PARTICIPANT: "1" } as NodeJS.ProcessEnv });
    expect(stdout).not.toContain(keyA);
    expect(stdout).not.toContain("secret-a");
    expect(stdout).toContain("COUNCIL_PARTICIPANT=1");
    expect(stdout).toContain(`${fromShell}=1`);

    const http = await inspectProvider({ id: "h", kind: "openai-http", label: "H", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: keyA, models: ["m"] }, { env: merged, dataDir, withModels: false });
    expect(http.http?.apiKey).toBe("secret-a");
  });
});

describe("Таймаут и прерывание: Чтение справки вне хода с потомком, игнорирующим SIGTERM", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  it("a hung help read times out, the reason is named and the SIGTERM-ignoring descendant is gone after the stop grace", async () => {
    // the descendant holds no pipes: the old execFile read returned on the leader's exit and left it alive
    const pidfile = join(dir, "descendant.pid");
    writeExecutable(join(dir, "claude"), `#!/bin/sh\ncase "$1" in --version) echo '2.1.288 (Claude Code)';; --help) /bin/sh -c 'trap "" TERM; echo $$ > "$1"; exec /bin/sleep 30' sh '${pidfile}' >/dev/null 2>&1 </dev/null & while [ ! -s '${pidfile}' ]; do /bin/sleep 0.05; done; exec /bin/sleep 30;; esac\n`);
    const r = await inspectProvider(claude, { env: env(), deps: noModels });
    const pid = Number(readFileSync(pidfile, "utf8").trim());
    try {
      expect(alive(pid)).toBe(true);
      expect(r.status.available).toBe(false);
      expect(r.status.reason).toMatch(/^(Could not read the help of claude|Не удалось прочитать справку claude): .*no answer within 10000 ms/);
      await new Promise((res) => setTimeout(res, 3000));
      expect(alive(pid)).toBe(false);
    } finally { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }, 60_000);
});
