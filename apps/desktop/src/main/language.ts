import { PreferencesWriteError, resetDiscoveryCache, resolveLanguage, setProcessLanguage, writeLanguage } from "@model-council/core";
import type { Logger } from "@model-council/core";
import { parseLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import type { BridgeEvent, LanguageView } from "../shared/bridge.ts";
import { shell } from "../shared/messages/shell.ts";

// A language change refusal; the bridge turns it into an ActionError with the same text.
export class LanguageRejectedError extends Error {}

export interface LanguageState {
  view(): LanguageView;
  set(language: unknown): LanguageView;
  invalidNotice(): string | null;
}

export interface LanguageStateDeps {
  env: Record<string, string | undefined>;
  dataDir: string;
  send(event: BridgeEvent): void;
  logger: Logger;
  resetDiscovery?(): void;
}

export function createLanguageState(deps: LanguageStateDeps): LanguageState {
  const resolved = resolveLanguage(deps.env, deps.dataDir);
  setProcessLanguage(resolved.language);
  let current = resolved.language;
  let source = resolved.source;
  let invalid = resolved.invalid;
  const view = (): LanguageView => ({ language: current, source, locked: source === "env" });
  return {
    view,
    set(value) {
      const language = parseLanguage(value);
      if (!language) throw new LanguageRejectedError(shell().languageInvalid);
      if (source === "env") throw new LanguageRejectedError(shell().languageLocked);
      try {
        writeLanguage(deps.dataDir, language);
      } catch (e) {
        if (e instanceof PreferencesWriteError) throw new LanguageRejectedError(shell().languageWriteFailed(e.code));
        throw e;
      }
      setProcessLanguage(language);
      (deps.resetDiscovery ?? resetDiscoveryCache)(); // CLI discovery caches reason texts in the language of the discovery moment
      current = language;
      source = "file";
      invalid = null;
      const v = view();
      deps.send({ type: "language", view: v });
      deps.logger.info(`Interface language changed: ${language}`);
      return v;
    },
    // with a language from the variable the file has no effect, and the notice text ("English is in effect") would be wrong
    invalidNotice: () => (invalid && source !== "env" ? shell().languageFileNotice(invalid.reason, invalid.code) : null),
  };
}

// Close warning window: texts in the language at display time.
export function closeWarningText(n: number, language?: Language): { message: string; detail: string; buttons: [string, string] } {
  const m = shell(language);
  return { message: m.closeWarningTitle, detail: m.closeWarningDetail(n), buttons: [m.closeStay, m.closeAbort] };
}
