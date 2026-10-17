import { checkTemplate, templateIdFromTitle } from "@model-council/core/templates";
import type { Language } from "@model-council/core/i18n";
import { templateEditor } from "../../shared/messages/template-editor.ts";
import type { TemplateDraft, TemplateEditorData } from "../../shared/setup.ts";

export const NEW_CATEGORY = "\u0000new";

export interface EditorRole { key: number; text: string }
export interface EditorForm {
  title: string;
  categoryChoice: string;
  newCategory: string;
  description: string;
  exampleTopic: string;
  framing: string;
  roles: EditorRole[];
  nextKey: number;
  limits: { maxRounds: string; turnTimeoutSec: string; contextChars: string };
}
export type EditorTextField = "title" | "newCategory" | "description" | "exampleTopic" | "framing";
export type EditorLimit = "maxRounds" | "turnTimeoutSec" | "contextChars";
export type EditorAction =
  | { type: "text"; field: EditorTextField; value: string }
  | { type: "category"; value: string }
  | { type: "role-add" }
  | { type: "role-text"; key: number; value: string }
  | { type: "role-remove"; key: number }
  | { type: "role-move"; key: number; delta: -1 | 1 }
  | { type: "limit"; field: EditorLimit; value: string };

const LIMITS: EditorLimit[] = ["maxRounds", "turnTimeoutSec", "contextChars"];

export function initialEditor(data: TemplateEditorData): EditorForm {
  const d = data.draft;
  const known = data.categories.includes(d.category);
  const none = d.category === "" && data.categories.length > 0;
  const lim = (v: number | undefined) => (v === undefined ? "" : String(v));
  return {
    title: d.title,
    categoryChoice: known ? d.category : none ? "" : NEW_CATEGORY,
    newCategory: known || none ? "" : d.category,
    description: d.description,
    exampleTopic: d.exampleTopic,
    framing: d.framing,
    roles: d.roles.map((text, i) => ({ key: i + 1, text })),
    nextKey: d.roles.length + 1,
    limits: { maxRounds: lim(d.limits.maxRounds), turnTimeoutSec: lim(d.limits.turnTimeoutSec), contextChars: lim(d.limits.contextChars) }
  };
}

export function reduceEditor(form: EditorForm, a: EditorAction): EditorForm {
  switch (a.type) {
    case "text": return { ...form, [a.field]: a.value };
    case "category": return { ...form, categoryChoice: a.value };
    case "role-add": return { ...form, roles: [...form.roles, { key: form.nextKey, text: "" }], nextKey: form.nextKey + 1 };
    case "role-text": return { ...form, roles: form.roles.map((r) => (r.key === a.key ? { ...r, text: a.value } : r)) };
    case "role-remove": return { ...form, roles: form.roles.filter((r) => r.key !== a.key) };
    case "role-move": {
      const i = form.roles.findIndex((r) => r.key === a.key);
      const j = i + a.delta;
      if (i < 0 || j < 0 || j >= form.roles.length) return form;
      const roles = [...form.roles];
      [roles[i], roles[j]] = [roles[j]!, roles[i]!];
      return { ...form, roles };
    }
    case "limit": return { ...form, limits: { ...form.limits, [a.field]: a.value } };
  }
}

export function toDraft(form: EditorForm): TemplateDraft {
  const limits: TemplateDraft["limits"] = {};
  for (const k of LIMITS) {
    const v = form.limits[k];
    if (v.trim() !== "") limits[k] = Number(v);
  }
  return {
    title: form.title,
    category: form.categoryChoice === NEW_CATEGORY ? form.newCategory : form.categoryChoice, // "" — not chosen
    description: form.description,
    exampleTopic: form.exampleTopic,
    framing: form.framing,
    roles: form.roles.map((r) => r.text),
    limits
  };
}

export interface EditorCheck {
  errors: Partial<Record<"title" | "category" | "description" | "exampleTopic" | "framing" | EditorLimit, string>>;
  roleErrors: Record<number, string>;
  canSave: boolean;
  previewId: string | null;
}

const fieldErrors = (language?: Language): Record<string, string> => {
  const t = templateEditor(language);
  return { title: t.errTitle, category: t.errCategory, description: t.errDescription, exampleTopic: t.errExampleTopic, framing: t.errFraming };
};

export function checkEditor(form: EditorForm, data: TemplateEditorData, language?: Language): EditorCheck {
  const t = templateEditor(language);
  const fe = fieldErrors(language);
  const previewId = data.id ?? (form.title.trim() === "" ? null : templateIdFromTitle(form.title, data.takenIds));
  const res = checkTemplate({ ...toDraft(form), id: previewId ?? "x" });
  const errors: EditorCheck["errors"] = {};
  const roleErrors: Record<number, string> = {};
  if (!res.ok) {
    for (const { path } of res.issues) {
      const [head, idx] = path.split(".");
      if (head === "roles" && idx !== undefined) {
        const role = form.roles[Number(idx)];
        if (role) roleErrors[role.key] = t.roleError;
      } else if (head === "limits" && idx !== undefined) {
        errors[idx as EditorLimit] = idx === "turnTimeoutSec" ? t.turnTimeoutError : t.limitError;
      } else if (head !== undefined && head in fe) {
        errors[head as keyof EditorCheck["errors"]] = fe[head];
      }
    }
  }
  return { errors, roleErrors, canSave: res.ok, previewId };
}
