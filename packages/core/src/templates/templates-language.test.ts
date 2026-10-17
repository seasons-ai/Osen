import { chmodSync, mkdirSync, symlinkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import type { Language } from "../i18n/language.ts";
import { checkTemplate } from "./schema.ts";
import { BUILTIN_TEMPLATES_DIR, UnknownTemplateError, loadTemplates, templateSessionInput } from "./templates.ts";
import { TemplateStoreError, createUserTemplate, deleteUserTemplate, saveUserTemplate } from "./write.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-l-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(() => setProcessLanguage("ru"));

const tpl = (over: Record<string, unknown> = {}) => ({ id: "arch", title: "T", category: "C", description: "D", exampleTopic: "E", framing: "F", ...over });
const put = (dir: string, file: string, v: unknown) => writeFileSync(join(dir, file), typeof v === "string" ? v : JSON.stringify(v));
function dirs() {
  const root = tmp();
  const builtinDir = join(root, "builtin");
  mkdirSync(join(builtinDir, "ru"), { recursive: true });
  symlinkSync(join(builtinDir, "ru"), join(builtinDir, "en")); // both languages read one fixture
  const userDir = join(tmp(), "templates");
  put(builtinDir, "ru/neutral.md", "N");
  return { builtinDir, userDir };
}
const at = <T>(lang: Language, f: () => T): T => { setProcessLanguage(lang); return f(); };
const storeErr = (f: () => unknown) => { try { f(); } catch (e) { if (e instanceof TemplateStoreError) return e; throw e; } throw new Error("no error"); };

describe("Core messages in the selected language: template validation reasons", () => {
  const { framing: _f, ...noFraming } = tpl();
  const messages = (input: unknown) => {
    const r = checkTemplate(input);
    return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
  };
  it("extra field, wrong type, missing field: ru, en, ru in a row", () => {
    const input = { ...noFraming, extra: 1, title: 5 };
    const ru = at("ru", () => messages(input));
    const en = at("en", () => messages(input));
    expect(at("ru", () => messages(input))).toEqual(ru);
    expect(ru).toEqual(expect.arrayContaining(["extra: лишнее поле «extra»", "title: ожидается строка", "framing: обязательное поле отсутствует"]));
    expect(en).toEqual(expect.arrayContaining(["extra: extra field «extra»", "title: expected string", "framing: required field is missing"]));
  });
  it("root in both languages", () => {
    expect(at("ru", () => messages(5))).toEqual(["(корень): ожидается объект"]);
    expect(at("en", () => messages(5))).toEqual(["(root): expected object"]);
  });
});

describe("Core messages in the selected language: template loading", () => {
  it("file errors and an unknown template with the same file name and identifier", () => {
    const d = dirs();
    put(d.builtinDir, "ru/bad.json", "{");
    put(d.builtinDir, "ru/a.json", tpl());
    put(d.builtinDir, "ru/b.json", tpl());
    put(d.builtinDir, "ru/nof.json", { ...tpl({ id: "x" }), framing: undefined });
    const run = (lang: Language) => at(lang, () => {
      const c = loadTemplates(d);
      return { c, reasons: Object.fromEntries(c.errors.map((e) => [e.file, e.reason])) };
    });
    const ru = run("ru");
    const en = run("en");
    expect(ru.reasons["bad.json"]).toMatch(/^не JSON — /);
    expect(en.reasons["bad.json"]).toMatch(/^not JSON — /);
    expect(ru.reasons["b.json"]).toBe("дубль идентификатора «arch»: уже загружен из a.json");
    expect(en.reasons["b.json"]).toBe("duplicate identifier «arch»: already loaded from a.json");
    expect(ru.reasons["nof.json"]).toBe("framing: обязательное поле отсутствует");
    expect(en.reasons["nof.json"]).toBe("framing: required field is missing");
    const unknown = (lang: Language) => at(lang, () => {
      try { templateSessionInput({ catalog: ru.c, templateId: "nope", topic: "t", origin: "cli", participants: [], limits: {}, defaults: { maxRounds: 1, turnTimeoutSec: 1, contextChars: 1 } }); } catch (e) { if (e instanceof UnknownTemplateError) return e.message; throw e; }
      throw new Error("no error");
    });
    expect(unknown("ru")).toBe("Шаблон «nope» не найден.");
    expect(unknown("en")).toBe("Template «nope» not found.");
    expect(at("ru", () => unknown("ru"))).toBe("Шаблон «nope» не найден.");
  });
  it("neutral frame not found: same path", () => {
    const d = { builtinDir: tmp(), userDir: tmp() };
    const msg = (lang: Language) => at(lang, () => { try { loadTemplates(d); } catch (e) { return (e as Error).message; } return ""; });
    expect(msg("ru")).toBe(`Нейтральная рамка не найдена: ${join(d.builtinDir, "ru", "neutral.md")}`);
    expect(msg("en")).toBe(`Neutral framing not found: ${join(d.builtinDir, "en", "neutral.md")}`);
  });
  it("empty user frame", () => {
    const d = dirs();
    mkdirSync(d.userDir, { recursive: true });
    put(d.userDir, "neutral.md", "  ");
    const reason = (lang: Language) => at(lang, () => loadTemplates(d).errors.find((e) => e.file === "neutral.md")?.reason);
    expect(reason("ru")).toBe("файл пуст — используется встроенная нейтральная рамка");
    expect(reason("en")).toBe("file is empty — the built-in neutral framing is used");
  });
  it("built-in templates load without errors in en", () => {
    expect(at("en", () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: tmp() }).errors)).toEqual([]); // needs templates/en (change 64, task 2.1)
  });
});

describe("Core messages in the selected language: TemplateStoreError (the code does not depend on the language)", () => {
  const body = () => { const { id: _i, ...r } = tpl({ title: "Alpha" }); return r; };
  const both = (setup: () => () => unknown) => {
    const ru = at("ru", () => storeErr(setup()));
    const en = at("en", () => storeErr(setup()));
    expect(en.code).toBe(ru.code);
    expect(en.issues.map((i) => i.path)).toEqual(ru.issues.map((i) => i.path));
    expect(en.message).not.toBe(ru.message);
    return { ru, en };
  };
  it("invalid: message and reason for the automatic id", () => {
    const { ru, en } = both(() => { const d = dirs(); return () => createUserTemplate(d, { ...body(), id: "x" }); });
    expect([ru.message, ru.issues[0]!.message]).toEqual(["Шаблон не прошёл проверку.", "идентификатор задаётся автоматически"]);
    expect([en.message, en.issues[0]!.message]).toEqual(["The template failed validation.", "the identifier is assigned automatically"]);
  });
  it("bad_id", () => {
    const { ru, en } = both(() => { const d = dirs(); return () => deleteUserTemplate(d, "Bad Id"); });
    expect([ru.code, ru.message, en.message]).toEqual(["bad_id", "Недопустимый идентификатор шаблона.", "Invalid template identifier."]);
  });
  it("not_found with the same identifier", () => {
    const { ru, en } = both(() => { const d = dirs(); return () => saveUserTemplate(d, "ghost", body()); });
    expect([ru.code, ru.message, en.message]).toEqual(["not_found", "Шаблон «ghost» не найден.", "Template «ghost» not found."]);
  });
  it("builtin", () => {
    const { ru, en } = both(() => { const d = dirs(); put(d.builtinDir, "ru/a.json", tpl()); return () => deleteUserTemplate(d, "arch"); });
    expect([ru.code, ru.message, en.message]).toEqual(["builtin", "Встроенный шаблон нельзя удалить.", "A built-in template cannot be deleted."]);
  });
  it("ambiguous with the same files", () => {
    const { ru, en } = both(() => {
      const d = dirs();
      mkdirSync(d.userDir, { recursive: true });
      put(d.userDir, "a.json", tpl());
      put(d.userDir, "b.json", tpl());
      return () => deleteUserTemplate(d, "arch");
    });
    expect([ru.code, ru.message, en.message]).toEqual(["ambiguous", "Идентификатор «arch» занят несколькими файлами: a.json, b.json.", "The identifier «arch» is used by several files: a.json, b.json."]);
  });
  it("conflict: a folder sits where the template file should be", () => {
    const { ru, en } = both(() => { const d = dirs(); mkdirSync(join(d.userDir, "alpha.json"), { recursive: true }); return () => createUserTemplate(d, body()); });
    expect([ru.code, ru.message, en.message]).toEqual(["conflict", "alpha.json: файл с таким именем уже есть.", "alpha.json: a file with this name already exists."]);
  });
  it.skipIf(process.getuid?.() === 0)("io при записи: папка закрыта на запись", () => {
    const d = dirs();
    mkdirSync(d.userDir, { recursive: true });
    chmodSync(d.userDir, 0o500);
    try {
      const { ru, en } = both(() => () => createUserTemplate(d, body()));
      expect(ru.code).toBe("io");
      expect(ru.message).toMatch(/^alpha\.json: не удалось записать — /);
      expect(en.message).toMatch(/^alpha\.json: could not write — /);
    } finally { chmodSync(d.userDir, 0o700); }
  });
  it.skipIf(process.getuid?.() === 0)("io при удалении: папка закрыта на запись", () => {
    const d = dirs();
    mkdirSync(d.userDir, { recursive: true });
    put(d.userDir, "arch.json", tpl());
    chmodSync(d.userDir, 0o500);
    try {
      const { ru, en } = both(() => () => deleteUserTemplate(d, "arch"));
      expect(ru.code).toBe("io");
      expect(ru.message).toMatch(/^arch\.json: не удалось удалить — /);
      expect(en.message).toMatch(/^arch\.json: could not delete — /);
    } finally { chmodSync(d.userDir, 0o700); }
  });
  it.skipIf(process.getuid?.() === 0)("io при чтении папки", () => {
    const d = dirs();
    mkdirSync(d.userDir, { recursive: true });
    chmodSync(d.userDir, 0o000);
    try {
      const { ru, en } = both(() => () => deleteUserTemplate(d, "arch"));
      expect(ru.message).toMatch(/^templates: не удалось прочитать папку — /);
      expect(en.message).toMatch(/^templates: could not read the folder — /);
    } finally { chmodSync(d.userDir, 0o700); }
  });
});
