import { accessSync, constants, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Language, DEFAULT_LANGUAGE, parseLanguage, setProcessLanguage } from "../i18n/index.ts";
import { prepareDataDir } from "./data-dir.ts";

export const PREFERENCES_FILE = "preferences.json";

export type PreferencesInvalidReason = "unreadable" | "not_json" | "no_language" | "unknown_language";
export type PreferencesState =
  | { state: "absent" }
  | { state: "loaded"; language: Language }
  | { state: "invalid"; reason: PreferencesInvalidReason; code: string | null };

const invalid = (reason: PreferencesInvalidReason, code: string | null = null): PreferencesState => ({ state: "invalid", reason, code });

// Creates nothing and writes nothing; the result has no file content and no path.
export function readPreferences(dataDir: string): PreferencesState {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, PREFERENCES_FILE), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? null;
    return code === "ENOENT" ? { state: "absent" } : invalid("unreadable", code);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return invalid("not_json");
  }
  const value = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["language"] : undefined;
  if (value === undefined) return invalid("no_language");
  const language = parseLanguage(value);
  return language ? { state: "loaded", language } : invalid("unknown_language");
}

export class PreferencesWriteError extends Error {
  readonly code: string | null;
  constructor(code: string | null) {
    super(`cannot write ${PREFERENCES_FILE}${code ? ` (${code})` : ""}`);
    this.name = "PreferencesWriteError";
    this.code = code;
  }
}

export function writeLanguage(dataDir: string, language: Language): void {
  const file = join(dataDir, PREFERENCES_FILE);
  // ponytail: temp file name by pid; if two processes write at once, the last one wins
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // a rename would also replace a read-only file: the write ban is respected
    if (existsSync(file)) accessSync(file, constants.W_OK);
    writeFileSync(tmp, `${JSON.stringify({ language }, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new PreferencesWriteError((e as NodeJS.ErrnoException).code ?? null);
  }
}

export type LanguageSource = "env" | "file" | "default";
export interface ResolvedLanguage {
  language: Language;
  source: LanguageSource;
  invalid: { reason: PreferencesInvalidReason; code: string | null } | null;
}

// The COUNCIL_LANG variable outranks the file, and the file outranks the default. The file is always read, to report damage.
export function resolveLanguage(env: Record<string, string | undefined>, dataDir: string): ResolvedLanguage {
  const prefs = readPreferences(dataDir);
  const bad = prefs.state === "invalid" ? { reason: prefs.reason, code: prefs.code } : null;
  const fromEnv = parseLanguage(env["COUNCIL_LANG"]);
  if (fromEnv) return { language: fromEnv, source: "env", invalid: bad };
  if (prefs.state === "loaded") return { language: prefs.language, source: "file", invalid: null };
  return { language: DEFAULT_LANGUAGE, source: "default", invalid: bad };
}

// Common entry for council and MCP: determines the language and sets the process language. Without COUNCIL_HOME it may move the former
// model-council folder to osen (prepareDataDir) — council and MCP need this; for the installer — peekDataDir. On a path failure
// only COUNCIL_LANG applies, otherwise the default: preferences.json of an unreliable folder is not read.
export function applyProcessLanguage(env: Record<string, string | undefined>): ResolvedLanguage {
  let r: ResolvedLanguage;
  try {
    r = resolveLanguage(env, prepareDataDir(env));
  } catch {
    const fromEnv = parseLanguage(env["COUNCIL_LANG"]);
    r = fromEnv ? { language: fromEnv, source: "env", invalid: null } : { language: DEFAULT_LANGUAGE, source: "default", invalid: null };
  }
  setProcessLanguage(r.language);
  return r;
}
