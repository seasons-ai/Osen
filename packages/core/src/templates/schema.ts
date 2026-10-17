import { z } from "zod";
import { describeIssue, zodMessages } from "../messages/zod.ts";
import { templateMessages } from "../messages/templates.ts";
import { MAX_TURN_TIMEOUT_SEC } from "../protocol/schema.ts";

export { MAX_TURN_TIMEOUT_SEC };

const text = z.string().trim().min(1);
const int = z.number().int().min(1);
const joinLines = (v: unknown) => (Array.isArray(v) && v.every((s) => typeof s === "string") ? v.join("\n") : v);

export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const TemplateSchema = z.strictObject({
  id: z.string().regex(TEMPLATE_ID_PATTERN),
  title: text,
  category: text,
  description: text,
  exampleTopic: text,
  framing: z.preprocess(joinLines, text),
  roles: z.array(text).default([]),
  limits: z.strictObject({ maxRounds: int.optional(), turnTimeoutSec: int.max(MAX_TURN_TIMEOUT_SEC).optional(), contextChars: int.optional() }).default({}),
});
export type Template = z.infer<typeof TemplateSchema>;

/** Reason in the process language; `missing` — the field is absent from the input. */
const reason = (i: z.core.$ZodIssue, missing: boolean) => (i.code === "invalid_type" && missing ? templateMessages().missingField : describeIssue(i));

/** Error texts for the loader: "path: reason; …". */
export function describeIssues(issues: z.core.$ZodIssue[], json: unknown): string {
  return issues
    .map((i) => {
      const path = i.path.length ? i.path.join(".") : zodMessages().root;
      const value = i.path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<PropertyKey, unknown>)[k] : undefined), json);
      return `${path}: ${reason(i, value === undefined)}`;
    })
    .join("; ");
}

export interface TemplateIssue { path: string; message: string }

export function templateIssues(error: z.ZodError): TemplateIssue[] {
  return error.issues.flatMap((i): TemplateIssue[] => {
    const base = i.path.map(String);
    if (i.code === "unrecognized_keys") return i.keys.map((k) => ({ path: [...base, k].join("."), message: zodMessages().extraField(`«${k}»`) }));
    return [{ path: base.join(".") || zodMessages().root, message: reason(i, i.message.endsWith("received undefined")) }];
  });
}

export function checkTemplate(input: unknown): { ok: true; template: Template } | { ok: false; issues: TemplateIssue[] } {
  const r = TemplateSchema.safeParse(input);
  return r.success ? { ok: true, template: r.data } : { ok: false, issues: templateIssues(r.error) };
}

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function templateIdFromTitle(title: string, taken: Iterable<string>): string {
  const slug = [...title.toLowerCase()].map((c) => TRANSLIT[c] ?? (/[a-z0-9]/.test(c) ? c : "-")).join("");
  const base = slug.replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60).replace(/-$/, "") || "template";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}
