import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { setProcessLanguage, configPath, createLogger, DEFAULT_MODEL, initialRegistry, lineupsPath, RegistryError, saveLineup } from "@model-council/core";
import type { InspectDeps } from "@model-council/core";
import type { ToolContext } from "./context.ts";
import { councilOptions } from "./options.ts";
import { councilStart } from "./start.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const SCENARIOS = join(import.meta.dirname, "../../core/scenarios");
const FIX = join(import.meta.dirname, "../../core/src/cli-agents/fixtures");
const help = (path: string) => readFileSync(join(FIX, path.endsWith("claude") ? "claude-2.1.288-help.txt" : "codex-0.159.2-exec-help.txt"), "utf8");
const found = (a: "claude" | "codex") => ({ agent: a, found: true, path: `/stub/${a}`, version: "1.0.0", searchPath: "" });
const deps = (over: Partial<InspectDeps> = {}): Partial<InspectDeps> => ({
  locate: (async (a: "claude" | "codex") => found(a)) as InspectDeps["locate"],
  readHelp: async (path) => help(path),
  readFeatures: async () => readFileSync(join(FIX, "codex-0.159.2-features.txt"), "utf8"),
  listModels: (async () => ({ models: ["opus", "sonnet"], confirmed: true })) as InspectDeps["listModels"],
  ...over,
});
const ctxOf = (over: Partial<ToolContext> = {}, dataDir = tmp()): ToolContext => {
  const env = over.env ?? {};
  return {
    dataDir, env, logger: createLogger(dataDir, "mcp", env), builtinTemplatesDir: join(import.meta.dirname, "../../../templates"),
    scenariosDir: null, shutdown: new AbortController().signal, councilLaunch: { command: process.execPath, args: [join(import.meta.dirname, "../../core/src/council.ts")], env: {} }, inspectDeps: deps(), ...over,
  };
};
const run = (ctx: ToolContext) => councilOptions.run(ctx, {}) as ReturnType<typeof councilOptions.run> & Promise<import("./options.ts").OptionsView>;

describe("council_options", () => {
  it("1. lineup: templates, defaults from the registry, cli models", async () => {
    const r = await run(ctxOf());
    expect(r.templates.length).toBeGreaterThan(0);
    for (const t of r.templates) expect(Object.keys(t).sort()).toEqual(["category", "description", "id", "title"]);
    expect(r.defaults).toEqual({ maxRounds: 5, maxParticipants: 8, materialsChars: 60000, maxTotalTokens: null, participants: [{ providerId: "claude", model: DEFAULT_MODEL }, { providerId: "codex", model: DEFAULT_MODEL }] });
    const cli = r.providers.find((p) => p.id === "claude")!;
    expect(cli).toMatchObject({ kind: "cli", available: true, reason: null, defaultModel: DEFAULT_MODEL });
    expect(cli.models[0]).toBe(DEFAULT_MODEL);
    expect(cli.models).toContain("opus");
  });

  it("2. unavailable provider: reason", async () => {
    const dataDir = tmp();
    await run(ctxOf({}, dataDir));
    const locate = (async (a: "claude" | "codex") => a === "codex" ? { agent: a, found: false, searchPath: "", reason: "Команда codex не найдена" } : found(a)) as InspectDeps["locate"];
    const r = await run(ctxOf({ inspectDeps: deps({ locate }) }, dataDir));
    const codex = r.providers.find((p) => p.id === "codex")!;
    expect(codex.available).toBe(false);
    expect(codex.reason).toContain("Команда codex не найдена");
  });

  it("language: scripted provider without scenario files on en — English label and reason", async () => {
    const empty = tmp();
    setProcessLanguage("en");
    try {
      const r = await run(ctxOf({ scenariosDir: empty }));
      const s = r.providers.find((p) => p.id === "scripted")!;
      expect(s).toMatchObject({ label: "Scripted", available: false, reason: "No scenario files found" });
    } finally { setProcessLanguage("ru"); }
    const r = await run(ctxOf({ scenariosDir: empty }));
    expect(r.providers.find((p) => p.id === "scripted")).toMatchObject({ label: "Сценарный", reason: "Файлы сценариев не найдены" });
  });

  it("3. secrets do not get into the response", async () => {
    const dataDir = tmp();
    const reg = initialRegistry(["claude"]);
    reg.providers.push({ id: "or", kind: "openai-http", label: "OpenRouter", models: [], baseUrl: "http://localhost:1", apiKeyEnv: "OPENROUTER_API_KEY" });
    writeFileSync(configPath(dataDir), JSON.stringify(reg));
    const env = { OPENROUTER_API_KEY: "sk-test-секрет-123456", OTHER_KEY: "sk-other-654321" };
    const listHttpModels = (async () => ({ models: ["m1"], confirmed: true })) as InspectDeps["listHttpModels"];
    const r = await run(ctxOf({ env, inspectDeps: deps({ listHttpModels }) }, dataDir));
    const or = r.providers.find((p) => p.id === "or")!;
    expect(or).toMatchObject({ kind: "openai-http", available: true, models: ["m1"], defaultModel: null });
    const json = JSON.stringify(r);
    for (const v of Object.values(env)) expect(json).not.toContain(v);
    for (const f of ["keyEnv", "keySet", "baseUrl", "OPENROUTER_API_KEY", "apiKeyEnv"]) expect(json).not.toContain(f);
  });

  it("4. scripted: only with scenariosDir", async () => {
    const off = await run(ctxOf());
    expect(off.providers.some((p) => p.id === "scripted")).toBe(false);
    const on = await run(ctxOf({ scenariosDir: SCENARIOS }));
    const s = on.providers.at(-1)!;
    expect(s).toMatchObject({ id: "scripted", kind: "scripted", available: true, reason: null, defaultModel: null });
    expect(s.models).toContain("consensus/p1.json");
  });

  it("5. registry error is passed up", async () => {
    const dataDir = tmp();
    writeFileSync(configPath(dataDir), "{ не json");
    await expect(run(ctxOf({}, dataDir))).rejects.toBeInstanceOf(RegistryError);
    writeFileSync(configPath(dataDir), JSON.stringify({ providers: [], defaults: { maxRounds: 0 } }));
    await expect(run(ctxOf({}, dataDir))).rejects.toBeInstanceOf(RegistryError);
  });

  it("6. materialsChars: initial value and value from the config", async () => {
    expect((await run(ctxOf())).defaults.materialsChars).toBe(60000);
    const dataDir = tmp();
    const reg = initialRegistry(["claude"]);
    reg.defaults.materialsChars = 123;
    writeFileSync(configPath(dataDir), JSON.stringify(reg));
    expect((await run(ctxOf({}, dataDir))).defaults.materialsChars).toBe(123);
  });

  it("13. maxTotalTokens: absent from the initial config — null, from the config — the value", async () => {
    expect((await run(ctxOf())).defaults.maxTotalTokens).toBeNull();
    const dataDir = tmp();
    const reg = initialRegistry(["claude"]);
    reg.defaults.maxTotalTokens = 20000;
    writeFileSync(configPath(dataDir), JSON.stringify(reg));
    expect((await run(ctxOf({}, dataDir))).defaults.maxTotalTokens).toBe(20000);
  });
});

describe("council_options: named lineups", () => {
  const pos = (providerId: string, model: string, role: string | null = null) => ({ providerId, model, role });
  const bytes = (dir: string) => readFileSync(lineupsPath(dir));

  it("L1. no lineups file: empty list, the file is not created", async () => {
    const dataDir = tmp();
    const r = await run(ctxOf({}, dataDir));
    expect(r.lineups).toEqual([]);
    expect(r.lineupsError).toBeNull();
    expect(existsSync(lineupsPath(dataDir))).toBe(false);
  });

  it("L2. available lineup: positions in order, the file does not change", async () => {
    const dataDir = tmp();
    await saveLineup(dataDir, { name: "Пара", participants: [pos("codex", DEFAULT_MODEL, "Критик"), pos("claude", "opus")] });
    const before = bytes(dataDir);
    const r = await run(ctxOf({}, dataDir));
    expect(r.lineups).toHaveLength(1);
    expect(r.lineups[0]).toMatchObject({ name: "Пара", available: true });
    expect(r.lineups[0]!.participants.map((p) => [p.providerId, p.model, p.role, p.available])).toEqual([["codex", DEFAULT_MODEL, "Критик", true], ["claude", "opus", null, true]]);
    expect(bytes(dataDir).equals(before)).toBe(true);
  });

  it("L3. removed provider: position and lineup unavailable, the file does not change", async () => {
    const dataDir = tmp();
    await saveLineup(dataDir, { name: "С призраком", participants: [pos("claude", DEFAULT_MODEL), pos("ghost", "m")] });
    const before = bytes(dataDir);
    const r = await run(ctxOf({}, dataDir));
    const l = r.lineups[0]!;
    expect(l.available).toBe(false);
    expect(l.participants.map((p) => p.providerId)).toEqual(["claude", "ghost"]);
    expect(l.participants[0]!.available).toBe(true);
    expect(l.participants[1]).toMatchObject({ available: false });
    expect(l.participants[1]!.reason).toContain("не найден в реестре");
    expect(bytes(dataDir).equals(before)).toBe(true);
  });

  it("L4. model outside the list: a mark, the position is available", async () => {
    const dataDir = tmp();
    await saveLineup(dataDir, { name: "Неизвестная", participants: [pos("claude", "no-such-model"), pos("codex", DEFAULT_MODEL)] });
    const p = (await run(ctxOf({}, dataDir))).lineups[0]!.participants[0]!;
    expect(p.available).toBe(true);
    expect(p.modelNote).toContain("no-such-model");
  });

  it("L5. scripted position: unavailable without scenariosDir, available with it", async () => {
    const dataDir = tmp();
    await saveLineup(dataDir, { name: "Сценарии", participants: [pos("scripted", "consensus/p1.json"), pos("scripted", "consensus/p2.json")] });
    const off = (await run(ctxOf({}, dataDir))).lineups[0]!;
    expect(off.available).toBe(false);
    expect(off.participants[0]!.reason).toContain("COUNCIL_DEV");
    const on = (await run(ctxOf({ scenariosDir: SCENARIOS }, dataDir))).lineups[0]!;
    expect(on.available).toBe(true);
  });

  it("L6. corrupted file: lineupsError, the rest in place, the file does not change", async () => {
    const dataDir = tmp();
    writeFileSync(lineupsPath(dataDir), "{ не json");
    const r = await run(ctxOf({}, dataDir));
    expect(r.lineups).toEqual([]);
    expect(r.lineupsError).toMatch(/^lineups\.json:/);
    expect(r.templates.length).toBeGreaterThan(0);
    expect(r.providers.length).toBeGreaterThan(0);
    expect(r.defaults.maxRounds).toBe(5);
    expect(readFileSync(lineupsPath(dataDir), "utf8")).toBe("{ не json");
  });
});

describe("Shared log: loading settings in MCP", () => {
  it("council_options twice and council_start on one logger — one 'Settings loaded' line", async () => {
    const dataDir = tmp();
    const ctx = ctxOf({ scenariosDir: SCENARIOS, env: { COUNCIL_DEV: "1" } }, dataDir);
    await run(ctx);
    await run(ctx);
    const view = await councilStart.run(ctx, { topic: "Как назвать кота", participants: [{ providerId: "scripted", model: "consensus/p1.json" }, { providerId: "scripted", model: "consensus/p2.json" }] }) as { sessionId: string };
    expect(view.sessionId).toBeTruthy();
    for (let i = 0; i < 200 && !/session_finished/.test(readFileSync(join(dataDir, "sessions", view.sessionId, "events.jsonl"), "utf8")); i++) await new Promise((r) => setTimeout(r, 50)); // the executor is a separate process: let it finish before the folder is removed
    const lines = readFileSync(join(dataDir, "logs", "app.log"), "utf8").split("\n").filter((l) => l.includes("Settings loaded"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ INFO \[mcp\] Settings loaded: .*config\.json, providers: \d+$/);
    expect(lines[0]).toContain(configPath(dataDir));
  });
});
