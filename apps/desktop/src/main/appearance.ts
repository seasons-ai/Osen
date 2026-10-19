import { accessSync, constants, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@model-council/core";
import type { AppearanceView, LightTheme, ThemeId, ThemeMode } from "../shared/bridge.ts";
import { shell } from "../shared/messages/shell.ts";

export const APPEARANCE_FILE = "appearance.json";
export const DEFAULT_APPEARANCE: { mode: ThemeMode; lightTheme: LightTheme } = { mode: "dark", lightTheme: "tuman" };

const MODES: readonly ThemeMode[] = ["dark", "light", "system"];
const LIGHT_THEMES: readonly LightTheme[] = ["tuman", "len", "inei", "pergament"];

// --bg-0 of each theme; a test compares this table with design/mockup-osen/brand/tokens.css.
export const WINDOW_BACKGROUNDS: Record<ThemeId, string> = {
  osen: "#17130F",
  tuman: "#F6F1EA",
  len: "#F5F5F2",
  inei: "#F1F4F6",
  pergament: "#EFE4D0",
};

type Choice = { mode: ThemeMode; lightTheme: LightTheme };

export function effectiveTheme(choice: Choice, systemDark: boolean): ThemeId {
  if (choice.mode === "dark") return "osen";
  if (choice.mode === "light") return choice.lightTheme;
  return systemDark ? "osen" : choice.lightTheme;
}

// Never writes. A missing field is not damage (no warning, default); an unknown value of a field defaults only that field.
export function readAppearance(dataDir: string): Choice & { warning: string | null } {
  const file = join(dataDir, APPEARANCE_FILE);
  const defaults = { ...DEFAULT_APPEARANCE, warning: null as string | null };
  if (!existsSync(file)) return defaults;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ...defaults, warning: code ? `${APPEARANCE_FILE} cannot be read (${code}); defaults are in use` : `${APPEARANCE_FILE} is not valid JSON; defaults are in use` };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ...defaults, warning: `${APPEARANCE_FILE} is not a JSON object; defaults are in use` };
  }
  const o = doc as Record<string, unknown>;
  const problems: string[] = [];
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    if (!(key in o)) return fallback;
    if ((allowed as readonly unknown[]).includes(o[key])) return o[key] as T;
    problems.push(`${key} has an unknown value ${JSON.stringify(o[key])?.slice(0, 40)}`);
    return fallback;
  };
  const mode = pick("mode", MODES, DEFAULT_APPEARANCE.mode);
  const lightTheme = pick("lightTheme", LIGHT_THEMES, DEFAULT_APPEARANCE.lightTheme);
  return { mode, lightTheme, warning: problems.length ? `${APPEARANCE_FILE}: ${problems.join("; ")}; the default is used for it` : null };
}

// A theme change refusal; the bridge turns it into an ActionError with the same text.
export class AppearanceRejectedError extends Error {}

export interface AppearanceState {
  view(): AppearanceView;
  set(input: unknown): AppearanceView;
  systemChanged(): void;
  background(): string;
}

export interface AppearanceStateDeps {
  dataDir: string;
  systemDark(): boolean;
  // Native theme source follows the mode; called before systemDark() is read, since the source changes what it reports.
  applyMode?(mode: ThemeMode): void;
  send(event: { type: "appearance"; view: AppearanceView }): void;
  logger: Logger;
}

function writeAppearance(dataDir: string, choice: Choice): void {
  const file = join(dataDir, APPEARANCE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    // a rename would also replace a read-only file: the write ban is respected
    if (existsSync(file)) accessSync(file, constants.W_OK);
    writeFileSync(tmp, `${JSON.stringify({ mode: choice.mode, lightTheme: choice.lightTheme }, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new AppearanceRejectedError(shell().appearanceWriteFailed((e as NodeJS.ErrnoException).code ?? null));
  }
}

export function createAppearanceState(deps: AppearanceStateDeps): AppearanceState {
  const read = readAppearance(deps.dataDir);
  // Logger has no warn level: the warning goes through error()
  if (read.warning) deps.logger.error(`Appearance: ${read.warning}`);
  let choice: Choice = { mode: read.mode, lightTheme: read.lightTheme };
  deps.applyMode?.(choice.mode);
  let lastTheme = effectiveTheme(choice, deps.systemDark());
  const view = (): AppearanceView => ({ ...choice, theme: effectiveTheme(choice, deps.systemDark()) });
  return {
    view,
    set(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw new AppearanceRejectedError(shell().appearanceInvalid);
      const o = input as Record<string, unknown>;
      const mode = o.mode === undefined ? choice.mode : MODES.find((m) => m === o.mode);
      const lightTheme = o.lightTheme === undefined ? choice.lightTheme : LIGHT_THEMES.find((t) => t === o.lightTheme);
      if (!mode || !lightTheme) throw new AppearanceRejectedError(shell().appearanceInvalid);
      const next = { mode, lightTheme };
      writeAppearance(deps.dataDir, next);
      choice = next;
      deps.applyMode?.(mode);
      const v = view();
      lastTheme = v.theme;
      deps.send({ type: "appearance", view: v });
      deps.logger.info(`Appearance changed: mode ${mode}, light theme ${lightTheme}, theme ${v.theme}`);
      return v;
    },
    systemChanged() {
      const v = view();
      if (v.theme === lastTheme) return;
      lastTheme = v.theme;
      deps.send({ type: "appearance", view: v });
      deps.logger.info(`Appearance follows the system: theme ${v.theme}`);
    },
    background: () => WINDOW_BACKGROUNDS[view().theme],
  };
}
