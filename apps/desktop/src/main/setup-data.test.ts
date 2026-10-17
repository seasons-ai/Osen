import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_TEMPLATES_DIR, OWNER_WAIT_DEFAULT_SEC, OWNER_WAIT_MAX_SEC, appendEvent, builtinTemplateIds, createSessionJournal, loadTemplates } from "@model-council/core";
import type { ProviderStatus, Registry, Session } from "@model-council/core";
import { setProcessLanguage } from "@model-council/core/i18n";
import { applyProcessLanguage, userTemplatesDir } from "@model-council/core";
import { lastRoster, listScenarios, registryView, scenarioPath, templatesView } from "./setup-data.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-setup-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const touch = (rel: string, body = "{}") => {
  const f = join(dir, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, body);
};

describe("templatesView", () => {
  it("cards without framing, maxRounds, errors", () => {
    const userDir = join(dir, "user");
    mkdirSync(userDir);
    writeFileSync(join(userDir, "bad.json"), "{не json");
    writeFileSync(join(userDir, "mine.json"), JSON.stringify({ id: "mine", title: "Моё", category: "Я", description: "d", exampleTopic: "t", framing: "рамка", roles: ["А", "Б"], limits: { maxRounds: 7 } }));
    writeFileSync(join(userDir, "free.json"), JSON.stringify({ id: "free", title: "Без лимита", category: "Я", description: "d", exampleTopic: "t", framing: "рамка" }));
    const catalog = loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir });
    const view = templatesView(catalog, builtinTemplateIds({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir }));
    expect(view.templates.map((t) => t.id)).toEqual(catalog.templates.map((t) => t.id));
    const mine = view.templates.find((t) => t.id === "mine")!;
    expect(mine).toEqual({ id: "mine", title: "Моё", category: "Я", description: "d", exampleTopic: "t", roles: ["А", "Б"], maxRounds: 7, source: "user", modified: false });
    expect(mine).not.toHaveProperty("framing");
    expect(view.templates.find((t) => t.id === "free")!.maxRounds).toBeNull();
    expect(view.errors).toEqual([{ file: "bad.json", reason: expect.stringContaining("не JSON") }]);
  });
});

describe("templatesView: language change without a restart", () => {
  afterEach(() => setProcessLanguage("ru"));
  it("the gallery reads the set of the language set by applyProcessLanguage, on every request", () => {
    const root = join(dir, "builtin");
    for (const [lang, title] of [["ru", "Архитектура"], ["en", "Architecture"]] as const) {
      mkdirSync(join(root, lang), { recursive: true });
      writeFileSync(join(root, lang, "neutral.md"), "N");
      writeFileSync(join(root, lang, "arch.json"), JSON.stringify({ id: "arch", title, category: "K", description: "d", exampleTopic: "t", framing: "F" }));
    }
    const dirs = () => ({ builtinDir: root, userDir: userTemplatesDir(dir) });
    const gallery = () => templatesView(loadTemplates(dirs()), builtinTemplateIds(dirs())).templates.map((t) => t.title);
    expect(applyProcessLanguage({ COUNCIL_HOME: dir, COUNCIL_LANG: "ru" }).language).toBe("ru");
    expect(gallery()).toEqual(["Архитектура"]);
    applyProcessLanguage({ COUNCIL_HOME: dir, COUNCIL_LANG: "en" });
    expect(gallery()).toEqual(["Architecture"]);
    applyProcessLanguage({ COUNCIL_HOME: dir, COUNCIL_LANG: "ru" });
    expect(gallery()).toEqual(["Архитектура"]);
  });
});

describe("templatesView: modified", () => {
  it("overriding a built-in — true, own and built-in — false", () => {
    const userDir = join(dir, "user");
    mkdirSync(userDir);
    const dirs = { builtinDir: BUILTIN_TEMPLATES_DIR, userDir };
    const base = loadTemplates(dirs).templates.find((t) => t.source === "builtin")!;
    const { source: _s, file: _f, ...fields } = base;
    writeFileSync(join(userDir, "over.json"), JSON.stringify({ ...fields, title: "Изменён" }));
    writeFileSync(join(userDir, "mine.json"), JSON.stringify({ ...fields, id: "mine" }));
    const view = templatesView(loadTemplates(dirs), builtinTemplateIds(dirs));
    const by = (id: string) => view.templates.find((t) => t.id === id)!;
    expect(by(base.id)).toMatchObject({ source: "user", modified: true });
    expect(by("mine").modified).toBe(false);
    expect(view.templates.filter((t) => t.source === "builtin").every((t) => !t.modified)).toBe(true);
  });
});

describe("listScenarios / scenarioPath", () => {
  it("nested folders, only .json, sorting", () => {
    touch("b.json"); touch("a/z.json"); touch("a/n.txt"); touch("a/b/c.json"); touch("readme.md");
    expect(listScenarios(dir)).toEqual(["a/b/c.json", "a/z.json", "b.json"]);
  });

  it("no folder", () => {
    expect(listScenarios(join(dir, "none"))).toEqual([]);
  });

  it("scenarioPath: known, unknown, leaving the folder, null", () => {
    touch("a/x.json"); writeFileSync(join(dir, "..", "council-outside.json"), "{}");
    try {
      expect(scenarioPath(dir, "a/x.json")).toBe(join(dir, "a/x.json"));
      expect(scenarioPath(dir, "nope.json")).toBeNull();
      expect(scenarioPath(dir, "../council-outside.json")).toBeNull();
      expect(scenarioPath(null, "a/x.json")).toBeNull();
    } finally { rmSync(join(dir, "..", "council-outside.json"), { force: true }); }
  });
});

describe("registryView", () => {
  const registry: Registry = {
    providers: [
      { id: "claude", kind: "cli", label: "Claude Code", agent: "claude", models: [] },
      { id: "paid", kind: "openai-http", label: "Платный", baseUrl: "http://x", apiKeyEnv: "K", models: [] },
      { id: "local", kind: "openai-http", label: "Локальный", baseUrl: "http://y", models: ["m0"] },
      { id: "codex", kind: "cli", label: "Codex", agent: "codex", models: ["c1"] },
    ],
    defaults: { maxRounds: 5, turnTimeoutSec: 300, contextChars: 24000, maxParticipants: 8, materialsIgnore: ["node_modules", "dist", "build"], materialsChars: 60000, participants: [{ providerId: "claude", model: "default" }] },
  };
  const st = (o: Partial<ProviderStatus> & Pick<ProviderStatus, "id" | "kind">): ProviderStatus => ({ label: o.id, available: true, models: [], modelsConfirmed: true, ...o });
  const statuses = [
    st({ id: "claude", kind: "cli", models: ["opus", "default", "sonnet"] }),
    st({ id: "paid", kind: "openai-http", keyEnv: "K", keySet: true, models: ["gpt"] }),
    st({ id: "local", kind: "openai-http", models: ["llama"] }),
  ];

  it("cli, http with a key and without, a missing status", () => {
    const { providers } = registryView(registry, statuses, null);
    expect(providers.map((p) => p.id)).toEqual(["claude", "paid", "local", "codex"]);
    expect(providers[0]).toMatchObject({ kind: "cli", models: ["default", "opus", "sonnet"], defaultModel: "default", billing: "subscription", available: true, reason: null });
    expect(providers[1]).toMatchObject({ models: ["gpt"], defaultModel: null, billing: "paid" });
    expect(providers[2]).toMatchObject({ models: ["llama"], billing: "free" });
    expect(providers[3]).toMatchObject({ available: false, reason: "Провайдер не осмотрен", models: ["default", "c1"] });
  });

  it("unavailable: the reason from the status and a fallback", () => {
    const { providers } = registryView(registry, [st({ id: "claude", kind: "cli", available: false, reason: "нет команды" }), st({ id: "paid", kind: "openai-http", available: false })], null);
    expect(providers[0]).toMatchObject({ available: false, reason: "нет команды" });
    expect(providers[1]).toMatchObject({ available: false, reason: "Провайдер недоступен" });
  });

  it("scripted provider", () => {
    expect(registryView(registry, statuses, null).providers.some((p) => p.kind === "scripted")).toBe(false);
    expect(registryView(registry, statuses, []).providers.at(-1)).toEqual({ id: "scripted", kind: "scripted", label: "Сценарный", available: false, reason: "Файлы сценариев не найдены", models: [], defaultModel: null, billing: "free" });
    expect(registryView(registry, statuses, ["a.json"]).providers.at(-1)).toMatchObject({ available: true, reason: null, models: ["a.json"] });
  });

  it("defaults", () => {
    expect(registryView(registry, statuses, null).defaults).toEqual({ maxRounds: 5, maxParticipants: 8, materialsChars: 60000, maxTotalTokens: null, participants: [{ providerId: "claude", model: "default" }] });
    const set = { ...registry, defaults: { ...registry.defaults, maxTotalTokens: 30000 } };
    expect(registryView(set, statuses, null).defaults.maxTotalTokens).toBe(30000);
  });

  it("owner wait bounds from the engine", () => {
    expect(registryView(registry, statuses, null).ownerWait).toEqual({ minSec: 1, maxSec: OWNER_WAIT_MAX_SEC, defaultSec: OWNER_WAIT_DEFAULT_SEC });
  });
});

describe("lastRoster", () => {
  const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const write = (id: string, origin: Session["origin"], n: number, model: string) => {
    const s: Session = {
      id, createdAt: ts(n), origin, topic: id, templateId: null, framing: "",
      participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: i === 1 ? "claude" : "scripted", model: `${model}${i}`, role: null })),
      limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 },
    };
    createSessionJournal(dir, id);
    appendEvent(dir, id, { seq: 1, ts: s.createdAt, type: "session_created", session: s, pid: 1 });
  };

  it("no sessions", () => { expect(lastRoster(dir)).toBeNull(); });

  it("cli only", () => {
    write("a", "cli", 1, "m");
    expect(lastRoster(dir)).toBeNull();
  });

  it("the newer desktop session is taken", () => {
    write("old", "desktop", 1, "old"); write("new", "desktop", 3, "new"); write("c", "cli", 5, "cli");
    expect(lastRoster(dir)).toEqual([{ providerId: "claude", model: "new1" }, { providerId: "scripted", model: "new2" }]);
  });
});

describe("language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const registry: Registry = {
    providers: [{ id: "a", kind: "cli", label: "A", agent: "claude", models: [] }, { id: "b", kind: "cli", label: "B", agent: "codex", models: [] }],
    defaults: { maxRounds: 5, turnTimeoutSec: 300, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 60000, participants: [{ providerId: "a", model: "default" }] },
  };
  const down = (o: Partial<ProviderStatus>): ProviderStatus => ({ id: "a", kind: "cli", label: "A", available: false, models: [], modelsConfirmed: true, ...o });
  const view = (lang: "en" | "ru", statuses: ProviderStatus[], scen: string[] | null) => { setProcessLanguage(lang); return registryView(registry, statuses, scen).providers; };

  it("reasons and the scripted provider name in two languages", () => {
    const en = view("en", [down({})], []);
    expect(en.map((p) => p.reason)).toEqual(["Provider unavailable", "Provider not inspected", "Scenario files not found"]);
    expect(en[2]!.label).toBe("Scripted");
    const ru = view("ru", [down({})], []);
    expect(ru.map((p) => p.reason)).toEqual(["Провайдер недоступен", "Провайдер не осмотрен", "Файлы сценариев не найдены"]);
    expect(ru[2]!.label).toBe("Сценарный");
    expect(en.map((p) => p.reason).join()).not.toMatch(/[А-Яа-яЁё]/);
  });

  it("the reason from the provider state is passed verbatim", () => {
    expect(view("en", [down({ reason: "нет бинарника" })], null)[0]!.reason).toBe("нет бинарника");
  });
});
