import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_TEMPLATES_DIR, OWNER_WAIT_DEFAULT_SEC, OWNER_WAIT_MAX_SEC, appendEvent, builtinTemplateIds, createSessionJournal, loadTemplates } from "@model-council/core";
import type { ProviderStatus, Registry, Session } from "@model-council/core";
import { setProcessLanguage } from "@model-council/core/i18n";
import { applyProcessLanguage, userTemplatesDir } from "@model-council/core";
import { lastRoster, listScenarios, registryView, scenarioPath, templatesView } from "./setup-data.ts";

// Counts the bytes read from every file through readFileSync and readSync (core modules import the same node:fs).
const fsReads = vi.hoisted(() => ({ bytes: new Map<string, number>(), fds: new Map<number, string>() }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const add = (path: string | undefined, n: number) => { if (path !== undefined) fsReads.bytes.set(path, (fsReads.bytes.get(path) ?? 0) + n); };
  return {
    ...fs,
    openSync: (...a: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...a); fsReads.fds.set(fd, String(a[0])); return fd; },
    readSync: (...a: Parameters<typeof fs.readSync>) => { const n = fs.readSync(...a); add(fsReads.fds.get(a[0]), n); return n; },
    readFileSync: (...a: Parameters<typeof fs.readFileSync>) => { const r = fs.readFileSync(...a); add(typeof a[0] === "number" ? fsReads.fds.get(a[0]) : String(a[0]), Buffer.byteLength(r)); return r; },
  };
});

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

describe("lastRoster: Remembering the participant lineup", () => {
  const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const session = (id: string, origin: Session["origin"], n: number, model: string, extra: Partial<Session> = {}): Session => ({
    id, createdAt: ts(n), origin, topic: id, templateId: null, framing: "",
    participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: i === 1 ? "claude" : "scripted", model: `${model}${i}`, role: null })),
    limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 }, ...extra,
  });
  const created = (s: Session) => JSON.stringify({ seq: 1, ts: s.createdAt, type: "session_created", session: s, pid: 1 });
  const journal = (id: string, firstLine: string, tail = "") => {
    mkdirSync(join(dir, "sessions", id), { recursive: true });
    writeFileSync(join(dir, "sessions", id, "events.jsonl"), `${firstLine}\n${tail}`);
  };
  const tail = "x".repeat(200 * 1024);
  const bytesOf = (id: string) => fsReads.bytes.get(join(dir, "sessions", id, "events.jsonl")) ?? 0;
  beforeEach(() => { fsReads.bytes.clear(); });

  describe("Long history", () => {
    it("reads only the first line of the other journals: ties, an unreadable journal and a foreign first line", () => {
      const lines = new Map<string, string>();
      for (let i = 0; i < 50; i++) {
        const id = `s${String(i).padStart(2, "0")}`;
        lines.set(id, created(session(id, i % 2 ? "cli" : "desktop", i + 1, id)));
        journal(id, lines.get(id)!, tail);
      }
      // equal createdAt with the newest desktop one: the larger id wins
      for (const id of ["tie-a", "tie-b"]) { lines.set(id, created(session(id, "desktop", 100, id))); journal(id, lines.get(id)!, tail); }
      // a directory instead of a journal is unreadable; a journal whose first line is not session_created is skipped
      mkdirSync(join(dir, "sessions", "broken", "events.jsonl"), { recursive: true });
      lines.set("foreign", JSON.stringify({ seq: 1, ts: ts(200), type: "turn_started", turn: 1, round: 1, participantId: "p1" }));
      journal("foreign", lines.get("foreign")!, tail);
      expect(lastRoster(dir)).toEqual([{ providerId: "claude", model: "tie-b1" }, { providerId: "scripted", model: "tie-b2" }]);
      for (const [id, line] of lines) {
        if (id !== "tie-b") expect(bytesOf(id), id).toBeLessThanOrEqual(Buffer.byteLength(line) + 1 + 4096);
      }
    });
  });

  describe("Long first event", () => {
    it("a first line over 4 KiB does not skip the session", () => {
      const materials = Array.from({ length: 100 }, (_, i) => ({ id: `m${i + 1}`, name: `material-${i + 1}.md`, chars: 10, sha256: "a".repeat(64) }));
      const long = session("long", "desktop", 5, "long", { framing: "f".repeat(5000), materials });
      expect(Buffer.byteLength(created(long))).toBeGreaterThan(4096);
      journal("long", created(long));
      journal("other", created(session("other", "desktop", 1, "other")), tail);
      expect(lastRoster(dir)).toEqual([{ providerId: "claude", model: "long1" }, { providerId: "scripted", model: "long2" }]);
    });
  });

  describe("Participant replacement on resume", () => {
    it("proposes the participant that replaced one on resume", () => {
      const s = session("res", "desktop", 5, "res");
      const resumed = { seq: 2, ts: ts(6), type: "session_resumed", pid: 1, maxRounds: 4, replacements: [{ oldParticipantId: "p2", participant: { id: "p3", name: "n3", providerId: "claude", model: "swapped", role: null, replaces: "p2" } }] };
      journal("res", created(s), `${JSON.stringify(resumed)}\n`);
      expect(lastRoster(dir)).toEqual([{ providerId: "claude", model: "res1" }, { providerId: "claude", model: "swapped" }]);
    });
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
