import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL, configPath, envFilePath, initialRegistry, readRegistry, writeRegistry } from "@model-council/core";
import type { Logger, ProviderInspection, ProviderStatus, Registry } from "@model-council/core";
import { setProcessLanguage } from "@model-council/core/i18n";
import { settings as catalog } from "../shared/messages/settings.ts";
import { inertTransition } from "./cli-transition.testutil.ts";
import { createSettings, SettingsError } from "./settings.ts";

const logs: string[] = [];
const logger: Logger = { info: (m) => { logs.push(m); }, error: () => {} };
const NOW = new Date("2026-01-02T03:04:05.000Z");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-settings-")); logs.length = 0; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const http = (id: string, extra: object = {}) => ({ id, kind: "openai-http" as const, label: id, models: [], baseUrl: `https://${id}.example/v1`, ...extra });
function seed(patch: (r: Registry) => Registry = (r) => r): Registry {
  const base = initialRegistry(["claude"]);
  return writeRegistry(dir, patch({ ...base, providers: [...base.providers, http("api", { apiKeyEnv: "API_KEY" })] }));
}
const raw = () => readFileSync(configPath(dir), "utf8");

type Fn = (id: string) => ProviderStatus;
function make(statusOf: Fn = (id) => ({ id, kind: "cli", label: id, available: true, models: [], modelsConfirmed: false }), extra: Partial<Parameters<typeof createSettings>[0]> = {}) {
  const inspect = vi.fn(async (p: { id: string }): Promise<ProviderInspection> => ({ status: statusOf(p.id) }));
  const reloadEnv = vi.fn();
  const resetDiscovery = vi.fn();
  const api = createSettings({ dataDir: dir, env: {}, reloadEnv, logger, now: () => NOW, inspect: inspect as never, resetDiscovery, transition: inertTransition(dir, logger), ...extra });
  return { api, inspect, reloadEnv, resetDiscovery };
}
const st = (over: Partial<ProviderStatus>): Fn => (id) => ({ id, kind: "openai-http", label: id, available: true, models: [], modelsConfirmed: false, ...over });

describe("view", () => {
  it("cli is null for http providers, transition is always present, view and recheck never start a candidate check", async () => {
    seed();
    const maybeCheck = vi.fn(async () => {});
    const transition = { ...inertTransition(dir, logger), maybeCheck };
    const { api } = make(undefined, { transition });
    const v = await api.view();
    await api.recheck();
    expect(v.providers.find((p) => p.id === "api")!.cli).toBeNull();
    expect(v.providers.find((p) => p.id === "claude")!.cli).not.toBeNull();
    expect(v.transition).toMatchObject({ periodDays: 30, fileError: null, running: false });
    expect(maybeCheck).not.toHaveBeenCalled();
  });

  it("cli and http provider fields", async () => {
    seed();
    const { api } = make((id) => id === "api"
      ? { id, kind: "openai-http", label: id, available: true, models: ["m1"], modelsConfirmed: true, baseUrl: "https://api.example/v1", keyEnv: "API_KEY", keySet: true }
      : { id, kind: "cli", label: "Claude Code", available: true, models: [DEFAULT_MODEL, "opus"], modelsConfirmed: true, path: "/bin/claude", version: "1.2.3", warning: "новая версия" });
    const v = await api.view();
    expect(v).toMatchObject({ configPath: configPath(dir), envPath: envFilePath(dir), registryError: null });
    expect(v.providers[0]).toEqual({
      id: "claude", kind: "cli", label: "Claude Code", available: true, reason: null, warning: "новая версия", version: "1.2.3", path: "/bin/claude",
      baseUrl: null, keyEnv: null, keySet: false, billing: "subscription", models: ["opus"], defaultModel: DEFAULT_MODEL,
      modelsSource: "provider", modelsReason: null, modelsAt: NOW.toISOString(), cli: expect.objectContaining({ agent: "claude", source: null, level: "none", pin: null }),
    });
    expect(v.providers[1]).toMatchObject({ id: "api", billing: "paid", baseUrl: "https://api.example/v1", keyEnv: "API_KEY", keySet: true, defaultModel: null, models: ["m1"] });
    expect(Object.keys(v.defaults!)).toEqual(["maxRounds", "turnTimeoutSec", "contextChars", "materialsChars", "maxTotalTokens", "maxParticipants", "participants"]);
  });

  it("http without a key: free, billing free", async () => {
    seed((r) => ({ ...r, providers: [...r.providers, http("free")] }));
    const v = await make(st({})).api.view();
    expect(v.providers.find((p) => p.id === "free")!.billing).toBe("free");
  });

  it("four modelsSource values", async () => {
    seed((r) => ({ ...r, providers: [...r.providers.map((p) => (p.id === "api" ? { ...p, models: ["own"] } : p)), http("b"), http("c"), http("d")] }));
    const status: Record<string, Partial<ProviderStatus>> = {
      claude: { kind: "cli", models: [], modelsConfirmed: false, reason: "нет", available: false },
      api: { models: ["own"], modelsConfirmed: false, modelsReason: "задан" },
      b: { models: ["x", DEFAULT_MODEL], modelsConfirmed: true },
      c: { models: ["y"], modelsConfirmed: false, modelsReason: "не подтверждён" },
      d: { models: [], modelsConfirmed: false, modelsReason: "пусто" },
    };
    const v = await make((id) => ({ id, kind: "openai-http", label: id, available: true, models: [], modelsConfirmed: false, ...status[id] })).api.view();
    const by = Object.fromEntries(v.providers.map((p) => [p.id, p]));
    expect(by["api"]).toMatchObject({ modelsSource: "owner", modelsReason: null, modelsAt: null, models: ["own"] });
    expect(by["b"]).toMatchObject({ modelsSource: "provider", modelsReason: null, modelsAt: NOW.toISOString(), models: ["x"] });
    expect(by["c"]).toMatchObject({ modelsSource: "unconfirmed", modelsReason: "не подтверждён", modelsAt: null });
    expect(by["d"]).toMatchObject({ modelsSource: "unavailable", modelsReason: "пусто", modelsAt: null });
    expect(by["claude"]).toMatchObject({ modelsSource: "unavailable", modelsReason: null, reason: "нет" }); // the unavailability reason is already shown in the card
  });

  it("key not set: keySet false, the reason and \"unavailable without a key\"", async () => {
    seed();
    const v = await make((id) => id === "api"
      ? { id, kind: "openai-http", label: id, available: false, reason: "Ключ не задан", models: [], modelsConfirmed: false, keyEnv: "API_KEY", keySet: false }
      : { id, kind: "cli", label: id, available: true, models: [], modelsConfirmed: false }).api.view();
    expect(v.providers[1]).toMatchObject({ available: false, reason: "Ключ не задан", keySet: false, modelsSource: "unavailable", modelsReason: "перечень моделей недоступен без ключа" });
  });

  it("unavailable without a reason — the default text", async () => {
    seed();
    const v = await make((id) => ({ id, kind: "cli", label: id, available: false, models: [], modelsConfirmed: false })).api.view();
    expect(v.providers[0]!.reason).toBe("Провайдер недоступен");
  });

  it("corrupted config.json: registryError, the file untouched", async () => {
    writeFileSync(configPath(dir), "{не json");
    const { api, inspect } = make();
    const v = await api.view();
    expect(v).toEqual({ configPath: configPath(dir), envPath: envFilePath(dir), registryError: expect.stringContaining("не JSON"), providers: [], defaults: null, transition: expect.objectContaining({ periodDays: 30, fileError: null }) });
    expect(raw()).toBe("{не json");
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe("recheck", () => {
  it("rereads the environment and resets the cache", async () => {
    seed();
    const { api, reloadEnv, resetDiscovery } = make();
    expect((await api.recheck()).providers).toHaveLength(2);
    expect(reloadEnv).toHaveBeenCalledOnce();
    expect(resetDiscovery).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("Environment re-check");
  });
});

describe("saveProvider", () => {
  const input = { id: null, label: " Новый ", baseUrl: " https://Api.Example.com/v1 ", apiKeyEnv: " NEW_KEY " };

  it("add: id from the host, values trimmed; a taken id gets -2, -3", async () => {
    seed();
    const { api } = make();
    await api.saveProvider(input);
    await api.saveProvider(input);
    await api.saveProvider({ ...input, baseUrl: "http://localhost:8080" });
    const ps = readRegistry(dir).providers;
    expect(ps.map((p) => p.id)).toEqual(["claude", "api", "api-example-com", "api-example-com-2", "localhost"]);
    expect(ps[2]).toEqual({ id: "api-example-com", kind: "openai-http", label: "Новый", models: [], baseUrl: "https://Api.Example.com/v1", apiKeyEnv: "NEW_KEY" });
    expect(logs.join("\n")).toContain("Provider saved: api-example-com");
  });

  it("change: label, address, key; models are kept; an empty name removes apiKeyEnv", async () => {
    seed((r) => ({ ...r, providers: r.providers.map((p) => (p.id === "api" ? { ...p, models: ["m"] } : p)) }));
    const { api } = make();
    await api.saveProvider({ id: "api", label: "Другой", baseUrl: "https://other.example/v1", apiKeyEnv: "" });
    const p = readRegistry(dir).providers[1]!;
    expect(p).toEqual({ id: "api", kind: "openai-http", label: "Другой", models: ["m"], baseUrl: "https://other.example/v1" });
    expect("apiKeyEnv" in p).toBe(false);
  });

  it("invalid address: SettingsError, the file unchanged", async () => {
    seed();
    const before = raw();
    await expect(make().api.saveProvider({ ...input, baseUrl: "ftp://x" })).rejects.toThrow(SettingsError);
    await expect(make().api.saveProvider({ ...input, baseUrl: "ftp://x" })).rejects.toThrow("http://");
    expect(raw()).toBe(before);
  });

  it("a malformed shape is rejected", async () => {
    seed();
    await expect(make().api.saveProvider(null)).rejects.toThrow(/^Некорректный запрос/);
    await expect(make().api.saveProvider({ ...input, label: 5 })).rejects.toThrow(/^Некорректный запрос/);
    await expect(make().api.saveProvider({ ...input, id: 3 })).rejects.toThrow(/^Некорректный запрос/);
  });

  it("a cli provider cannot be changed, an unknown id — an error", async () => {
    seed();
    const before = raw();
    await expect(make().api.saveProvider({ ...input, id: "claude" })).rejects.toThrow(SettingsError);
    await expect(make().api.saveProvider({ ...input, id: "nope" })).rejects.toThrow("не найден");
    expect(raw()).toBe(before);
  });
});

describe("deleteProvider", () => {
  it("removed from providers and defaults.participants", async () => {
    seed((r) => ({ ...r, defaults: { ...r.defaults, participants: [{ providerId: "claude", model: "a" }, { providerId: "claude", model: "b" }, { providerId: "api", model: "m" }] } }));
    const v = await make().api.deleteProvider("api");
    expect(v.providers.map((p) => p.id)).toEqual(["claude"]);
    expect(v.defaults!.participants.every((p) => p.providerId === "claude")).toBe(true);
    expect(logs.join("\n")).toContain("Provider removed: api");
  });

  it("a cli provider and an unknown one are not deleted", async () => {
    seed();
    const before = raw();
    await expect(make().api.deleteProvider("claude")).rejects.toThrow("Удалить можно только HTTP-провайдера");
    await expect(make().api.deleteProvider("nope")).rejects.toThrow("«nope» не найден");
    await expect(make().api.deleteProvider(1)).rejects.toThrow(SettingsError);
    expect(raw()).toBe(before);
  });
});

describe("saveModels", () => {
  it("normalization and an empty array", async () => {
    seed();
    const { api } = make();
    await api.saveModels("api", [" a ", "", DEFAULT_MODEL, "b", "a", "  "]);
    expect(readRegistry(dir).providers[1]!.models).toEqual(["a", "b"]);
    expect(logs.join("\n")).toContain("Model list saved: api, models 2");
    await api.saveModels("claude", []);
    await api.saveModels("api", []);
    expect(readRegistry(dir).providers.every((p) => p.models.length === 0)).toBe(true);
  });

  it("bad input", async () => {
    seed();
    await expect(make().api.saveModels("api", "x")).rejects.toThrow(SettingsError);
    await expect(make().api.saveModels("api", [1])).rejects.toThrow(SettingsError);
    await expect(make().api.saveModels("nope", [])).rejects.toThrow("не найден");
  });
});

describe("refreshModels", () => {
  it("inspects only one provider, with models", async () => {
    seed();
    const { api, inspect } = make(st({ models: ["z"], modelsConfirmed: true }));
    const p = await api.refreshModels("api");
    expect(p).toMatchObject({ id: "api", models: ["z"], modelsSource: "provider" });
    expect(inspect).toHaveBeenCalledOnce();
    expect((inspect.mock.calls[0] as unknown[])[1]).toMatchObject({ withModels: true });
  });
});

describe("testProvider", () => {
  const found = (): ProviderInspection => ({ status: { id: "api", kind: "openai-http", label: "api", available: true, models: [], modelsConfirmed: false }, http: { baseUrl: "https://x", keyFile: "f" } });
  const withFound = (f: ProviderInspection, call: (r: unknown) => Promise<unknown>) => {
    const driver = vi.fn(() => ({ call: vi.fn(call) as never }));
    const inspect = vi.fn(async () => f);
    const api = createSettings({ dataDir: dir, env: {}, reloadEnv: () => {}, logger, transition: inertTransition(dir, logger), inspect: inspect as never, driver: driver as never });
    return { api, driver, inspect };
  };

  it("success: ms, exactly one call with the right parameters", async () => {
    seed();
    const call = vi.fn(async () => ({ text: "готов" }));
    const driver = vi.fn(() => ({ call: call as never }));
    const inspect = vi.fn(async () => found());
    const api = createSettings({ dataDir: dir, env: {}, reloadEnv: () => {}, logger, transition: inertTransition(dir, logger), inspect: inspect as never, driver: driver as never });
    const r = await api.testProvider("api", "m1");
    expect(r).toEqual({ ok: true, ms: expect.any(Number) });
    expect(Number.isInteger((r as { ms: number }).ms)).toBe(true);
    expect(call).toHaveBeenCalledOnce();
    const req = (call.mock.calls[0] as unknown as [{ participant: object; timeoutSec: number; signal: AbortSignal }])[0];
    expect(req.participant).toEqual({ id: "p1", name: "api", providerId: "api", model: "m1", role: null });
    expect(req.timeoutSec).toBe(readRegistry(dir).defaults.turnTimeoutSec);
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect((inspect.mock.calls[0] as unknown[])[1]).toMatchObject({ withModels: false });
    expect(logs.join("\n")).toMatch(/Test call api: success in \d+ ms/);
  });

  it("driver exception — ok:false, does not throw", async () => {
    seed();
    const { api } = withFound(found(), async () => { throw new Error("сеть упала"); });
    expect(await api.testProvider("api", "m")).toEqual({ ok: false, reason: "сеть упала" });
    expect(logs.join("\n")).toContain("refused: сеть упала");
  });

  it("unavailable provider: the driver is not called", async () => {
    seed();
    const { api, driver } = withFound({ status: { ...found().status, available: false, reason: "Ключ не задан" } }, async () => ({}));
    expect(await api.testProvider("api", "m")).toEqual({ ok: false, reason: "Ключ не задан" });
    expect(driver).not.toHaveBeenCalled();
  });

  it("bad input", async () => {
    seed();
    await expect(make().api.testProvider("api", " ")).rejects.toThrow(SettingsError);
    await expect(make().api.testProvider("api", 1)).rejects.toThrow(SettingsError);
    await expect(make().api.testProvider("nope", "m")).rejects.toThrow("не найден");
  });
});

describe("saveDefaults", () => {
  const good = { maxRounds: 4, turnTimeoutSec: 120, contextChars: 5000, materialsChars: 80000, maxTotalTokens: null, maxParticipants: 4, participants: [{ providerId: "claude", model: "a" }, { providerId: "api", model: "b" }] };

  it("write", async () => {
    seed();
    const v = await make().api.saveDefaults({ ...good, extra: 1 });
    expect(v.defaults).toEqual(good);
    const { maxTotalTokens: _n, ...onDisk } = good;
    expect(readRegistry(dir).defaults).toEqual({ ...onDisk, materialsIgnore: ["node_modules", "dist", "build"] });
    expect(logs).toContain("Defaults saved");
  });

  it("materials settings are saved on disk", async () => {
    seed((r) => ({ ...r, defaults: { ...r.defaults, materialsIgnore: ["vendor"], materialsChars: 123 } }));
    const before = JSON.parse(raw());
    await make().api.saveDefaults(good);
    expect(JSON.parse(raw()).defaults).toMatchObject({ materialsIgnore: ["vendor"], materialsChars: 80000 });
    expect(JSON.parse(raw()).providers).toEqual(before.providers);
  });

  it("the view after saving returns materialsChars", async () => {
    seed();
    expect((await make().api.saveDefaults(good)).defaults!.materialsChars).toBe(80000);
  });

  it("materialsChars out of bounds: refusal, the file unchanged", async () => {
    seed();
    const before = raw();
    for (const v of [0, 999, 1_000_001, 1000.5]) await expect(make().api.saveDefaults({ ...good, materialsChars: v })).rejects.toThrow("Целое число от 1000 до 1000000");
    await expect(make().api.saveDefaults({ ...good, materialsChars: "1" })).rejects.toThrow(/^Некорректный запрос/);
    expect(raw()).toBe(before);
  });

  it("an old config.json without the field is read as 60000", async () => {
    seed((r) => { const { materialsChars: _m, ...rest } = r.defaults; return { ...r, defaults: rest as typeof r.defaults }; });
    const o = JSON.parse(raw());
    delete o.defaults.materialsChars;
    writeFileSync(configPath(dir), JSON.stringify(o));
    expect((await make().api.view()).defaults!.materialsChars).toBe(60000);
  });

  describe("token ceiling", () => {
    it("Saving the ceiling", async () => {
      seed((r) => ({ ...r, defaults: { ...r.defaults, materialsIgnore: ["vendor"] } }));
      const before = JSON.parse(raw());
      const v = await make().api.saveDefaults({ ...good, maxTotalTokens: 50000 });
      expect(v.defaults!.maxTotalTokens).toBe(50000);
      const after = JSON.parse(raw());
      expect(after.defaults.maxTotalTokens).toBe(50000);
      expect(after.defaults.materialsIgnore).toEqual(["vendor"]);
      expect(after.providers).toEqual(before.providers);
    });

    it("Clearing the ceiling", async () => {
      seed();
      await make().api.saveDefaults({ ...good, maxTotalTokens: 50000 });
      const v = await make().api.saveDefaults(good);
      expect(JSON.parse(raw()).defaults).not.toHaveProperty("maxTotalTokens");
      expect(v.defaults!.maxTotalTokens).toBeNull();
    });

    it("Invalid value", async () => {
      seed();
      const before = raw();
      for (const v of [0, -5, 1.5, 2 ** 60]) await expect(make().api.saveDefaults({ ...good, maxTotalTokens: v })).rejects.toThrow("Нужно целое число от 1");
      expect(raw()).toBe(before);
    });

    it("Previous registry", async () => {
      seed();
      expect(JSON.parse(raw()).defaults).not.toHaveProperty("maxTotalTokens");
      expect((await make().api.view()).defaults!.maxTotalTokens).toBeNull();
      await make().api.saveDefaults({ ...good, maxRounds: 7 });
      expect(JSON.parse(raw()).defaults).not.toHaveProperty("maxTotalTokens");
    });

    it("input without the field or with a string — an invalid request", async () => {
      seed();
      const before = raw();
      const { maxTotalTokens: _n, ...without } = good;
      await expect(make().api.saveDefaults(without)).rejects.toThrow(/^Некорректный запрос/);
      await expect(make().api.saveDefaults({ ...good, maxTotalTokens: "5" })).rejects.toThrow(/^Некорректный запрос/);
      expect(raw()).toBe(before);
    });
  });

  it("one participant: SettingsError, the file unchanged", async () => {
    seed();
    const before = raw();
    await expect(make().api.saveDefaults({ ...good, participants: [good.participants[0]] })).rejects.toThrow("Нужно не меньше двух участников");
    await expect(make().api.saveDefaults({ ...good, maxRounds: 0 })).rejects.toThrow(SettingsError);
    await expect(make().api.saveDefaults({ ...good, maxRounds: "3" })).rejects.toThrow(/^Некорректный запрос/);
    await expect(make().api.saveDefaults({ ...good, participants: [1, 2] })).rejects.toThrow(/^Некорректный запрос/);
    expect(raw()).toBe(before);
  });
});

describe("write and a corrupted registry", () => {
  it("file not writable: \"failed to write\", the content unchanged", async () => {
    seed();
    const before = raw();
    chmodSync(configPath(dir), 0o444);
    try {
      await expect(make().api.saveModels("api", ["a"])).rejects.toThrow("не удалось записать");
      expect(raw()).toBe(before);
    } finally {
      chmodSync(configPath(dir), 0o644);
    }
  });

  it("mutating actions with a corrupted registry throw RegistryError, the file does not change", async () => {
    writeFileSync(configPath(dir), "{");
    await expect(make().api.saveModels("api", [])).rejects.toThrow("не JSON");
    await expect(make().api.deleteProvider("api")).rejects.toThrow("не JSON");
    expect(raw()).toBe("{");
  });
});

describe("language of main refusals", () => {
  afterEach(() => setProcessLanguage("ru"));
  const cyr = /[А-Яа-яЁё]/;
  const goodDefaults = { maxRounds: 4, turnTimeoutSec: 120, contextChars: 5000, materialsChars: 80000, maxTotalTokens: null, maxParticipants: 4, participants: [{ providerId: "claude", model: "a" }, { providerId: "api", model: "b" }] };
  const newHttp = { id: null, label: "Новый", baseUrl: "https://new.example/v1", apiKeyEnv: "" };
  const msg = async (p: Promise<unknown>) => { const e = await p.catch((x: unknown) => x); expect(e).toBeInstanceOf(SettingsError); return (e as Error).message; };
  const foundHttp = (): ProviderInspection => ({ status: { id: "api", kind: "openai-http", label: "api", available: true, models: [], modelsConfirmed: false }, http: { baseUrl: "https://x", keyFile: "f" } });

  it("one api, a language change between actions: only the text changes, the file unchanged", async () => {
    seed();
    const before = raw();
    const api = make().api;
    setProcessLanguage("en");
    expect(await msg(api.deleteProvider("ghost"))).toBe("Provider “ghost” not found in the registry.");
    setProcessLanguage("ru");
    expect(await msg(api.deleteProvider("ghost"))).toBe("Провайдер «ghost» не найден в реестре.");
    expect(raw()).toBe(before);
  });

  it("one api: a cli cannot be changed or deleted, in both languages", async () => {
    seed();
    const before = raw();
    const api = make().api;
    setProcessLanguage("en");
    expect(await msg(api.saveProvider({ ...newHttp, id: "claude" }))).toBe("Only an HTTP provider can be edited.");
    expect(await msg(api.deleteProvider("claude"))).toBe("Only an HTTP provider can be deleted.");
    setProcessLanguage("ru");
    expect(await msg(api.saveProvider({ ...newHttp, id: "claude" }))).toBe("Изменить можно только HTTP-провайдера.");
    expect(await msg(api.deleteProvider("claude"))).toBe("Удалить можно только HTTP-провайдера.");
    expect(raw()).toBe(before);
  });

  it("Empty name in a request to main: refusal in the process language, the registry untouched", async () => {
    seed();
    const before = raw();
    const api = make().api;
    setProcessLanguage("en");
    expect(await msg(api.saveProvider({ ...newHttp, label: "" }))).toBe("Enter a name");
    setProcessLanguage("ru");
    expect(await msg(api.saveProvider({ ...newHttp, label: "" }))).toBe("Введите название");
    expect(raw()).toBe(before);
  });

  it("en: bad requests without Cyrillic", async () => {
    seed();
    setProcessLanguage("en");
    const api = make().api;
    expect(await msg(api.saveProvider(5))).toBe("Invalid request: provider must be an object.");
    expect(await msg(api.saveDefaults(5))).toBe("Invalid request: defaults must be an object.");
    const calls: Array<() => Promise<unknown>> = [
      () => api.saveModels("api", "x"), () => api.testProvider("api", ""), () => api.saveDefaults({}),
      () => api.saveProvider({ ...newHttp, id: 3 }), () => api.saveProvider({ ...newHttp, label: 1 }), () => api.deleteProvider(1),
      () => api.saveDefaults({ ...goodDefaults, maxTotalTokens: "x" }), () => api.saveDefaults({ ...goodDefaults, participants: 1 }), () => api.saveDefaults({ ...goodDefaults, participants: [1] }),
    ];
    for (const c of calls) {
      const m = await msg(c());
      expect(m).toMatch(/^Invalid request: /);
      expect(m).not.toMatch(cyr);
    }
    setProcessLanguage("ru");
    expect(await msg(api.saveProvider(5))).toBe("Некорректный запрос: провайдер — объект.");
  });

  it("one api: default reasons in the view in both languages", async () => {
    seed();
    const status = (id: string): ProviderStatus => id === "api"
      ? { id, kind: "openai-http", label: id, available: false, models: [], modelsConfirmed: false, keyEnv: "API_KEY", keySet: false }
      : { id, kind: "cli", label: id, available: false, models: [], modelsConfirmed: false };
    const api = make(status).api;
    setProcessLanguage("en");
    const en = await api.view();
    expect(en.providers[0]!.reason).toBe("Provider unavailable");
    expect(en.providers[1]).toMatchObject({ reason: "Provider unavailable", modelsReason: "the model list is unavailable without a key" });
    setProcessLanguage("ru");
    const ru = await api.view();
    expect(ru.providers[0]!.reason).toBe("Провайдер недоступен");
    expect(ru.providers[1]!.modelsReason).toBe("перечень моделей недоступен без ключа");
  });

  it("unavailable provider on a check call: the default reason in the current language", async () => {
    seed();
    const inspect = vi.fn(async (): Promise<ProviderInspection> => ({ status: { id: "api", kind: "openai-http", label: "api", available: false, models: [], modelsConfirmed: false } }));
    const api = createSettings({ dataDir: dir, env: {}, reloadEnv: () => {}, logger, transition: inertTransition(dir, logger), inspect: inspect as never });
    setProcessLanguage("en");
    expect(await api.testProvider("api", "m")).toEqual({ ok: false, reason: "Provider unavailable" });
    expect(logs).toContain("Test call api: refused: Provider unavailable");
    setProcessLanguage("ru");
    expect(await api.testProvider("api", "m")).toEqual({ ok: false, reason: "Провайдер недоступен" });
  });

  it("one api: the check call request in the process language, the driver response is not parsed", async () => {
    seed();
    let text = "";
    const call = vi.fn(async () => ({ text }));
    const api = createSettings({ dataDir: dir, env: {}, reloadEnv: () => {}, logger, transition: inertTransition(dir, logger), inspect: (async () => foundHttp()) as never, driver: (() => ({ call })) as never });
    const prompts: Record<string, string> = {};
    for (const lang of ["en", "ru"] as const) {
      for (const answer of ["готов", "ready", ""]) {
        setProcessLanguage(lang);
        text = answer;
        call.mockClear();
        expect(await api.testProvider("api", "m")).toEqual({ ok: true, ms: expect.any(Number) });
        const req = (call.mock.calls[0] as unknown as [{ prompt: string }])[0];
        expect(req.prompt).toBe(catalog(lang).testPrompt);
        prompts[lang] = req.prompt;
      }
    }
    expect(prompts["en"]).toBe("This is a connection check. Reply with one word: “ready”.");
    expect(prompts["en"]).not.toMatch(cyr);
    expect(prompts["ru"]).toBe("Это проверка связи. Ответь одним словом: «готов».");
  });

  it("journal lines do not depend on the language (all actions)", async () => {
    const run = async (lang: "en" | "ru") => {
      setProcessLanguage(lang);
      dir = mkdtempSync(join(tmpdir(), "council-settings-"));
      logs.length = 0;
      seed();
      let fail = false;
      const driver = () => ({ call: async () => { if (fail) throw new Error("boom"); return { text: "x" }; } });
      const api = createSettings({ dataDir: dir, env: {}, reloadEnv: () => {}, logger, transition: inertTransition(dir, logger), inspect: (async (p: { id: string }) => ({ ...foundHttp(), status: { ...foundHttp().status, id: p.id, kind: "openai-http" } })) as never, resetDiscovery: () => {}, driver: driver as never });
      await api.saveProvider(newHttp);
      await api.saveModels("api", ["m1", "m2"]);
      await api.refreshModels("api");
      await api.recheck();
      await api.saveDefaults(goodDefaults);
      await api.testProvider("api", "m");
      fail = true;
      expect(await api.testProvider("api", "m")).toEqual({ ok: false, reason: "boom" });
      await api.deleteProvider("api");
      return logs.map((l) => l.replace(/success in \d+ ms/, "успех за N мс"));
    };
    const en = await run("en");
    const ru = await run("ru");
    expect(en.length).toBeGreaterThanOrEqual(9);
    expect(en).toEqual(ru);
    expect(en).toContain("Defaults saved");
    expect(en.some((l) => l.includes("успех за N мс"))).toBe(true);
    expect(en).toContain("Test call api: refused: boom");
  });
});
