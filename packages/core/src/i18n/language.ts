// Interface languages. A module without Node imports: the renderer imports it too.
export const LANGUAGES = ["en", "ru"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

// Language names are not translated: the owner finds their language in any of them.
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", ru: "Русский" };

// Only exact "en" | "ru": other case, spaces, and non-strings give null.
export function parseLanguage(value: unknown): Language | null {
  return LANGUAGES.find((l) => l === value) ?? null;
}
