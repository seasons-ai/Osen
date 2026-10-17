import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { TemplateDraft, TemplateEditorData } from "../../shared/setup.ts";
import { NEW_CATEGORY, checkEditor, initialEditor, reduceEditor, toDraft } from "./template-editor.ts";
import type { EditorAction, EditorForm } from "./template-editor.ts";

const draft = (o: Partial<TemplateDraft> = {}): TemplateDraft => ({
  title: "Ретроспектива спринта", category: "Мои шаблоны", description: "Описание", exampleTopic: "Пример", framing: "Рамка",
  roles: ["Ведущий", "Скептик", "Практик"], limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 9000 }, ...o
});
const data = (o: Partial<TemplateEditorData> = {}): TemplateEditorData => ({
  id: "retro", origin: "user", draft: draft(), categories: ["Продукт", "Мои шаблоны"], takenIds: [], ...o
});
const empty = (o: Partial<TemplateEditorData> = {}) =>
  data({ id: null, origin: "new", draft: draft({ title: "", category: "", description: "", exampleTopic: "", framing: "", roles: [], limits: {} }), ...o });
const run = (f: EditorForm, ...a: EditorAction[]) => a.reduce(reduceEditor, f);
const form = (o: Partial<EditorForm> = {}): EditorForm => ({ ...initialEditor(data()), ...o });
const limits = (o: Partial<EditorForm["limits"]>) => form({ limits: { maxRounds: "", turnTimeoutSec: "", contextChars: "", ...o } });

describe("initialEditor", () => {
  it("full template", () => {
    const f = initialEditor(data());
    expect(f).toMatchObject({ title: "Ретроспектива спринта", categoryChoice: "Мои шаблоны", newCategory: "", description: "Описание", exampleTopic: "Пример", framing: "Рамка" });
    expect(f.roles).toEqual([{ key: 1, text: "Ведущий" }, { key: 2, text: "Скептик" }, { key: 3, text: "Практик" }]);
    expect(f.nextKey).toBe(4);
    expect(f.limits).toEqual({ maxRounds: "3", turnTimeoutSec: "60", contextChars: "9000" });
  });
  it("new empty: no category selected, limits empty", () => {
    const f = initialEditor(empty());
    expect(f.categoryChoice).toBe("");
    expect(f.newCategory).toBe("");
    expect(f.roles).toEqual([]);
    expect(f.limits).toEqual({ maxRounds: "", turnTimeoutSec: "", contextChars: "" });
  });
  it("category outside the list", () => {
    const f = initialEditor(data({ draft: draft({ category: "Команда" }) }));
    expect(f.categoryChoice).toBe(NEW_CATEGORY);
    expect(f.newCategory).toBe("Команда");
  });
  it("empty category list", () => {
    const f = initialEditor(empty({ categories: [] }));
    expect(f.categoryChoice).toBe(NEW_CATEGORY);
    expect(f.newCategory).toBe("");
  });
});

describe("empty category", () => {
  it("error while not selected; disappears after selection", () => {
    const d = empty();
    const f = { ...initialEditor(d), title: "T", description: "d", exampleTopic: "e", framing: "f" };
    expect(toDraft(f).category).toBe("");
    const c = checkEditor(f, d);
    expect(c.errors.category).toBe("Категория обязательна");
    expect(c.canSave).toBe(false);
    expect(checkEditor(reduceEditor(f, { type: "category", value: "Продукт" }), d).errors.category).toBeUndefined();
  });
  it("a snapshot with an empty category behaves the same", () => {
    const d = data({ draft: draft({ category: "" }) });
    const f = initialEditor(d);
    expect(f.categoryChoice).toBe("");
    expect(checkEditor(f, d).errors.category).toBe("Категория обязательна");
  });
});

describe("reduceEditor", () => {
  it("text, category, limit", () => {
    const f = run(form(), { type: "text", field: "title", value: "X" }, { type: "category", value: NEW_CATEGORY }, { type: "text", field: "newCategory", value: "К" }, { type: "limit", field: "maxRounds", value: "5" });
    expect(f).toMatchObject({ title: "X", categoryChoice: NEW_CATEGORY, newCategory: "К" });
    expect(f.limits.maxRounds).toBe("5");
  });
  it("adding a role at the end with a new key", () => {
    const f = run(form(), { type: "role-add" });
    expect(f.roles.at(-1)).toEqual({ key: 4, text: "" });
    expect(f.nextKey).toBe(5);
  });
  it("editing a role and deleting by key", () => {
    const f = run(form(), { type: "role-text", key: 2, value: "Критик" }, { type: "role-remove", key: 1 });
    expect(f.roles.map((r) => r.text)).toEqual(["Критик", "Практик"]);
  });
  it("reordering and bounds", () => {
    const f = form();
    expect(run(f, { type: "role-move", key: 2, delta: -1 }).roles.map((r) => r.key)).toEqual([2, 1, 3]);
    expect(run(f, { type: "role-move", key: 2, delta: 1 }).roles.map((r) => r.key)).toEqual([1, 3, 2]);
    expect(run(f, { type: "role-move", key: 1, delta: -1 })).toBe(f);
    expect(run(f, { type: "role-move", key: 3, delta: 1 })).toBe(f);
  });
});

describe("toDraft", () => {
  it("empty limits are absent", () => {
    expect(toDraft(limits({ maxRounds: "  " })).limits).toEqual({});
  });
  it("numbers and non-numbers", () => {
    expect(toDraft(limits({ maxRounds: "21" })).limits.maxRounds).toBe(21);
    expect(toDraft(limits({ maxRounds: "0" })).limits.maxRounds).toBe(0);
    expect(toDraft(limits({ maxRounds: "1.5" })).limits.maxRounds).toBe(1.5);
    expect(toDraft(limits({ maxRounds: "abc" })).limits.maxRounds).toBeNaN();
  });
  it("empty roles stay in place", () => {
    const f = form({ roles: [{ key: 1, text: "a" }, { key: 2, text: "" }, { key: 3, text: "c" }] });
    expect(toDraft(f).roles).toEqual(["a", "", "c"]);
  });
  it("new category", () => {
    expect(toDraft(form({ categoryChoice: NEW_CATEGORY, newCategory: "Команда" })).category).toBe("Команда");
    expect(toDraft(form()).category).toBe("Мои шаблоны");
  });
});

describe("checkEditor", () => {
  it("full template without errors", () => {
    const c = checkEditor(form(), data());
    expect(c.errors).toEqual({});
    expect(c.roleErrors).toEqual({});
    expect(c.canSave).toBe(true);
  });
  it("name of spaces", () => {
    const c = checkEditor(form({ title: "   " }), data());
    expect(c.errors.title).toBe("Название обязательно");
    expect(c.canSave).toBe(false);
  });
  it("empty frame", () => {
    expect(checkEditor(form({ framing: "" }), data()).errors.framing).toBe("Рамка обязательна");
  });
  it("other texts", () => {
    const c = checkEditor(form({ description: "", exampleTopic: "" }), data());
    expect(c.errors.description).toBe("Описание обязательно");
    expect(c.errors.exampleTopic).toBe("Пример темы обязателен");
  });
  it("empty role between non-empty ones", () => {
    const f = form({ roles: [{ key: 7, text: "a" }, { key: 9, text: " " }, { key: 8, text: "c" }] });
    const c = checkEditor(f, data());
    expect(Object.keys(c.roleErrors)).toEqual(["9"]);
    expect(c.roleErrors[9]).toContain("Роль не может быть пустой");
    expect(f.roles.map((r) => r.key)).toEqual([7, 9, 8]);
  });
  it.each(["0", "1.5", "-1", "abc"])("limit %s — error", (v) => {
    const c = checkEditor(limits({ maxRounds: v }), data());
    expect(c.errors.maxRounds).toBe("Целое число не меньше 1");
    expect(c.canSave).toBe(false);
  });
  it("limit 21 is allowed", () => {
    expect(checkEditor(limits({ maxRounds: "21" }), data()).errors.maxRounds).toBeUndefined();
  });
  it("empty new category", () => {
    const c = checkEditor(form({ categoryChoice: NEW_CATEGORY, newCategory: "" }), data());
    expect(c.errors.category).toBe("Категория обязательна");
  });
  it("empty roles and limits are allowed", () => {
    expect(checkEditor(form({ roles: [], limits: { maxRounds: "", turnTimeoutSec: "", contextChars: "" } }), data()).canSave).toBe(true);
  });
  it("previewId: an existing one does not depend on the name", () => {
    expect(checkEditor(form({ title: "Другое" }), data()).previewId).toBe("retro");
  });
  it("previewId: a new one from the name, taking busy ones into account", () => {
    const d = empty({ takenIds: [] });
    const f = { ...initialEditor(d), title: "Ретроспектива спринта" };
    const id = checkEditor(f, d).previewId;
    expect(id).toBe("retrospektiva-sprinta");
    expect(checkEditor(f, empty({ takenIds: [id!] })).previewId).toBe(`${id}-2`);
  });
  it("previewId: empty name — null", () => {
    expect(checkEditor(initialEditor(empty()), empty()).previewId).toBeNull();
  });
});

describe("checkEditor: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const bad = () => ({ ...initialEditor(empty()), roles: [{ key: 1, text: " " }], limits: { maxRounds: "0", turnTimeoutSec: "x", contextChars: "-2" } });
  const keys = (r: ReturnType<typeof checkEditor>) => [Object.keys(r.errors).sort(), Object.keys(r.roleErrors)];

  it("en: exact texts of all errors, the same fields as in ru", () => {
    const ru = checkEditor(bad(), empty(), "ru");
    const en = checkEditor(bad(), empty(), "en");
    expect(keys(en)).toEqual(keys(ru));
    expect(en.errors).toEqual({
      title: "Title is required", category: "Category is required", description: "Description is required",
      exampleTopic: "Example topic is required", framing: "Framing is required",
      maxRounds: "An integer of 1 or more", turnTimeoutSec: "An integer from 1 to 2147483", contextChars: "An integer of 1 or more"
    });
    expect(en.roleErrors).toEqual({ 1: "A role cannot be empty — fill it in or delete the row" });
    expect(ru.errors.title).toBe("Название обязательно");
    expect(ru.errors.maxRounds).toBe("Целое число не меньше 1");
    expect(ru.errors.turnTimeoutSec).toBe("Целое число от 1 до 2147483");
  });
  it("turn timeout: 2147484 — error with the bound, 2147483 — no error, other limits — the old text", () => {
    const over = checkEditor(limits({ turnTimeoutSec: "2147484" }), empty(), "en");
    expect(over.canSave).toBe(false);
    expect(over.errors.turnTimeoutSec).toContain("2147483");
    expect(checkEditor(limits({ turnTimeoutSec: "2147484" }), empty(), "ru").errors.turnTimeoutSec).toContain("2147483");
    expect(checkEditor(limits({ turnTimeoutSec: "2147483" }), empty(), "en").errors.turnTimeoutSec).toBeUndefined();
    const zero = checkEditor(limits({ maxRounds: "0", contextChars: "0" }), empty(), "en");
    expect(zero.errors.maxRounds).toBe("An integer of 1 or more");
    expect(zero.errors.contextChars).toBe("An integer of 1 or more");
    expect(checkEditor(limits({ maxRounds: "0" }), empty(), "ru").errors.maxRounds).toBe("Целое число не меньше 1");
  });
  it("the language parameter takes priority over the process language", () => {
    setProcessLanguage("ru");
    expect(checkEditor(bad(), empty(), "en").errors.title).toBe("Title is required");
    setProcessLanguage("en");
    expect(checkEditor(bad(), empty(), "ru").errors.title).toBe("Название обязательно");
    expect(checkEditor(bad(), empty()).errors.title).toBe("Title is required");
  });
});
