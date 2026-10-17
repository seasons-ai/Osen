import type { Language } from "./language.ts";
import { getProcessLanguage } from "./process-language.ts";

// Message value: a string, or a function of the arguments returning a string.
type Message = string | ((...args: never[]) => string);

// Shape of another language's catalog: the same keys, string to string, a function with the same signature.
type SameShape<T> = { [K in keyof T]: T[K] extends (...args: infer A) => string ? (...args: A) => string : string };

// Area catalog: both languages in one object; a mismatch of keys or signatures is a typecheck error.
// Without an argument the language is taken from the process at call time, not from the catalog definition.
export function defineMessages<En extends Record<string, Message>>(catalog: { en: En; ru: SameShape<En> }): (language?: Language) => En {
  return (language = getProcessLanguage()) => (catalog[language] as En);
}
