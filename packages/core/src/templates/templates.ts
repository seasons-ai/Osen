import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getProcessLanguage } from "../i18n/process-language.ts";
import type { Language } from "../i18n/language.ts";
import { templateMessages } from "../messages/templates.ts";
import { TemplateSchema, describeIssues } from "./schema.ts";
import type { Template } from "./schema.ts";
import type { SessionInput } from "../engine.ts";
import type { Limits, Session } from "../protocol/schema.ts";

export { TemplateSchema } from "./schema.ts";
export type { Template } from "./schema.ts";

export type TemplateSource = "builtin" | "user";
export interface LoadedTemplate extends Template { source: TemplateSource; file: string }
export interface TemplateLoadError { source: TemplateSource; file: string; reason: string }
export interface TemplateCatalog { templates: LoadedTemplate[]; errors: TemplateLoadError[]; neutralFraming: string }

export const NEUTRAL_FRAMING_FILE = "neutral.md";
export const BUILTIN_TEMPLATES_DIR = join(import.meta.dirname, "../../../../templates");
export const userTemplatesDir = (dataDir: string): string => join(dataDir, "templates");

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function readDir(dir: string, source: TemplateSource, errors: TemplateLoadError[]): LoadedTemplate[] {
  let names: string[];
  try {
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.name.endsWith(".json")).sort((a, b) => (a.name < b.name ? -1 : 1));
    // A link is reported, not followed: the same rule as for materials.
    for (const e of entries) if (e.isSymbolicLink()) errors.push({ source, file: e.name, reason: templateMessages().symlinkSkipped });
    names = entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch (e) {
    if (errCode(e) !== "ENOENT") errors.push({ source, file: dir, reason: templateMessages().cannotRead(errText(e)) });
    return [];
  }
  const found = new Map<string, LoadedTemplate>();
  for (const file of names.sort()) {
    const fail = (reason: string) => errors.push({ source, file, reason });
    let raw: string;
    try {
      raw = readFileSync(join(dir, file), "utf8");
    } catch (e) {
      fail(templateMessages().cannotRead(errText(e)));
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      fail(templateMessages().notJson(errText(e)));
      continue;
    }
    const parsed = TemplateSchema.safeParse(json);
    if (!parsed.success) {
      fail(describeIssues(parsed.error.issues, json));
      continue;
    }
    const first = found.get(parsed.data.id);
    if (first) fail(templateMessages().duplicateId(parsed.data.id, first.file));
    else found.set(parsed.data.id, { ...parsed.data, source, file });
  }
  return [...found.values()];
}

function readNeutral(dir: string): string | null {
  try {
    return readFileSync(join(dir, NEUTRAL_FRAMING_FILE), "utf8").trim();
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

/** Built-in templates live in `<builtinDir>/<language>`; the default language is the active process language, there is no fallback language. */
export function loadTemplates(dirs: { builtinDir: string; userDir: string; language?: Language }): TemplateCatalog {
  const language = dirs.language ?? getProcessLanguage();
  const builtinDir = join(dirs.builtinDir, language);
  const errors: TemplateLoadError[] = [];
  const all = new Map<string, LoadedTemplate>();
  for (const t of [...readDir(builtinDir, "builtin", errors), ...readDir(dirs.userDir, "user", errors)]) all.set(t.id, t);
  const templates = [...all.values()].sort((a, b) => a.category.localeCompare(b.category, language) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // The built-in frame of the language is required even when the user frame overrides its text.
  let builtinFraming: string | null = null;
  try {
    builtinFraming = readNeutral(builtinDir);
  } catch {}
  if (!builtinFraming) throw new Error(templateMessages().neutralMissing(join(builtinDir, NEUTRAL_FRAMING_FILE)));
  let neutralFraming: string | null = null;
  try {
    neutralFraming = readNeutral(dirs.userDir);
  } catch (e) {
    errors.push({ source: "user", file: NEUTRAL_FRAMING_FILE, reason: templateMessages().cannotRead(errText(e)) });
  }
  if (neutralFraming === "") errors.push({ source: "user", file: NEUTRAL_FRAMING_FILE, reason: templateMessages().neutralEmpty });
  return { templates, errors, neutralFraming: neutralFraming || builtinFraming };
}

export class UnknownTemplateError extends Error {
  override name = "UnknownTemplateError";
}

export interface TemplateStart {
  catalog: TemplateCatalog;
  templateId?: string | null;
  topic: string;
  origin: Session["origin"];
  participants: { name: string; providerId: string; model: string }[];
  limits: Partial<Limits>;
  defaults: Limits;
  framing?: string;
  noTokenCap?: boolean;
}

export function templateSessionInput(start: TemplateStart): SessionInput {
  const { catalog, templateId } = start;
  const template = templateId ? catalog.templates.find((t) => t.id === templateId) : undefined;
  if (templateId && !template) throw new UnknownTemplateError(templateMessages().unknownTemplate(templateId));
  const limit = (k: "maxRounds" | "turnTimeoutSec" | "contextChars"): number => start.limits[k] ?? template?.limits[k] ?? start.defaults[k];
  const materialsChars = start.limits.materialsChars ?? start.defaults.materialsChars;
  const maxTotalTokens = start.noTokenCap ? undefined : (start.limits.maxTotalTokens ?? start.defaults.maxTotalTokens);
  return {
    topic: start.topic,
    origin: start.origin,
    templateId: template?.id ?? null,
    framing: start.framing ?? template?.framing ?? catalog.neutralFraming,
    participants: start.participants.map((p, i) => ({ ...p, role: template?.roles[i] ?? null })),
    limits: { maxRounds: limit("maxRounds"), turnTimeoutSec: limit("turnTimeoutSec"), contextChars: limit("contextChars"),
      ...(materialsChars !== undefined ? { materialsChars } : {}),
      ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
    },
  };
}
