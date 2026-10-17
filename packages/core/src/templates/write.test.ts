import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { loadTemplates } from "./templates.ts";
import { TemplateStoreError, builtinTemplateIds, createUserTemplate, deleteUserTemplate, saveUserTemplate, takenTemplateIds } from "./write.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-w-")); tmps.push(d); return d; };
beforeAll(() => setProcessLanguage("ru"));
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const tpl = (over: Record<string, unknown> = {}) => ({
  id: "arch", title: "Архитектура", category: "Код", description: "Когда брать", exampleTopic: "Пример", framing: "Рамка", ...over,
});
const body = (over: Record<string, unknown> = {}) => { const { id, ...r } = tpl(over); return r; };
const put = (dir: string, file: string, v: unknown) => writeFileSync(join(dir, file), typeof v === "string" ? v : JSON.stringify(v));
const raw = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
function dirs() {
  const builtinDir = tmp();
  const ru = join(builtinDir, "ru");
  mkdirSync(ru);
  const userDir = join(tmp(), "templates");
  put(ru, "neutral.md", "Нейтральная");
  return { builtinDir, ru, userDir };
}
const codeOf = (f: () => unknown) => { try { f(); } catch (e) { if (e instanceof TemplateStoreError) return e; throw e; } throw new Error("ожидалась ошибка"); };
const root = process.getuid?.() === 0;

describe("createUserTemplate", () => {
  it("creates the file, format and key order", () => {
    const d = dirs();
    const t = createUserTemplate(d, body({ title: "Ретроспектива спринта" }));
    expect(t.id).toBe("retrospektiva-sprinta");
    const text = raw(d.userDir, "retrospektiva-sprinta.json");
    expect(Object.keys(JSON.parse(text))).toEqual(["id", "title", "category", "description", "exampleTopic", "framing", "roles"]);
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    expect(loadTemplates(d).templates[0]).toMatchObject({ id: t.id, source: "user", file: "retrospektiva-sprinta.json", roles: [] });
  });
  it("only set limits are written; 21 rounds are kept", () => {
    const d = dirs();
    const t = createUserTemplate(d, body({ limits: { maxRounds: 21 } }));
    expect(JSON.parse(raw(d.userDir, `${t.id}.json`)).limits).toEqual({ maxRounds: 21 });
  });
  it("same titles are different files, the first one untouched", () => {
    const d = dirs();
    const a = createUserTemplate(d, body({ title: "Тест" }));
    const before = raw(d.userDir, `${a.id}.json`);
    const b = createUserTemplate(d, body({ title: "Тест" }));
    expect([a.id, b.id]).toEqual(["test", "test-2"]);
    expect(raw(d.userDir, "test.json")).toBe(before);
  });
  it("taken identifiers are not issued", () => {
    const d = dirs();
    mkdirSync(d.userDir);
    put(d.ru, "b.json", tpl({ id: "one" }));
    put(d.userDir, "o.json", tpl({ id: "one" }));
    put(d.userDir, "dup.json", tpl({ id: "one" }));
    put(d.userDir, "broken.json", "мусор");
    expect([...takenTemplateIds(d)].sort()).toEqual(["broken", "dup", "o", "one"]);
    expect(createUserTemplate(d, body({ title: "One" })).id).toBe("one-2");
    expect(createUserTemplate(d, body({ title: "Broken" })).id).toBe("broken-2");
    expect(raw(d.userDir, "broken.json")).toBe("мусор");
  });
  it("invalid: no paths and no files", () => {
    const d = dirs();
    const { framing, ...noFraming } = body();
    const cases: [unknown, string][] = [[noFraming, "framing"], [body({ foo: 1 }), "foo"], [tpl(), "id"], [body({ title: "  " }), "title"], ["строка", "(корень)"]];
    for (const [input, path] of cases) {
      const e = codeOf(() => createUserTemplate(d, input));
      expect(e.code).toBe("invalid");
      expect(e.issues.map((i) => i.path)).toContain(path);
    }
    expect(existsSync(d.userDir)).toBe(false);
  });
  it("creates a missing folder", () => {
    const d = dirs();
    createUserTemplate(d, body());
    expect(readdirSync(d.userDir)).toEqual(["arhitektura.json"]);
  });
  it.skipIf(root)("io: нет прав, временных файлов нет", () => {
    const d = dirs();
    mkdirSync(d.userDir);
    chmodSync(d.userDir, 0o555);
    try {
      expect(codeOf(() => createUserTemplate(d, body())).code).toBe("io");
    } finally {
      chmodSync(d.userDir, 0o755);
    }
    expect(readdirSync(d.userDir)).toEqual([]);
  });
});

describe("saveUserTemplate", () => {
  it("replaces a file with another name, id unchanged", () => {
    const d = dirs();
    mkdirSync(d.userDir);
    put(d.userDir, "own.json", tpl({ id: "my-tpl" }));
    const t = saveUserTemplate(d, "my-tpl", body({ title: "Новое" }));
    expect(t).toMatchObject({ id: "my-tpl", title: "Новое" });
    expect(JSON.parse(raw(d.userDir, "own.json"))).toMatchObject({ id: "my-tpl", title: "Новое" });
    expect(readdirSync(d.userDir)).toEqual(["own.json"]);
  });
  it("built-in: an override is created", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl());
    const before = raw(d.ru, "a.json");
    saveUserTemplate(d, "arch", body({ title: "Моё" }));
    expect(raw(d.ru, "a.json")).toBe(before);
    expect(loadTemplates(d).templates[0]).toMatchObject({ id: "arch", title: "Моё", source: "user" });
  });
  it("name conflict on override, broken file left intact", () => {
    const d = dirs();
    mkdirSync(d.userDir);
    put(d.ru, "a.json", tpl());
    put(d.userDir, "arch.json", "мусор");
    expect(codeOf(() => saveUserTemplate(d, "arch", body())).code).toBe("conflict");
    expect(raw(d.userDir, "arch.json")).toBe("мусор");
    expect(readdirSync(d.userDir)).toEqual(["arch.json"]);
  });
  it("duplicate in the user folder: ambiguous", () => {
    const d = dirs();
    mkdirSync(d.userDir);
    put(d.userDir, "a.json", tpl());
    put(d.userDir, "b.json", tpl());
    const e = codeOf(() => saveUserTemplate(d, "arch", body()));
    expect(e.code).toBe("ambiguous");
    expect(e.message).toContain("a.json");
    expect(codeOf(() => deleteUserTemplate(d, "arch")).code).toBe("ambiguous");
    expect(readdirSync(d.userDir)).toEqual(["a.json", "b.json"]);
    expect(raw(d.userDir, "a.json")).toBe(JSON.stringify(tpl()));
  });
  it("not_found and invalid", () => {
    const d = dirs();
    expect(codeOf(() => saveUserTemplate(d, "nope", body())).code).toBe("not_found");
    expect(codeOf(() => saveUserTemplate(d, "nope", tpl())).code).toBe("invalid");
  });
  it.skipIf(root)("io: прежний файл цел", () => {
    const d = dirs();
    mkdirSync(d.userDir);
    put(d.userDir, "arch.json", tpl());
    chmodSync(d.userDir, 0o555);
    try {
      expect(codeOf(() => saveUserTemplate(d, "arch", body({ title: "Х" }))).code).toBe("io");
    } finally {
      chmodSync(d.userDir, 0o755);
    }
    expect(raw(d.userDir, "arch.json")).toBe(JSON.stringify(tpl()));
    expect(readdirSync(d.userDir)).toEqual(["arch.json"]);
  });
});

describe("deleteUserTemplate", () => {
  it("deletes only the target; resets the override", () => {
    const d = dirs();
    mkdirSync(d.userDir);
    put(d.ru, "a.json", tpl({ title: "Встроенный" }));
    put(d.userDir, "arch.json", tpl({ title: "Моё" }));
    put(d.userDir, "other.json", tpl({ id: "other" }));
    deleteUserTemplate(d, "arch");
    expect(readdirSync(d.userDir)).toEqual(["other.json"]);
    expect(loadTemplates(d).templates.find((t) => t.id === "arch")).toMatchObject({ title: "Встроенный", source: "builtin" });
  });
  it("builtin and not_found", () => {
    const d = dirs();
    put(d.ru, "a.json", tpl());
    expect(codeOf(() => deleteUserTemplate(d, "arch")).code).toBe("builtin");
    expect(codeOf(() => deleteUserTemplate(d, "nope")).code).toBe("not_found");
    expect(existsSync(join(d.ru, "a.json"))).toBe(true);
  });
  it.skipIf(root)("io: файл на месте", () => {
    const d = dirs();
    mkdirSync(d.userDir);
    put(d.userDir, "arch.json", tpl());
    chmodSync(d.userDir, 0o555);
    try {
      expect(codeOf(() => deleteUserTemplate(d, "arch")).code).toBe("io");
    } finally {
      chmodSync(d.userDir, 0o755);
    }
    expect(readdirSync(d.userDir)).toEqual(["arch.json"]);
  });
});

it("bad_id: disk untouched", () => {
  const d = dirs();
  const outside = join(d.userDir, "..", "x.json");
  put(d.ru, "a.json", tpl());
  for (const id of ["../x", "a/b", "", "..", "Arch", 5 as unknown as string]) {
    expect(codeOf(() => saveUserTemplate(d, id, body())).code).toBe("bad_id");
    expect(codeOf(() => deleteUserTemplate(d, id)).code).toBe("bad_id");
  }
  expect(existsSync(d.userDir)).toBe(false);
  expect(existsSync(outside)).toBe(false);
  expect(readdirSync(d.ru).sort()).toEqual(["a.json", "neutral.md"]);
});

it("builtinTemplateIds: only built-in, including overridden ones", () => {
  const d = dirs();
  expect(builtinTemplateIds({ ...d, builtinDir: join(d.builtinDir, "нет") }).size).toBe(0);
  put(d.ru, "a.json", tpl());
  put(d.ru, "bad.json", "мусор");
  const own = createUserTemplate(d, body({ title: "Своё" }));
  expect([...builtinTemplateIds(d)]).toEqual(["arch"]);
  saveUserTemplate(d, "arch", body({ title: "Перекрытие" }));
  expect(builtinTemplateIds(d).has("arch")).toBe(true);
  expect(builtinTemplateIds(d).has(own.id)).toBe(false);
});

it("built-in identifiers and taken ids come from the language folder; another language is not visible", () => {
  const d = dirs();
  const en = join(d.builtinDir, "en");
  mkdirSync(en);
  put(en, "e.json", tpl({ id: "only-en" }));
  put(d.ru, "a.json", tpl());
  expect([...builtinTemplateIds({ ...d, language: "en" })]).toEqual(["only-en"]);
  expect([...builtinTemplateIds({ ...d, language: "ru" })]).toEqual(["arch"]);
  expect([...builtinTemplateIds(d)]).toEqual(["arch"]); // default is the process language (ru)
  expect([...takenTemplateIds({ ...d, language: "en" })]).toEqual(["only-en"]);
  // built-in en cannot be deleted as its own, and there are no ru-style ids in en
  expect(codeOf(() => deleteUserTemplate({ ...d, language: "en" }, "only-en")).code).toBe("builtin");
});
