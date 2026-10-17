import type { Language } from "./language.ts";
import { getProcessLanguage } from "./process-language.ts";

// Intl locale equals the language value ("en", "ru").
export function formatNumber(value: number, options?: Intl.NumberFormatOptions, language: Language = getProcessLanguage()): string {
  return new Intl.NumberFormat(language, options).format(value);
}

export function formatDate(value: Date | number, options: Intl.DateTimeFormatOptions, language: Language = getProcessLanguage()): string {
  return new Intl.DateTimeFormat(language, options).format(value);
}

export type PluralForms = { one: string; few?: string; many?: string; other: string };

// Form by Intl.PluralRules of the language; a missing category (en has no few and many) is other.
export function plural(n: number, forms: PluralForms, language: Language = getProcessLanguage()): string {
  const category = new Intl.PluralRules(language).select(n);
  return (category === "one" || category === "few" || category === "many" ? forms[category] : undefined) ?? forms.other;
}

// Enumeration joined by a conjunction by the language's rules: "1, 2, and 3" in en.
export function formatList(items: string[], language: Language = getProcessLanguage()): string {
  return new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(items);
}
