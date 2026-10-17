import type { z } from "zod";
import { defineMessages } from "../i18n/catalog.ts";
import { plural } from "../i18n/format.ts";

// Common zod parse reasons: used by the registry, lineups and templates. No Node imports: the module gets into the renderer.
export const zodMessages = defineMessages({
  en: {
    root: "(root)",
    number: "number", int: "integer", string: "string", array: "array", object: "object", boolean: "boolean",
    expected: (type: string) => `expected ${type}`,
    nonEmptyString: "expected a non-empty string",
    minItems: (n: unknown) => `expected at least ${n} ${plural(Number(n), { one: "item", other: "items" }, "en")}`,
    minNumber: (n: unknown) => `expected a number not less than ${n}`,
    maxNumber: (n: unknown) => `expected a number not greater than ${n}`,
    pattern: (p: unknown) => `value does not match the pattern ${p}`,
    format: (f: string) => `expected format ${f}`,
    extraField: (keys: string) => `extra field ${keys}`,
    oneOf: (values: string) => `expected one of: ${values}`,
  },
  ru: {
    root: "(корень)",
    number: "число", int: "целое число", string: "строка", array: "массив", object: "объект", boolean: "логическое значение",
    expected: (type: string) => `ожидается ${type}`,
    nonEmptyString: "ожидается непустая строка",
    minItems: (n: unknown) => `ожидается не меньше ${n} элементов`,
    minNumber: (n: unknown) => `ожидается число не меньше ${n}`,
    maxNumber: (n: unknown) => `ожидается число не больше ${n}`,
    pattern: (p: unknown) => `значение не подходит под шаблон ${p}`,
    format: (f: string) => `ожидается формат ${f}`,
    extraField: (keys: string) => `лишнее поле ${keys}`,
    oneOf: (values: string) => `ожидается одно из: ${values}`,
  },
});

/** Reason for one zod problem in the process language (without invalid_union: it depends on the schema). */
export function describeIssue(i: z.core.$ZodIssue): string {
  const m = zodMessages();
  switch (i.code) {
    case "invalid_type": {
      const names: Record<string, string> = { number: m.number, int: m.int, string: m.string, array: m.array, object: m.object, boolean: m.boolean };
      return m.expected(names[i.expected] ?? i.expected);
    }
    case "too_small":
      return i.origin === "string" ? m.nonEmptyString : i.origin === "array" ? m.minItems(i.minimum) : m.minNumber(i.minimum);
    case "too_big":
      return i.origin === "number" || i.origin === "int" ? m.maxNumber(i.maximum) : i.message;
    case "invalid_format":
      return i.format === "regex" ? m.pattern(i.pattern) : m.format(i.format);
    case "unrecognized_keys":
      return m.extraField(i.keys.map((k) => `«${k}»`).join(", "));
    case "invalid_value":
      return m.oneOf(i.values.map(String).join(", "));
    default:
      return i.message;
  }
}
