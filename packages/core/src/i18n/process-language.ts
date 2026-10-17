import { DEFAULT_LANGUAGE, type Language } from "./language.ts";

// Current process language: set by the entry points at startup and when changed in "Settings".
let current: Language = DEFAULT_LANGUAGE;

export function getProcessLanguage(): Language {
  return current;
}

export function setProcessLanguage(language: Language): void {
  current = language;
}
