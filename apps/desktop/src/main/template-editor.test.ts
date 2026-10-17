import { setProcessLanguage } from "@model-council/core/i18n";
import { chmodSync, existsSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTemplates } from "@model-council/core";
import { createTemplateEditor } from "./template-editor.ts";

let root: string;
let builtinRoot: string; // root of the sets; files of the Russian set are in builtinDir
let builtinDir: string;
let userDir: string;
const logger = { info: vi.fn(), error: vi.fn() };
const dirs = () => ({ builtinDir: builtinRoot, userDir });
const ed = () => createTemplateEditor({ dirs, logger, sessionFraming: (id) => (id === "s1" ? "SESSION-FRAMING" : null) });
const tpl = (id: string, o: Record<string, unknown> = {}) => ({
  id, title: `Шаблон ${id}`, category: "Кат", description: "d", exampleTopic: "t", framing: `SECRET-FRAMING-${id}`, roles: ["А"], limits: { maxRounds: 3 }, ...o,
});
const put = (dir: string, file: string, body: unknown) => writeFileSync(join(dir, file), typeof body === "string" ? body : JSON.stringify(body));
const draft = (o: Record<string, unknown> = {}) => {
  const { id: _id, ...rest } = tpl("x", o);
  return rest;
};
const read = (dir: string, file: string) => readFileSync(join(dir, file));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "council-tpl-ed-"));
  builtinRoot = join(root, "builtin");
  builtinDir = join(builtinRoot, "ru");
  userDir = join(root, "user");
  mkdirSync(builtinDir, { recursive: true });
  symlinkSync(builtinDir, join(builtinRoot, "en")); // by default both languages read the same fixture
  mkdirSync(userDir);
  writeFileSync(join(builtinDir, "neutral.md"), "NEUTRAL-FRAMING");
  put(builtinDir, "b1.json", tpl("b1", { category: "Яблоко" }));
  put(builtinDir, "b2.json", tpl("b2", { category: "Арбуз" }));
  vi.clearAllMocks();
});
afterEach(() => {
  chmodSync(userDir, 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe("open", () => {
  it("new: fields empty except the neutral frame; categories alphabetical, taken ids", () => {
    put(userDir, "mine.json", tpl("mine", { category: "Бета" }));
    const r = ed().open({ mode: "new" });
    expect(r).toMatchObject({ id: null, origin: "new", draft: { title: "", category: "", description: "", exampleTopic: "", framing: "NEUTRAL-FRAMING", roles: [], limits: {} } });
    expect(r.categories).toEqual(["Арбуз", "Бета", "Яблоко"]);
    expect(r.takenIds).toEqual(["b1", "b2", "mine"]);
  });

  it("edit: built-in, own, overridden", () => {
    put(userDir, "mine.json", tpl("mine"));
    put(userDir, "over.json", tpl("b2", { title: "Мой b2" }));
    expect(ed().open({ mode: "edit", id: "b1" })).toMatchObject({ id: "b1", origin: "builtin", draft: { limits: { maxRounds: 3 } } });
    expect(ed().open({ mode: "edit", id: "mine" }).origin).toBe("user");
    expect(ed().open({ mode: "edit", id: "b2" })).toMatchObject({ origin: "modified", draft: { title: "Мой b2" } });
  });

  it("duplicate: a copy without an id", () => {
    expect(ed().open({ mode: "duplicate", id: "b1" })).toMatchObject({ id: null, origin: "new", draft: { title: "Шаблон b1 (копия)", framing: "SECRET-FRAMING-b1" } });
  });

  it("snapshot: the template frame or the neutral one", () => {
    expect(ed().open({ mode: "snapshot", templateId: "b1" }).draft).toMatchObject({ framing: "SECRET-FRAMING-b1", category: "Яблоко", title: "", roles: [] });
    expect(ed().open({ mode: "snapshot", templateId: null }).draft).toMatchObject({ framing: "NEUTRAL-FRAMING", category: "" });
  });

  it("snapshot with framingFrom: the session frame, the template category", () => {
    expect(ed().open({ mode: "snapshot", templateId: "b1", framingFrom: "s1" }).draft).toMatchObject({ framing: "SESSION-FRAMING", category: "Яблоко" });
    expect(ed().open({ mode: "snapshot", templateId: null, framingFrom: "s1" }).draft).toMatchObject({ framing: "SESSION-FRAMING", category: "" });
    expect(() => ed().open({ mode: "snapshot", templateId: null, framingFrom: "s2" })).toThrow("Прошлая сессия s2 не найдена: рамку взять неоткуда.");
    expect(() => ed().open({ mode: "snapshot", templateId: null, framingFrom: 5 })).toThrow("Некорректный запрос");
  });

  it("errors: unknown id, wrong mode, path", () => {
    expect(() => ed().open({ mode: "edit", id: "nope" })).toThrow("Шаблон «nope» не найден.");
    expect(() => ed().open({ mode: "snapshot", templateId: "nope" })).toThrow("не найден");
    expect(() => ed().open({ mode: "zzz" })).toThrow();
    expect(() => ed().open("x")).toThrow();
    expect(() => ed().open({ mode: "edit", id: "../x" })).toThrow("не найден");
    expect(() => ed().open({ mode: "duplicate", id: 5 })).toThrow("не найден");
  });
});

describe("create", () => {
  it("success: file, log, without a frame", () => {
    const r = ed().create(draft({ title: "Новый шаблон" }));
    expect(r).toEqual({ ok: true, id: "novyy-shablon" });
    expect(existsSync(join(userDir, "novyy-shablon.json"))).toBe(true);
    expect(logger.info).toHaveBeenCalledWith("Template novyy-shablon created");
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("SECRET-FRAMING");
  });

  it("invalid draft: issues, no files", () => {
    const r = ed().create(draft({ title: "", framing: "SECRET-FRAMING-bad" }));
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.every((i) => typeof i.path === "string")).toBe(true);
    expect(readdirSync(userDir)).toEqual([]);
    expect(JSON.stringify(r) + JSON.stringify(logger.error.mock.calls)).not.toContain("SECRET-FRAMING");
  });
});

describe("save", () => {
  it("own template in a file with another name", () => {
    put(userDir, "any-name.json", tpl("mine"));
    expect(ed().save("mine", draft({ title: "Новое" }))).toEqual({ ok: true, id: "mine" });
    expect(readdirSync(userDir)).toEqual(["any-name.json"]);
    expect(loadTemplates(dirs()).templates.find((t) => t.id === "mine")!.title).toBe("Новое");
    expect(logger.info).toHaveBeenCalledWith("Template mine saved");
  });

  it("built-in: an override is created, the original is intact", () => {
    const before = read(builtinDir, "b1.json");
    expect(ed().save("b1", draft({ title: "Своё" }))).toEqual({ ok: true, id: "b1" });
    expect(read(builtinDir, "b1.json").equals(before)).toBe(true);
    expect(loadTemplates(dirs()).templates.find((t) => t.id === "b1")).toMatchObject({ source: "user", title: "Своё" });
  });

  it("a duplicate identifier is rejected, files intact", () => {
    put(userDir, "a.json", tpl("dup"));
    put(userDir, "b.json", tpl("dup"));
    const [a, b] = [read(userDir, "a.json"), read(userDir, "b.json")];
    const r = ed().save("dup", draft());
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("a.json") });
    expect(read(userDir, "a.json").equals(a) && read(userDir, "b.json").equals(b)).toBe(true);
  });

  it("unknown id and path", () => {
    expect(ed().save("nope", draft())).toEqual({ ok: false, error: "Шаблон «nope» не найден.", issues: [] });
    expect(ed().save("../evil", draft())).toMatchObject({ ok: false });
    expect(ed().save(5, draft())).toMatchObject({ ok: false });
    expect(readdirSync(root).sort()).toEqual(["builtin", "user"]);
    expect(readdirSync(userDir)).toEqual([]);
  });

  it("write failure: the environment key does not get into the result and log", () => {
    if (process.getuid?.() === 0) return;
    process.env["TEST_SECRET_KEY"] = "sk-test-12345";
    try {
      chmodSync(userDir, 0o555);
      const r = ed().create(draft({ title: "Сбой" }));
      expect(r).toMatchObject({ ok: false });
      expect(JSON.stringify(r) + JSON.stringify(logger.info.mock.calls) + JSON.stringify(logger.error.mock.calls)).not.toContain("sk-test-12345");
      expect(JSON.stringify(r)).not.toContain(root);
    } finally {
      delete process.env["TEST_SECRET_KEY"];
    }
  });
});

describe("remove", () => {
  it("delete of an own one", () => {
    put(userDir, "mine.json", tpl("mine"));
    ed().remove("mine", "delete");
    expect(readdirSync(userDir)).toEqual([]);
    expect(logger.info).toHaveBeenCalled();
  });

  it("a built-in without an override is not deleted in any mode", () => {
    expect(() => ed().remove("b1", "delete")).toThrow("Встроенный шаблон нельзя удалить.");
    expect(() => ed().remove("b1", "reset")).toThrow("Встроенный шаблон нельзя удалить.");
    expect(existsSync(join(builtinDir, "b1.json"))).toBe(true);
  });

  it("reset of an override returns the built-in", () => {
    put(userDir, "b1.json", tpl("b1", { title: "Своё" }));
    ed().remove("b1", "reset");
    expect(readdirSync(userDir)).toEqual([]);
    expect(loadTemplates(dirs()).templates.find((t) => t.id === "b1")!.source).toBe("builtin");
  });

  it("reset of an own one — an error", () => {
    put(userDir, "mine.json", tpl("mine"));
    expect(() => ed().remove("mine", "reset")).toThrow("Сбросить можно только изменённый встроенный шаблон.");
    expect(existsSync(join(userDir, "mine.json"))).toBe(true);
  });

  it("duplicate: an error with file names, files intact", () => {
    put(userDir, "a.json", tpl("dup"));
    put(userDir, "b.json", tpl("dup"));
    expect(() => ed().remove("dup", "delete")).toThrow(/a\.json/);
    expect(readdirSync(userDir).sort()).toEqual(["a.json", "b.json"]);
  });

  it("wrong mode, path, unknown", () => {
    put(userDir, "mine.json", tpl("mine"));
    expect(() => ed().remove("mine", "wipe")).toThrow();
    expect(() => ed().remove("../mine", "delete")).toThrow("не найден");
    expect(() => ed().remove("nope", "delete")).toThrow("не найден");
    expect(readdirSync(userDir)).toEqual(["mine.json"]);
  });
});

describe("corrupted file in the user folder", () => {
  it("does not interfere and stays as it was", () => {
    put(userDir, "bad.json", "{не json");
    put(userDir, "mine.json", tpl("mine"));
    const bad = read(userDir, "bad.json");
    expect(ed().open({ mode: "edit", id: "mine" }).id).toBe("mine");
    expect(ed().create(draft({ title: "Ещё" }))).toMatchObject({ ok: true });
    expect(ed().save("mine", draft({ title: "Правка" }))).toMatchObject({ ok: true });
    expect(read(userDir, "bad.json").equals(bad)).toBe(true);
  });
});

describe("template editor: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const cyr = /[А-Яа-яЁё]/;
  const msg = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return "no error"; };

  it("open refusals at en, then at ru by the same editor", () => {
    const e = ed();
    const cases: [() => unknown, string, string][] = [
      [() => e.open({ mode: "edit", id: "nope" }), "Template “nope” not found.", "Шаблон «nope» не найден."],
      [() => e.open("x"), "Invalid request: the request must be an object.", "Некорректный запрос: запрос — объект."],
      [() => e.open({ mode: "snapshot", templateId: null, framingFrom: 5 }), "Invalid request: framingFrom must be a string.", "Некорректный запрос: framingFrom — строка."],
      [() => e.open({ mode: "snapshot", templateId: null, framingFrom: "zz" }), "The previous session zz was not found: there is no framing to take.", "Прошлая сессия zz не найдена: рамку взять неоткуда."],
      [() => e.open({ mode: "wat" }), "Invalid request: unknown editor mode.", "Некорректный запрос: неизвестный режим редактора."],
    ];
    for (const [f, en, ru] of cases) {
      setProcessLanguage("en");
      const m = msg(f);
      expect(m).toBe(en);
      expect(m).not.toMatch(cyr);
      setProcessLanguage("ru");
      expect(msg(f)).toBe(ru);
    }
  });

  it("save of a foreign id: refusal in the process language, files unchanged", () => {
    put(userDir, "mine.json", tpl("mine"));
    const before = read(userDir, "mine.json");
    setProcessLanguage("en");
    expect(ed().save("nope", draft())).toEqual({ ok: false, error: "Template “nope” not found.", issues: [] });
    setProcessLanguage("ru");
    expect(ed().save("nope", draft())).toEqual({ ok: false, error: "Шаблон «nope» не найден.", issues: [] });
    expect(read(userDir, "mine.json")).toEqual(before);
  });

  it("remove: built-in, reset of a non-override, wrong mode; files unchanged", () => {
    put(userDir, "mine.json", tpl("mine"));
    const before = read(userDir, "mine.json");
    const e = ed();
    setProcessLanguage("en");
    expect(msg(() => e.remove("b1", "delete"))).toBe("A built-in template cannot be deleted.");
    expect(msg(() => e.remove("mine", "reset"))).toBe("Only a modified built-in template can be reset.");
    expect(msg(() => e.remove("mine", "wipe"))).toBe("Invalid request: mode must be delete or reset.");
    setProcessLanguage("ru");
    expect(msg(() => e.remove("b1", "delete"))).toBe("Встроенный шаблон нельзя удалить.");
    expect(msg(() => e.remove("mine", "reset"))).toBe("Сбросить можно только изменённый встроенный шаблон.");
    expect(msg(() => e.remove("mine", "wipe"))).toBe("Некорректный запрос: режим — delete или reset.");
    expect(read(userDir, "mine.json")).toEqual(before);
    expect(existsSync(join(builtinDir, "b1.json"))).toBe(true);
  });

  it("copy: at en \"(copy)\", at ru the Russian suffix, the original name does not change, and reading does not recompute", () => {
    const e = ed();
    const before = read(builtinDir, "b1.json");
    setProcessLanguage("en");
    expect(e.open({ mode: "duplicate", id: "b1" })).toMatchObject({ draft: { title: "Шаблон b1 (copy)" } });
    setProcessLanguage("ru");
    expect(e.open({ mode: "duplicate", id: "b1" })).toMatchObject({ draft: { title: "Шаблон b1 (копия)" } });
    expect(read(builtinDir, "b1.json")).toEqual(before);
    // the created copy keeps the suffix of the creation language; opening in another language does not change it
    setProcessLanguage("en");
    const copy = (e.open({ mode: "duplicate", id: "b1" }) as unknown as { draft: Record<string, unknown> }).draft;
    const r = e.create(copy);
    expect(r.ok).toBe(true);
    setProcessLanguage("ru");
    expect(e.open({ mode: "edit", id: (r as { id: string }).id })).toMatchObject({ draft: { title: "Шаблон b1 (copy)" } });
  });
});

describe("template editor: the set of the current language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const enSet = () => {
    rmSync(join(builtinRoot, "en"));
    mkdirSync(join(builtinRoot, "en"));
    writeFileSync(join(builtinRoot, "en", "neutral.md"), "EN-NEUTRAL");
    put(join(builtinRoot, "en"), "b1.json", tpl("b1", { title: "Template b1", framing: "EN-FRAMING-b1" }));
  };
  const draftOf = (r: unknown) => (r as { draft: { title: string; framing: string } }).draft;

  it("\"Duplicate\" of a built-in without an override gives the variant of the current language", () => {
    enSet();
    const e = ed();
    setProcessLanguage("en");
    expect(draftOf(e.open({ mode: "duplicate", id: "b1" }))).toMatchObject({ title: "Template b1 (copy)", framing: "EN-FRAMING-b1" });
    setProcessLanguage("ru");
    expect(draftOf(e.open({ mode: "duplicate", id: "b1" }))).toMatchObject({ title: "Шаблон b1 (копия)", framing: "SECRET-FRAMING-b1" });
  });

  it("\"Duplicate\" of an overridden template takes the user variant in any language", () => {
    enSet();
    put(userDir, "b1.json", tpl("b1", { title: "Мой b1", framing: "USER-FRAMING" }));
    const e = ed();
    setProcessLanguage("en");
    expect(draftOf(e.open({ mode: "duplicate", id: "b1" }))).toMatchObject({ title: "Мой b1 (copy)", framing: "USER-FRAMING" });
    rmSync(join(userDir, "b1.json"));
  });

  it("\"Reset to built-in\" returns the variant of the current language", () => {
    enSet();
    put(userDir, "b1.json", tpl("b1", { title: "Мой b1" }));
    const e = ed();
    setProcessLanguage("en");
    e.remove("b1", "reset");
    expect(existsSync(join(userDir, "b1.json"))).toBe(false);
    expect(draftOf(e.open({ mode: "edit", id: "b1" }))).toMatchObject({ title: "Template b1" });
  });

  it("a new template without a sample starts with the neutral frame of the current language; categories are language data", () => {
    enSet();
    const e = ed();
    setProcessLanguage("en");
    expect(draftOf(e.open({ mode: "snapshot", templateId: null }))).toMatchObject({ framing: "EN-NEUTRAL" });
    expect(draftOf(e.open({ mode: "snapshot", templateId: null }))).not.toMatchObject({ framing: "NEUTRAL-FRAMING" });
    setProcessLanguage("ru");
    expect(draftOf(e.open({ mode: "snapshot", templateId: null }))).toMatchObject({ framing: "NEUTRAL-FRAMING" });
  });

  it("\"New template\" starts with the neutral frame: the user one, otherwise the built-in one of the current language", () => {
    enSet();
    const e = ed();
    setProcessLanguage("en");
    expect(draftOf(e.open({ mode: "new" }))).toMatchObject({ title: "", framing: "EN-NEUTRAL" });
    setProcessLanguage("ru");
    expect(draftOf(e.open({ mode: "new" }))).toMatchObject({ title: "", framing: "NEUTRAL-FRAMING" });
    writeFileSync(join(userDir, "neutral.md"), "USER-NEUTRAL");
    setProcessLanguage("en");
    expect(draftOf(e.open({ mode: "new" }))).toMatchObject({ framing: "USER-NEUTRAL" });
    setProcessLanguage("ru");
    expect(draftOf(e.open({ mode: "new" }))).toMatchObject({ framing: "USER-NEUTRAL" });
  });
});
