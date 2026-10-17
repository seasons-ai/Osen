import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEMPLATE_ID_PATTERN, checkTemplate, templateIdFromTitle } from "./schema.ts";

const tpl = (over: Record<string, unknown> = {}) => ({
  id: "arch", title: "Архитектура", category: "Код", description: "Когда брать", exampleTopic: "Пример", framing: "Рамка", ...over,
});
const issuesOf = (v: unknown) => {
  const r = checkTemplate(v);
  if (r.ok) throw new Error("ожидалась ошибка");
  return r.issues;
};

describe("templateIdFromTitle", () => {
  const id = (t: string, taken: string[] = []) => templateIdFromTitle(t, taken);
  it("Russian title", () => expect(id("Ретроспектива спринта")).toBe("retrospektiva-sprinta"));
  it("mix of Latin letters and digits", () => expect(id("Проверка API v2")).toBe("proverka-api-v2"));
  it("uppercase, symbols, spaces", () => expect(id("  Щука, ёж & Ъ-Ы!  ")).toBe("schuka-ezh-y"));
  it("only symbols or empty", () => {
    expect(id("!!!")).toBe("template");
    expect(id("")).toBe("template");
  });
  it("matches", () => {
    expect(id("Арх", ["arh"])).toBe("arh-2");
    expect(id("Арх", ["arh", "arh-2"])).toBe("arh-3");
  });
  it("a long id is cut without a trailing hyphen", () => {
    const r = id(`${"a".repeat(59)} bbb`);
    expect(r).toBe("a".repeat(59));
    expect(id("a".repeat(100)).length).toBe(60);
  });
  it("always passes the template pattern", () => {
    for (const t of ["-abc", "!x", "---", "ъь", "Тест 1", "😀"]) expect(id(t)).toMatch(TEMPLATE_ID_PATTERN);
  });
});

describe("checkTemplate", () => {
  it("valid", () => {
    const r = checkTemplate(tpl());
    expect(r).toMatchObject({ ok: true, template: { id: "arch", roles: [], limits: {} } });
  });
  it("title made of spaces", () => expect(issuesOf(tpl({ title: "   " }))).toEqual([{ path: "title", message: "ожидается непустая строка" }]));
  it("no frame", () => {
    const { framing, ...rest } = tpl();
    expect(issuesOf(rest)).toEqual([{ path: "framing", message: "обязательное поле отсутствует" }]);
  });
  it("empty role", () => expect(issuesOf(tpl({ roles: ["A", " "] }))).toEqual([{ path: "roles.1", message: "ожидается непустая строка" }]));
  it("bad limits", () => {
    for (const v of [0, 1.5, -1]) expect(issuesOf(tpl({ limits: { maxRounds: v } }))[0]?.path).toBe("limits.maxRounds");
  });
  it("limit 21 is allowed", () => expect(checkTemplate(tpl({ limits: { maxRounds: 21 } })).ok).toBe(true));
  it("extra field", () => expect(issuesOf(tpl({ foo: 1 }))).toEqual([{ path: "foo", message: "лишнее поле «foo»" }]));
});

it("schema.ts does not import Node", () => {
  expect(readFileSync(new URL("./schema.ts", import.meta.url), "utf8")).not.toContain("node:");
});

describe("limits.turnTimeoutSec: upper bound (change 108)", () => {
  it("2147483 loads, 2147484 is rejected with the path and bound", () => {
    expect(checkTemplate(tpl({ limits: { turnTimeoutSec: 2147483 } })).ok).toBe(true);
    const text = JSON.stringify(issuesOf(tpl({ limits: { turnTimeoutSec: 2147484 } })));
    expect(text).toContain("limits.turnTimeoutSec");
    expect(text).toContain("2147483");
  });
});
