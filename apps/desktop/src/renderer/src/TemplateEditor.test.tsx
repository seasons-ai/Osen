import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { TemplateDraft, TemplateEditorData, TemplateFieldIssue, TemplateOrigin } from "../../shared/setup.ts";
import { TemplateEditor } from "./TemplateEditor.tsx";
import { NEW_CATEGORY, initialEditor } from "./template-editor.ts";
import type { EditorForm } from "./template-editor.ts";

const draft = (o: Partial<TemplateDraft> = {}): TemplateDraft => ({
  title: "Ретроспектива спринта", category: "Мои шаблоны", description: "Описание шаблона", exampleTopic: "Пример темы", framing: "Рамка шаблона",
  roles: ["Ведущий", "Скептик", "Практик"], limits: { maxRounds: 3 }, ...o
});
const data = (o: Partial<TemplateEditorData> = {}): TemplateEditorData => ({
  id: "retro", origin: "user", draft: draft(), categories: ["Продукт", "Мои шаблоны"], takenIds: [], ...o
});
const html = (d = data(), o: { form?: EditorForm; saving?: boolean; error?: string | null; issues?: TemplateFieldIssue[]; backLabel?: string } = {}) =>
  renderToStaticMarkup(
    <TemplateEditor data={d} form={o.form ?? initialEditor(d)} saving={o.saving ?? false} error={o.error ?? null} issues={o.issues ?? []}
      backLabel={o.backLabel ?? "К шаблонам"} dispatch={() => {}} onSave={() => {}} onCancel={() => {}} />
  );
const saveBtn = (h: string) => /<button[^>]*btn--primary[^>]*>/.exec(h)![0];

describe("TemplateEditor", () => {
  it("filled form", () => {
    const h = html();
    for (const v of ["Ретроспектива спринта", "Описание шаблона", "Пример темы", "Рамка шаблона", "Ведущий", "Скептик", "Практик", 'value="3"', "retro", "пользовательский"]) expect(h).toContain(v);
    expect(saveBtn(h)).not.toContain("disabled");
    expect(h).not.toContain("Исправьте поля с ошибками");
    expect(h).toContain("Задаётся из названия при создании и не меняется");
    // change 93: «Add role» — a ghost button at the bottom of the list frame, like «Add participant» in «Session setup»
    expect(h).toMatch(/<div class="tpl-role-item">(?:(?!<\/section>).)*<div class="setup__add"><button type="button" class="btn btn--ghost">(?:(?!<\/button>).)*Добавить роль<\/button><\/div><\/div><\/section>/);
  });
  it.each<[TemplateOrigin, string]>([["new", "пользовательский"], ["user", "пользовательский"], ["modified", "изменён"], ["builtin", "встроенный"]])("origin %s", (origin, label) => {
    const h = html(data({ origin }));
    expect(h).toContain(label);
    expect(h.includes("Сохранение создаст ваш вариант")).toBe(origin === "builtin");
  });
  it("form with errors", () => {
    const d = data({ id: null, origin: "new", draft: draft({ title: "", framing: "", roles: ["a", ""], limits: { maxRounds: 0 } }) });
    const f = initialEditor(d);
    const h = html(d, { form: { ...f, limits: { ...f.limits, turnTimeoutSec: "1.5" } } });
    for (const v of ["Название обязательно", "Рамка обязательна", "Роль не может быть пустой", "Целое число не меньше 1", "появится после ввода названия", "Исправьте поля с ошибками"]) expect(h).toContain(v);
    expect(saveBtn(h)).toContain("disabled");
  });
  it("saving in progress", () => {
    const h = html(data(), { saving: true });
    expect(h).toContain("Сохраняю…");
    expect(saveBtn(h)).toContain("disabled");
  });
  it("error and write-boundary notes", () => {
    const h = html(data(), { error: "Диск недоступен", issues: [{ path: "title", message: "занято" }] });
    expect(h).toContain("Не удалось сохранить шаблон");
    expect(h).toContain("Диск недоступен");
    expect(h).toContain("title: занято");
    expect(html(data(), { issues: [{ path: "framing", message: "плохо" }] })).toContain("framing: плохо");
    expect(html()).not.toContain("Не удалось сохранить шаблон");
  });
  it("return label", () => {
    expect(html(data(), { backLabel: "К настройке" })).toContain("К настройке");
  });
  it("role reordering bounds", () => {
    const h = html();
    const ups = h.match(/<button[^>]*aria-label="Выше"[^>]*>/g)!;
    const downs = h.match(/<button[^>]*aria-label="Ниже"[^>]*>/g)!;
    expect(ups.map((b) => b.includes("disabled"))).toEqual([true, false, false]);
    expect(downs.map((b) => b.includes("disabled"))).toEqual([false, false, true]);
  });
  it("new category field", () => {
    const d = data({ draft: draft({ category: "Команда" }) });
    const f = initialEditor(d);
    expect(f.categoryChoice).toBe(NEW_CATEGORY);
    expect(html(d)).toContain("Название новой категории");
    expect(html()).not.toContain("Название новой категории");
  });
  it("empty category: placeholder and error", () => {
    const d = data({ draft: draft({ category: "" }) });
    const h = html(d);
    expect(h).toContain("Выберите категорию");
    expect(h).toContain("Категория обязательна");
    expect(html()).not.toContain("Выберите категорию");
  });
  it("no identifier field", () => {
    const h = html(data({ id: null, origin: "new" }));
    expect(h).not.toMatch(/aria-label="Идентификатор"/);
    expect((h.match(/<input/g) ?? []).length).toBe(1 + 1 + 3 + 3);
  });
});

describe("TemplateEditor: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const cyr = /[А-Яа-яЁё]/;
  const en = <T,>(f: () => T): T => { setProcessLanguage("en"); return f(); };
  const plain = (o: Partial<TemplateEditorData> = {}) =>
    data({ draft: draft({ title: "Retro", category: "Mine", description: "Desc", exampleTopic: "Topic", framing: "Frame", roles: ["Lead", "Skeptic"] }), categories: ["Mine", "Other"], ...o });

  it("en: labels, hints, placeholder, aria-label; no Cyrillic", () => {
    const h = en(() => html(plain(), { backLabel: "Back" }));
    for (const v of ["Discussion template", "Title", "Category", "New category…", "Description", "One line on the template card", "Example topic", "Discussion framing",
      "Roles", "Role 1", "Role 2", 'aria-label="Move up"', 'aria-label="Move down"', 'aria-label="Delete role"', 'placeholder="Role name"', "Add role", "Limits", "Round limit",
      "Turn timeout, s", "Context size, chars", "Identifier", "Origin", "custom", "Save", "Cancel", 'placeholder="What the participants should do']) expect(h).toContain(v);
    expect(h).not.toMatch(cyr);
  });
  it.each<[TemplateOrigin, string]>([["new", "custom"], ["user", "custom"], ["modified", "modified"], ["builtin", "built-in"]])("en: origin %s", (origin, label) => {
    const h = en(() => html(plain({ origin }), { backLabel: "Back" }));
    expect(h).toContain(label);
    expect(h).not.toMatch(cyr);
  });
  it("en: the owner's data verbatim, labels in English", () => {
    const h = en(() => html());
    for (const v of ["Ретроспектива спринта", "Описание шаблона", "Рамка шаблона", "Ведущий", "Скептик", "Практик"]) expect(h).toContain(v);
    expect(h).toContain("Discussion framing");
    expect(h).toContain('aria-label="Role 1"');
    expect(h).not.toContain("Описание</span>");
  });
  it("empty name and empty role: English errors at the same fields as in ru", () => {
    const d = plain({ id: null, origin: "new" });
    const form = { ...initialEditor(d), title: "", roles: [{ key: 1, text: "" }] };
    const h = en(() => html(d, { form, backLabel: "Back" }));
    expect(h).toContain("Title is required");
    expect(h).toContain("A role cannot be empty — fill it in or delete the row");
    expect(h).toContain("Fix the fields with errors");
    expect(h).not.toMatch(cyr);
    setProcessLanguage("ru");
    const r = html(d, { form });
    expect(r).toContain("Название обязательно");
    expect(r).toContain("Роль не может быть пустой — заполните или удалите строку");
  });
  it("en: saving and main errors as received", () => {
    const h = en(() => html(plain(), { backLabel: "Back", saving: true, error: "Ошибка диска", issues: [{ path: "title", message: "Занято" }] }));
    expect(h).toContain("Saving…");
    expect(h).toContain("Could not save the template");
    expect(h).toContain("Ошибка диска");
    expect(h).toContain("title: Занято");
  });
});
