import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSession } from "../engine.ts";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { BUILTIN_TEMPLATES_DIR, UnknownTemplateError, loadTemplates, templateSessionInput, userTemplatesDir } from "./templates.ts";
import type { TemplateCatalog } from "./templates.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-")); tmps.push(d); return d; };
beforeAll(() => setProcessLanguage("ru"));
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const tpl = (over: Record<string, unknown> = {}) => ({
  id: "arch", title: "Архитектура", category: "Код", description: "Когда брать", exampleTopic: "Пример", framing: "Рамка", ...over,
});
const put = (dir: string, file: string, v: unknown) => writeFileSync(join(dir, file), typeof v === "string" ? v : JSON.stringify(v));
// Built-in and user folders; neutral.md is in the built-in one.
function dirs() {
  const builtinDir = tmp();
  const ru = join(builtinDir, "ru");
  mkdirSync(ru);
  const userDir = tmp();
  put(ru, "neutral.md", "  Нейтральная рамка\n");
  return { builtinDir, ru, userDir };
}
const load = (d: ReturnType<typeof dirs>) => loadTemplates(d);
const errOf = (c: TemplateCatalog, file: string) => c.errors.find((e) => e.file === file)?.reason ?? "";

const defaults = { maxRounds: 5, turnTimeoutSec: 300, contextChars: 24000 };
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `n${i}`, providerId: "claude", model: "m" }));
const start = (catalog: TemplateCatalog, over: object = {}) => ({
  catalog, topic: "Тема", origin: "cli" as const, participants: people(2), limits: {}, defaults, ...over,
});

describe("loadTemplates: loading", () => {
  it("full template", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl({ roles: ["Скептик"], limits: { maxRounds: 4 } }));
    const t = load(d).templates[0]!;
    expect(t).toMatchObject({ id: "arch", title: "Архитектура", category: "Код", description: "Когда брать", source: "builtin", file: "a.json", roles: ["Скептик"], limits: { maxRounds: 4 } });
  });

  it("without roles and limits", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl());
    const c = load(d);
    expect(c.templates[0]).toMatchObject({ roles: [], limits: {} });
    expect(templateSessionInput(start(c, { templateId: "arch" })).participants.map((p) => p.role)).toEqual([null, null]);
  });

  it("no framing", () => {
    const d = dirs();
    const { framing, ...rest } = tpl();
    put(d.ru, "a.json", rest);
    const c = load(d);
    expect(c.templates).toEqual([]);
    expect(c.errors[0]).toMatchObject({ source: "builtin", file: "a.json", reason: "framing: обязательное поле отсутствует" });
  });

  it("broken JSON", () => {
    const d = dirs();
    put(d.ru, "a.json", "{");
    put(d.ru, "b.json", tpl({ id: "ok" }));
    const c = load(d);
    expect(c.templates.map((t) => t.id)).toEqual(["ok"]);
    expect(c.errors[0]!.file).toBe("a.json");
    expect(c.errors[0]!.reason).toMatch(/^не JSON/);
  });

  it("duplicate id in one folder", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl());
    put(d.ru, "b.json", tpl({ title: "Другой" }));
    const c = load(d);
    expect(c.templates).toHaveLength(1);
    expect(c.templates[0]!.file).toBe("a.json");
    expect(errOf(c, "b.json")).toContain("дубль идентификатора");
  });

  it("user template with a new id", () => {
    const d = dirs();
    put(d.userDir, "u.json", tpl({ id: "mine" }));
    expect(load(d).templates[0]).toMatchObject({ id: "mine", source: "user" });
  });

  it("user template overrides the built-in one, file unchanged", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl());
    const before = readFileSync(join(d.ru, "a.json"));
    put(d.userDir, "u.json", tpl({ title: "Новое" }));
    const c = load(d);
    expect(c.templates).toHaveLength(1);
    expect(c.templates[0]).toMatchObject({ source: "user", title: "Новое" });
    expect(c.errors).toEqual([]);
    expect(readFileSync(join(d.ru, "a.json")).equals(before)).toBe(true);
  });

  it("no user folder", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl());
    const c = loadTemplates({ builtinDir: d.builtinDir, userDir: join(d.userDir, "нет") });
    expect(c.templates).toHaveLength(1);
    expect(c.errors).toEqual([]);
  });

  it("framing as an array and as whitespace", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl({ framing: ["строка 1", "", "строка 3"] }));
    put(d.ru, "b.json", tpl({ id: "b", framing: "   " }));
    const c = load(d);
    expect(c.templates[0]!.framing).toBe("строка 1\n\nстрока 3");
    expect(errOf(c, "b.json")).toContain("framing");
  });

  it("extra field, bad id, maxRounds 0", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl({ extra: 1 }));
    put(d.ru, "b.json", tpl({ id: "Плохой ID" }));
    put(d.ru, "c.json", tpl({ id: "c", limits: { maxRounds: 0 } }));
    const c = load(d);
    expect(errOf(c, "a.json")).toBe("(корень): лишнее поле «extra»");
    expect(errOf(c, "b.json")).toContain("id:");
    expect(errOf(c, "c.json")).toContain("limits.maxRounds");
  });

  it("non-JSON files and subfolders are ignored", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl());
    put(d.ru, "notes.txt", "x");
    mkdirSync(join(d.ru, "sub.json"));
    const c = load(d);
    expect(c.templates).toHaveLength(1);
    expect(c.errors).toEqual([]);
  });

  it("order: category, then id", () => {
    const d = dirs();
    put(d.ru, "1.json", tpl({ id: "z", category: "А" }));
    put(d.ru, "2.json", tpl({ id: "b", category: "Б" }));
    put(d.ru, "3.json", tpl({ id: "a", category: "Б" }));
    expect(load(d).templates.map((t) => t.id)).toEqual(["z", "a", "b"]);
  });

  it("category sorting passes the locale of the set language", () => {
    const d = dirs();
    const en = join(d.builtinDir, "en");
    mkdirSync(en);
    put(en, "neutral.md", "N");
    put(en, "1.json", tpl({ id: "x", category: "B" }));
    put(en, "2.json", tpl({ id: "y", category: "A" }));
    put(d.ru, "1.json", tpl({ id: "x", category: "Б" }));
    put(d.ru, "2.json", tpl({ id: "y", category: "А" }));
    const spy = vi.spyOn(String.prototype, "localeCompare");
    try {
      expect(loadTemplates({ ...d, language: "en" }).templates.map((t) => t.id)).toEqual(["y", "x"]);
      expect(new Set(spy.mock.calls.map((c) => c[1]))).toEqual(new Set(["en"]));
      spy.mockClear();
      expect(loadTemplates({ ...d, language: "ru" }).templates.map((t) => t.id)).toEqual(["y", "x"]);
      expect(new Set(spy.mock.calls.map((c) => c[1]))).toEqual(new Set(["ru"]));
    } finally {
      spy.mockRestore();
    }
  });
});

describe("loadTemplates: symbolic links", () => {
  it("a symlink instead of a template file is not loaded and is listed in errors with its reason", () => {
    const d = dirs();
    const outside = tmp();
    put(outside, "linked.json", tpl({ id: "linked" }));
    mkdirSync(join(outside, "dir"));
    put(d.userDir, "ok.json", tpl({ id: "ok" }));
    symlinkSync(join(outside, "linked.json"), join(d.userDir, "x.json"));
    symlinkSync(join(outside, "dir"), join(d.userDir, "d.json"));
    for (const [language, reason] of [["ru", "символьная ссылка не загружается"], ["en", "symbolic link is not loaded"]] as const) {
      setProcessLanguage(language);
      try {
        const c = loadTemplates({ ...d, language: "ru" });
        expect(c.templates.map((t) => t.id)).toEqual(["ok"]);
        expect(c.errors).toEqual([
          { source: "user", file: "d.json", reason },
          { source: "user", file: "x.json", reason },
        ]);
      } finally {
        setProcessLanguage("ru");
      }
    }
  });
});

describe("loadTemplates: neutral frame", () => {
  it("built-in only", () => {
    expect(load(dirs()).neutralFraming).toBe("Нейтральная рамка");
  });

  it("user overrides", () => {
    const d = dirs();
    put(d.userDir, "neutral.md", "Моя\n");
    const c = load(d);
    expect(c.neutralFraming).toBe("Моя");
    expect(c.errors).toEqual([]);
  });

  it("empty user", () => {
    const d = dirs();
    put(d.userDir, "neutral.md", " \n");
    const c = load(d);
    expect(c.neutralFraming).toBe("Нейтральная рамка");
    expect(c.errors).toEqual([{ source: "user", file: "neutral.md", reason: "файл пуст — используется встроенная нейтральная рамка" }]);
  });

  it("no built-in", () => {
    expect(() => loadTemplates({ builtinDir: tmp(), userDir: tmp() })).toThrow("Нейтральная рамка не найдена");
  });

  it("an error in a template does not block the rest: unreadable user frame", () => {
    const variants: ((path: string) => void)[] = [(p) => mkdirSync(p)];
    if (process.getuid?.() !== 0) variants.push((p) => { writeFileSync(p, "Моя"); chmodSync(p, 0o000); });
    for (const make of variants) {
      const d = dirs();
      put(d.ru, "a.json", tpl());
      put(d.userDir, "b.json", tpl({ id: "b" }));
      make(join(d.userDir, "neutral.md"));
      for (const [language, prefix] of [["ru", "не удалось прочитать — "], ["en", "could not read — "]] as const) {
        setProcessLanguage(language);
        try {
          const c = loadTemplates({ ...d, language: "ru" });
          expect(c.templates.map((t) => t.id).sort()).toEqual(["arch", "b"]);
          expect(c.neutralFraming).toBe("Нейтральная рамка");
          expect(c.errors).toHaveLength(1);
          expect(c.errors[0]).toMatchObject({ source: "user", file: "neutral.md" });
          expect(c.errors[0]!.reason.startsWith(prefix)).toBe(true);
        } finally {
          setProcessLanguage("ru");
        }
      }
      chmodSync(join(d.userDir, "neutral.md"), 0o755);
    }
    const noBuiltin = { builtinDir: tmp(), userDir: tmp() };
    mkdirSync(join(noBuiltin.userDir, "neutral.md"));
    expect(() => loadTemplates(noBuiltin)).toThrow("Нейтральная рамка не найдена");
  });

  it("built-in frame of the language is missing, a user one exists: rejected with the same path", () => {
    const d = dirs();
    rmSync(join(d.ru, "neutral.md"));
    put(d.ru, "a.json", tpl());
    put(d.userDir, "neutral.md", "Моя\n");
    expect(() => loadTemplates({ ...d, language: "ru" })).toThrow(`Нейтральная рамка не найдена: ${join(d.ru, "neutral.md")}`);
    mkdirSync(join(d.ru, "neutral.md"));
    expect(() => loadTemplates({ ...d, language: "ru" })).toThrow(`Нейтральная рамка не найдена: ${join(d.ru, "neutral.md")}`);
  });

  it("no language folder or its neutral.md: rejected with the path, another language is not substituted", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl());
    const en = join(d.builtinDir, "en");
    const fail = () => { try { loadTemplates({ ...d, language: "en" }); } catch (e) { return (e as Error).message; } return ""; };
    expect(fail()).toContain(join(en, "neutral.md"));
    mkdirSync(en);
    put(en, "e.json", tpl({ id: "e" }));
    expect(fail()).toContain(join(en, "neutral.md"));
    put(en, "neutral.md", "Neutral");
    expect(loadTemplates({ ...d, language: "en" }).templates.map((t) => t.id)).toEqual(["e"]);
  });

  it("en set from its own folder; default language is the process language", () => {
    const d = dirs();
    const en = join(d.builtinDir, "en");
    mkdirSync(en);
    put(en, "neutral.md", "Neutral framing");
    put(en, "e.json", tpl({ id: "e", title: "Architecture" }));
    put(d.ru, "a.json", tpl());
    const viaEn = loadTemplates({ ...d, language: "en" });
    expect(viaEn.templates.map((t) => t.title)).toEqual(["Architecture"]);
    expect(viaEn.neutralFraming).toBe("Neutral framing");
    expect(load(d).templates.map((t) => t.id)).toEqual(["arch"]);
    setProcessLanguage("en");
    try {
      expect(load(d).neutralFraming).toBe("Neutral framing");
    } finally {
      setProcessLanguage("ru");
    }
  });

  it("user frame and template override in both languages", () => {
    const d = dirs();
    const en = join(d.builtinDir, "en");
    mkdirSync(en);
    put(en, "neutral.md", "Neutral");
    put(en, "a.json", tpl({ title: "Built-in" }));
    put(d.ru, "a.json", tpl());
    put(d.userDir, "a.json", tpl({ title: "Мой", framing: "Мой текст" }));
    put(d.userDir, "neutral.md", "Моя");
    for (const language of ["ru", "en"] as const) {
      const c = loadTemplates({ ...d, language });
      expect(c.templates).toHaveLength(1);
      expect(c.templates[0]).toMatchObject({ title: "Мой", framing: "Мой текст", source: "user" });
      expect(c.neutralFraming).toBe("Моя");
    }
  });
});

describe("templateSessionInput", () => {
  const withRoles = (n: number) => {
    const d = dirs();
    put(d.ru, "a.json", tpl({ roles: ["r1", "r2", "r3"].slice(0, n) }));
    return load(d);
  };

  describe("materialsChars", () => {
    const cat = () => withRoles(1);
    it("run limit overrides the default value", () => {
      const i = templateSessionInput(start(cat(), { limits: { materialsChars: 10 }, defaults: { ...defaults, materialsChars: 99 } }));
      expect(i.limits.materialsChars).toBe(10);
    });
    it("registry value is used", () => {
      const i = templateSessionInput(start(cat(), { defaults: { ...defaults, materialsChars: 99 } }));
      expect(i.limits.materialsChars).toBe(99);
    });
    it("no key if the value is nowhere", () => {
      const i = templateSessionInput(start(cat()));
      expect("materialsChars" in i.limits).toBe(false);
    });
    it("template limits have no effect", () => {
      const d = dirs();
      put(d.ru, "a.json", tpl({ limits: { contextChars: 7 } }));
      const i = templateSessionInput(start(load(d), { templateId: "arch" }));
      expect(i.limits.contextChars).toBe(7);
      expect("materialsChars" in i.limits).toBe(false);
    });
    it("template file cannot carry materialsChars", () => {
      const d = dirs();
      put(d.ru, "a.json", tpl({ limits: { materialsChars: 5 } }));
      expect(load(d).templates).toHaveLength(0);
    });
  });

  describe("maxTotalTokens", () => {
    const cat = () => withRoles(1);
    it("run limit overrides defaults", () => {
      expect(templateSessionInput(start(cat(), { limits: { maxTotalTokens: 10 }, defaults: { ...defaults, maxTotalTokens: 99 } })).limits.maxTotalTokens).toBe(10);
    });
    it("from defaults when limits has none", () => {
      expect(templateSessionInput(start(cat(), { defaults: { ...defaults, maxTotalTokens: 99 } })).limits.maxTotalTokens).toBe(99);
    });
    it("noTokenCap removes the field", () => {
      const i = templateSessionInput(start(cat(), { noTokenCap: true, limits: { maxTotalTokens: 10 }, defaults: { ...defaults, maxTotalTokens: 99 } }));
      expect("maxTotalTokens" in i.limits).toBe(false);
    });
    it("no field at all", () => {
      expect("maxTotalTokens" in templateSessionInput(start(cat())).limits).toBe(false);
    });
  });

  it("three roles, two participants", () => {
    const i = templateSessionInput(start(withRoles(3), { templateId: "arch" }));
    expect(i.participants.map((p) => p.role)).toEqual(["r1", "r2"]);
  });

  it("two roles, three participants", () => {
    const i = templateSessionInput(start(withRoles(2), { templateId: "arch", participants: people(3) }));
    expect(i.participants.map((p) => p.role)).toEqual(["r1", "r2", null]);
  });

  it("limits", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl({ limits: { maxRounds: 4 } }));
    const c = load(d);
    const lim = (limits: object) => templateSessionInput(start(c, { templateId: "arch", limits })).limits;
    expect(lim({})).toEqual({ maxRounds: 4, turnTimeoutSec: 300, contextChars: 24000 });
    expect(lim({ maxRounds: 2 }).maxRounds).toBe(2);
    expect(lim({ maxRounds: undefined }).maxRounds).toBe(4);
  });

  it("frame", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl());
    const c = load(d);
    const none = templateSessionInput(start(c));
    expect(none).toMatchObject({ framing: "Нейтральная рамка", templateId: null });
    expect(templateSessionInput(start(c, { framing: "Своя" })).framing).toBe("Своя");
    expect(templateSessionInput(start(c, { templateId: "arch" })).framing).toBe("Рамка");
    expect(templateSessionInput(start(c, { templateId: "arch", framing: "Своя" }))).toMatchObject({ framing: "Своя", templateId: "arch" });
  });

  it("unknown templateId", () => {
    const c = load(dirs());
    expect(() => templateSessionInput(start(c, { templateId: "nope" }))).toThrow(UnknownTemplateError);
    expect(() => templateSessionInput(start(c, { templateId: "nope" }))).toThrow("nope");
  });

  it("frame is copied into the session", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl());
    const session = createSession(templateSessionInput(start(load(d), { templateId: "arch" })), { maxParticipants: 8 });
    put(d.ru, "a.json", tpl({ framing: "Новая" }));
    expect(session.framing).toBe("Рамка");
    expect(load(d).templates[0]!.framing).toBe("Новая");
  });
});

describe("built-in folder", () => {
  it("neutral.md in place", () => {
    const c = loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: userTemplatesDir(tmp()) });
    expect(c.neutralFraming.startsWith("Разбери тему по существу")).toBe(true);
  });
});
