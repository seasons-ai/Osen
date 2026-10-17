import { describe, expect, it } from "vitest";
import { parseTariffs } from "./tariffs.ts";

const ok = { providerId: "local-llm", model: "qwen3-coder", source: "https://example.test/pricing", asOf: "2026-10-09", currency: "USD", inputPerMillion: 2, outputPerMillion: 4 };
const file = (...e: unknown[]) => JSON.stringify({ tariffs: e });
const W = "tariffs.json: ";

describe("parseTariffs", () => {
  it("valid file, source is trimmed", () => {
    const r = parseTariffs(file({ ...ok, source: "  https://example.test/pricing  " }));
    expect(r).toEqual({ state: "loaded", tariffs: [ok], warnings: [] });
  });

  it("not JSON", () => {
    for (const t of ["", "{", '{ "tariffs": [ { "inputPerMillion": NaN } ] }']) {
      expect(parseTariffs(t)).toEqual({ state: "unreadable", tariffs: [], warnings: [W + "не JSON"] });
    }
  });

  it("wrong object", () => {
    for (const t of ["[]", "{}", '{ "tariffs": {} }', "null", "42"]) {
      expect(parseTariffs(t)).toEqual({ state: "unreadable", tariffs: [], warnings: [W + "ожидается объект с полем tariffs — массивом записей"] });
    }
  });

  it("empty array", () => {
    expect(parseTariffs(file())).toEqual({ state: "loaded", tariffs: [], warnings: [] });
  });

  it.each<[string, unknown, string]>([
    ["отрицательная цена", { ...ok, inputPerMillion: -1 }, "inputPerMillion: конечное число не меньше 0"],
    ["цена-строка", { ...ok, outputPerMillion: "2" }, "outputPerMillion: конечное число не меньше 0"],
    ["пустой source", { ...ok, source: "" }, "source: непустая строка до 500 знаков"],
    ["source из пробелов", { ...ok, source: "   " }, "source: непустая строка до 500 знаков"],
    ["source 501 знак", { ...ok, source: "x".repeat(501) }, "source: непустая строка до 500 знаков"],
    ["asOf 30 февраля", { ...ok, asOf: "2026-02-30" }, "asOf: дата ГГГГ-ММ-ДД"],
    ["asOf 13 месяц", { ...ok, asOf: "2026-13-01" }, "asOf: дата ГГГГ-ММ-ДД"],
    ["asOf другого вида", { ...ok, asOf: "09.10.2026" }, "asOf: дата ГГГГ-ММ-ДД"],
    ["currency строчные", { ...ok, currency: "usd" }, "currency: три заглавные латинские буквы"],
    ["currency четыре буквы", { ...ok, currency: "USDT" }, "currency: три заглавные латинские буквы"],
    ["пустой model", { ...ok, model: "" }, "model: непустая строка"],
    ["пустой providerId", { ...ok, providerId: 1 }, "providerId: непустая строка"],
    ["запись null", null, "ожидается объект"],
    ["запись массив", [], "ожидается объект"],
    ["неизвестное поле", { ...ok, cachedInputPerMillion: 1 }, "cachedInputPerMillion: неизвестное поле"],
  ])("%s: запись не применяется, остальные применяются", (_n, bad, msg) => {
    const other = { ...ok, model: "other" };
    const r = parseTariffs(file(bad, other));
    expect(r.state).toBe("loaded");
    expect(r.tariffs).toEqual([other]);
    expect(r.warnings).toEqual([`${W}запись 1 не применяется — ${msg}`]);
  });

  it("1e999 gives Infinity", () => {
    const text = `{"tariffs":[{"providerId":"a","model":"m","source":"s","asOf":"2026-10-09","currency":"USD","inputPerMillion":1e999,"outputPerMillion":0}]}`;
    expect(parseTariffs(text).warnings).toEqual([`${W}запись 1 не применяется — inputPerMillion: конечное число не меньше 0`]);
  });

  it("zero prices are allowed", () => {
    const z = { ...ok, inputPerMillion: 0, outputPerMillion: 0 };
    expect(parseTariffs(file(z)).tariffs).toEqual([z]);
  });

  it("several problems: field order, unknown ones alphabetically", () => {
    const r = parseTariffs(file({ ...ok, zeta: 1, alpha: 2, model: "", currency: "x", inputPerMillion: -1 }));
    expect(r.warnings).toEqual([
      `${W}запись 1 не применяется — model: непустая строка; currency: три заглавные латинские буквы; inputPerMillion: конечное число не меньше 0; alpha: неизвестное поле; zeta: неизвестное поле`,
    ]);
  });

  it("duplicate pair", () => {
    const other = { ...ok, model: "other" };
    const r = parseTariffs(file(ok, other, { ...ok, inputPerMillion: 9 }));
    expect(r.tariffs).toEqual([other]);
    expect(r.warnings).toEqual([`${W}записи 1 и 3 не применяются — повтор пары local-llm / qwen3-coder`]);
  });

  it("triple duplicate", () => {
    const r = parseTariffs(file(ok, ok, ok));
    expect(r.tariffs).toEqual([]);
    expect(r.warnings).toEqual([`${W}записи 1, 2 и 3 не применяются — повтор пары local-llm / qwen3-coder`]);
  });

  it("an invalid entry does not count as a duplicate", () => {
    const r = parseTariffs(file({ ...ok, currency: "x" }, ok));
    expect(r.tariffs).toEqual([ok]);
    expect(r.warnings).toHaveLength(1);
  });

  it("warning order: entries, then duplicates", () => {
    const r = parseTariffs(file(ok, ok, null));
    expect(r.warnings).toEqual([
      `${W}запись 3 не применяется — ожидается объект`,
      `${W}записи 1 и 2 не применяются — повтор пары local-llm / qwen3-coder`,
    ]);
  });

  it("does not throw on junk", () => {
    for (const t of ["", "null", "42", "[1,2]", '{"tariffs":[1,"x",null,[]]}']) {
      expect(() => parseTariffs(t)).not.toThrow();
    }
  });
});
