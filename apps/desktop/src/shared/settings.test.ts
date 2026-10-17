import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { MAX_TURN_TIMEOUT_SEC } from "@model-council/core/templates";
import { settings } from "./messages/settings.ts";
import { DEFAULTS_BOUNDS, checkDefaults, checkProviderInput, hasErrors } from "./settings.ts";
import type { DefaultsValues, ProviderInput } from "./settings.ts";

const URL_ERR = "Адрес должен начинаться с http:// или https://";
const ENV_ERR = "Имя переменной: заглавные латинские буквы, цифры и «_», не с цифры";
const okInput: ProviderInput = { id: null, label: "Локальный", baseUrl: "http://localhost:8787/v1", apiKeyEnv: "TEST_KEY" };
const input = (patch: Partial<ProviderInput>) => checkProviderInput({ ...okInput, ...patch });

describe("checkProviderInput", () => {
  it("valid input without errors", () => {
    expect(input({})).toEqual({ label: null, baseUrl: null, apiKeyEnv: null });
    expect(hasErrors(input({}))).toBe(false);
  });
  it("empty name", () => {
    expect(input({ label: "" }).label).toBe("Введите название");
    expect(input({ label: "   " }).label).toBe("Введите название");
  });
  it.each(["ftp://x", "не адрес", "", "   "])("плохой адрес %j", (baseUrl) => {
    expect(input({ baseUrl }).baseUrl).toBe(URL_ERR);
  });
  it.each(["http://localhost:8787/v1", "https://openrouter.ai/api/v1"])("хороший адрес %s", (baseUrl) => {
    expect(input({ baseUrl }).baseUrl).toBeNull();
  });
  it.each(["", "TEST_KEY", "_K1"])("допустимое имя переменной %j", (apiKeyEnv) => {
    expect(input({ apiKeyEnv }).apiKeyEnv).toBeNull();
  });
  it.each(["1KEY", "test_key", "MY KEY"])("недопустимое имя переменной %j", (apiKeyEnv) => {
    expect(input({ apiKeyEnv }).apiKeyEnv).toBe(ENV_ERR);
  });
});

const ok: DefaultsValues = {
  maxRounds: 3, turnTimeoutSec: 120, contextChars: 50_000, materialsChars: 60_000, maxTotalTokens: null, maxParticipants: 4,
  participants: [{ providerId: "a", model: "m" }, { providerId: "b", model: "m" }],
};
const ids = ["a", "b"];
const defaults = (patch: Partial<DefaultsValues>) => checkDefaults({ ...ok, ...patch }, ids);

describe("checkDefaults", () => {
  it("valid values without errors", () => {
    expect(hasErrors(checkDefaults(ok, ids))).toBe(false);
  });
  for (const key of ["maxRounds", "turnTimeoutSec", "contextChars", "materialsChars", "maxParticipants"] as const) {
    const { min, max } = DEFAULTS_BOUNDS[key];
    const msg = `Целое число от ${min} до ${max}`;
    it(`${key}: bounds`, () => {
      expect(defaults({ [key]: min })[key]).toBeNull();
      expect(defaults({ [key]: max })[key]).toBeNull();
      for (const v of [min - 1, max + 1, min + 0.5, NaN]) expect(defaults({ [key]: v })[key]).toBe(msg);
    });
  }
  it("one participant", () => {
    expect(defaults({ participants: [ok.participants[0]!] }).participants).toBe("Нужно не меньше двух участников");
  });
  it("more participants than the upper bound", () => {
    const p = [0, 1, 2].map(() => ({ providerId: "a", model: "m" }));
    expect(defaults({ maxParticipants: 2, participants: p }).participants).toBe("Участников 3, а верхняя граница — 2");
  });
  it("unknown provider", () => {
    expect(defaults({ participants: [ok.participants[0]!, { providerId: "x", model: "m" }] }).participants).toBe("Провайдер «x» не найден в реестре");
  });
  it("empty model", () => {
    expect(defaults({ participants: [ok.participants[0]!, { providerId: "b", model: "  " }] }).participants).toBe("У участника не выбрана модель");
  });
});

describe("checkDefaults: token cap", () => {
  const cap = (maxTotalTokens: number | null) => checkDefaults({ ...ok, maxTotalTokens }, ["a", "b"]);
  it.each([null, 1, 50000])("принято %s", (v) => {
    expect(cap(v).maxTotalTokens).toBeNull();
    expect(hasErrors(cap(v))).toBe(false);
  });
  it.each([0, -5, 1.5, NaN, 2 ** 60])("ошибка %s", (v) => {
    expect(cap(v).maxTotalTokens).toBe("Нужно целое число от 1");
    expect(cap(v).maxRounds).toBeNull();
  });
});

describe("hasErrors", () => {
  it("all null — false, one reason — true", () => {
    expect(hasErrors({ a: null, b: null })).toBe(false);
    expect(hasErrors({ a: null, b: "ошибка" })).toBe(true);
  });
});

describe("validation texts in English", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = settings("en");

  it("provider form: three refusals and valid input passes", () => {
    setProcessLanguage("en");
    expect(input({ label: " " }).label).toBe("Enter a name");
    expect(input({ baseUrl: "ftp://x" }).baseUrl).toBe("The address must start with http:// or https://");
    expect(input({ apiKeyEnv: "1KEY" }).apiKeyEnv).toBe("Variable name: uppercase Latin letters, digits and “_”, not starting with a digit");
    expect(hasErrors(input({}))).toBe(false);
  });

  it("default values: six refusals and valid ones pass", () => {
    setProcessLanguage("en");
    expect(hasErrors(checkDefaults(ok, ids))).toBe(false);
    expect(defaults({ maxRounds: 0 }).maxRounds).toBe("An integer from 1 to 20");
    expect(defaults({ maxRounds: 0 }).maxRounds).toBe(en.intRange(1, 20));
    expect(defaults({ participants: [ok.participants[0]!] }).participants).toBe("At least two participants are required");
    expect(defaults({ maxParticipants: 2, participants: [...ok.participants, ok.participants[0]!] }).participants).toBe("3 participants, but the upper limit is 2");
    expect(defaults({ participants: [ok.participants[0]!, { providerId: "ghost", model: "m" }] }).participants).toBe("Provider “ghost” not found in the registry");
    expect(defaults({ participants: [ok.participants[0]!, { providerId: "b", model: " " }] }).participants).toBe("A participant has no model selected");
    expect(defaults({ maxTotalTokens: 0 }).maxTotalTokens).toBe("An integer of 1 or more is required");
  });

  it("the language is taken at call time", () => {
    setProcessLanguage("en");
    const a = input({ label: "" }).label;
    setProcessLanguage("ru");
    expect(a).toBe("Enter a name");
    expect(input({ label: "" }).label).toBe("Введите название");
  });
});

it("the turn timeout field bound is not above the core bound", () => {
  expect(DEFAULTS_BOUNDS.turnTimeoutSec.max).toBeLessThanOrEqual(MAX_TURN_TIMEOUT_SEC);
});
