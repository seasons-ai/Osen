import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getProcessLanguage } from "../i18n/process-language.ts";
import type { Language } from "../i18n/language.ts";
import { templateMessages } from "../messages/templates.ts";
import { TEMPLATE_ID_PATTERN, checkTemplate, templateIdFromTitle } from "./schema.ts";
import type { Template, TemplateIssue } from "./schema.ts";

export type TemplateDirs = { builtinDir: string; userDir: string; language?: Language };
export type TemplateStoreErrorCode = "invalid" | "bad_id" | "not_found" | "builtin" | "ambiguous" | "conflict" | "io";

export class TemplateStoreError extends Error {
  override name = "TemplateStoreError";
  readonly code: TemplateStoreErrorCode;
  readonly issues: TemplateIssue[];
  constructor(code: TemplateStoreErrorCode, message: string, issues: TemplateIssue[] = []) {
    super(message);
    this.code = code;
    this.issues = issues;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** *.json files of the folder: name and identifier (null — the file is not read or does not pass the schema). No folder — empty. */
function scan(dir: string): { file: string; id: string | null }[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new TemplateStoreError("io", templateMessages().dirReadFailed(basename(dir), errText(e).replaceAll(dirname(dir) + "/", "")));
  }
  return names.map((file) => {
    try {
      const r = checkTemplate(JSON.parse(readFileSync(join(dir, file), "utf8")));
      return { file, id: r.ok ? r.template.id : null };
    } catch {
      return { file, id: null };
    }
  });
}

/** Folder of the built-in templates of the active language. */
const builtinScan = (dirs: TemplateDirs) => scan(join(dirs.builtinDir, dirs.language ?? getProcessLanguage()));

export function builtinTemplateIds(dirs: TemplateDirs): Set<string> {
  return new Set(builtinScan(dirs).flatMap((f) => (f.id ? [f.id] : [])));
}

export function takenTemplateIds(dirs: TemplateDirs): Set<string> {
  const user = scan(dirs.userDir);
  const ids = [...builtinScan(dirs), ...user].flatMap((f) => (f.id ? [f.id] : []));
  return new Set([...ids, ...user.map((f) => f.file.slice(0, -".json".length))]);
}

function checkId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !TEMPLATE_ID_PATTERN.test(id)) throw new TemplateStoreError("bad_id", templateMessages().badId);
}

/** Checks the input without id; returns the template with the substituted id (a temporary one if it does not exist yet). */
function prepare(input: unknown, id: string): Template {
  const body = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  const idIssue: TemplateIssue[] = body && "id" in body ? [{ path: "id", message: templateMessages().idAuto }] : [];
  const { id: _ignored, ...rest } = body ?? {};
  const r = checkTemplate(body ? { ...rest, id } : input);
  if (!r.ok || idIssue.length) throw new TemplateStoreError("invalid", templateMessages().invalid, [...idIssue, ...(r.ok ? [] : r.issues)]);
  return r.template;
}

function serialize(t: Template): string {
  const limits = Object.fromEntries(Object.entries(t.limits).filter(([, v]) => v !== undefined));
  const { id, title, category, description, exampleTopic, framing, roles } = t;
  return `${JSON.stringify({ id, title, category, description, exampleTopic, framing, roles, ...(Object.keys(limits).length ? { limits } : {}) }, null, 2)}\n`;
}

/** Writes a template to a temp file and publishes it: replace — replaces an existing file, otherwise creates without replacing. */
function publish(dirs: TemplateDirs, t: Template, target: string, replace: boolean): Template {
  const dir = dirs.userDir;
  const tmp = join(dir, `.${t.id}.${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, serialize(t));
    if (replace) renameSync(tmp, join(dir, target));
    else {
      linkSync(tmp, join(dir, target));
      rmSync(tmp, { force: true });
    }
    return t;
  } catch (e) {
    rmSync(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new TemplateStoreError("conflict", templateMessages().exists(target));
    throw new TemplateStoreError("io", templateMessages().writeFailed(target, errText(e).replaceAll(dir + "/", "")));
  }
}

export function createUserTemplate(dirs: TemplateDirs, input: unknown): Template {
  const t = prepare(input, "template");
  const id = templateIdFromTitle(t.title, takenTemplateIds(dirs));
  return publish(dirs, { ...t, id }, `${id}.json`, false);
}

/** User files with an identifier; more than one — ambiguous. */
function userFile(dirs: TemplateDirs, id: string): string | null {
  const files = scan(dirs.userDir).filter((f) => f.id === id).map((f) => f.file);
  if (files.length > 1) throw new TemplateStoreError("ambiguous", templateMessages().ambiguous(id, files.join(", ")));
  return files[0] ?? null;
}

const inBuiltin = (dirs: TemplateDirs, id: string) => builtinScan(dirs).some((f) => f.id === id);

export function saveUserTemplate(dirs: TemplateDirs, id: string, input: unknown): Template {
  checkId(id);
  const t = prepare(input, id);
  const file = userFile(dirs, id);
  if (file) return publish(dirs, t, file, true);
  if (inBuiltin(dirs, id)) return publish(dirs, t, `${id}.json`, false);
  throw new TemplateStoreError("not_found", templateMessages().unknownTemplate(id));
}

export function deleteUserTemplate(dirs: TemplateDirs, id: string): void {
  checkId(id);
  const file = userFile(dirs, id);
  if (!file) {
    if (inBuiltin(dirs, id)) throw new TemplateStoreError("builtin", templateMessages().builtinNoDelete);
    throw new TemplateStoreError("not_found", templateMessages().unknownTemplate(id));
  }
  try {
    unlinkSync(join(dirs.userDir, file));
  } catch (e) {
    throw new TemplateStoreError("io", templateMessages().deleteFailed(file, errText(e).replaceAll(dirs.userDir + "/", "")));
  }
}
