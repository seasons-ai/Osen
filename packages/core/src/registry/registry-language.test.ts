import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../cli-agents/types.ts";
import { getProcessLanguage, setProcessLanguage } from "../i18n/process-language.ts";
import { describeIssue } from "../messages/zod.ts";
import { RegistryError, readRegistry, writeRegistry } from "./config.ts";
import { checkLineup } from "./lineup-check.ts";
import type { LineupCheckContext } from "./lineup-check.ts";
import { LineupsError, readLineups, saveLineup } from "./lineups.ts";
import { inspectProvider } from "./providers.ts";
import type { ProviderStatus } from "./providers.ts";

const before = getProcessLanguage();
const dirs: string[] = [];
afterEach(() => {
  setProcessLanguage(before);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "council-lang-"));
  dirs.push(d);
  return d;
};
const lang = <T>(l: "en" | "ru", f: () => T): T => {
  setProcessLanguage(l);
  return f();
};
const failure = (f: () => unknown): string => {
  try { f(); } catch (e) { return (e as Error).message; }
  throw new Error("ожидалась ошибка");
};

const cli = { id: "claude", kind: "cli", label: "Claude Code", agent: "claude", models: [] };
const reg = (over: object = {}, defaults: object = {}) => ({
  providers: [cli],
  defaults: { maxRounds: 5, turnTimeoutSec: 300, contextChars: 24000, maxParticipants: 8, participants: [{ providerId: "claude", model: "m" }], ...defaults },
  ...over,
});
const regDir = (json: unknown) => {
  const d = tmp();
  writeFileSync(join(d, "config.json"), typeof json === "string" ? json : JSON.stringify(json));
  return d;
};

describe("Core messages in the selected language: config.json error", () => {
  const cases: [string, unknown, string, string][] = [
    ["лишнее поле", reg({ extra: 1 }), "(корень): лишнее поле «extra»", "(root): extra field «extra»"],
    ["неверный тип", reg({}, { maxRounds: "5" }), "defaults.maxRounds: ожидается число", "defaults.maxRounds: expected number"],
    ["таймаут хода выше границы", reg({}, { turnTimeoutSec: 2147484 }), "defaults.turnTimeoutSec: ожидается число не больше 2147483", "defaults.turnTimeoutSec: expected a number not greater than 2147483"],
    ["повтор идентификатора", reg({ providers: [cli, cli] }), "providers.1.id: повторяющийся идентификатор провайдера «claude»", "providers.1.id: duplicate provider identifier “claude”"],
    ["нет провайдера", reg({}, { participants: [{ providerId: "zz", model: "m" }] }), "defaults.participants.0.providerId: провайдер «zz» не найден среди providers", "defaults.participants.0.providerId: provider “zz” not found among providers"],
    ["зарезервированный id", reg({ providers: [{ ...cli, id: "scripted" }] }), "идентификатор «scripted» зарезервирован за сценарным участником", "the identifier “scripted” is reserved for the scripted participant"],
    ["union", reg({ providers: [{ id: "x", kind: "zzz" }] }), "providers.0.kind: ожидается kind: «cli» или «openai-http»", "providers.0.kind: expected kind: “cli” or “openai-http”"],
    ["потолок участников", reg({}, { maxParticipants: 2, participants: [1, 2, 3].map(() => ({ providerId: "claude", model: "m" })) }), "участников по умолчанию 3, а maxParticipants = 2", "3 default participants, but maxParticipants = 2"],
  ];
  for (const [name, json, ru, en] of cases) {
    it(`${name}: ru unchanged, en in English, path identical, both languages in a row`, () => {
      const d = regDir(json);
      const mRu = lang("ru", () => failure(() => readRegistry(d)));
      const mEn = lang("en", () => failure(() => readRegistry(d)));
      const mRu2 = lang("ru", () => failure(() => readRegistry(d)));
      expect(mRu).toContain(ru);
      expect(mEn).toContain(en);
      expect(mRu2).toBe(mRu);
      expect(mEn.startsWith("config.json: ")).toBe(true);
    });
  }

  it("read and write: file, parsing, writing", () => {
    const d = tmp();
    expect(lang("ru", () => failure(() => readRegistry(d)))).toBe(`config.json: файл не найден — ${join(d, "config.json")}`);
    expect(lang("en", () => failure(() => readRegistry(d)))).toBe(`config.json: file not found — ${join(d, "config.json")}`);
    const bad = regDir("{");
    expect(lang("ru", () => failure(() => readRegistry(bad)))).toContain("config.json: не JSON — ");
    expect(lang("en", () => failure(() => readRegistry(bad)))).toContain("config.json: not JSON — ");
    expect(lang("en", () => failure(() => writeRegistry(d, { x: 1 })))).toContain("config.json: ");
    mkdirSync(join(d, "config.json"));
    expect(lang("ru", () => failure(() => writeRegistry(d, reg())))).toContain("не удалось ");
    expect(lang("en", () => failure(() => writeRegistry(d, reg())))).toContain("could not ");
    expect(() => lang("en", () => readRegistry(d))).toThrow(RegistryError);
  });
});

describe("Core messages in the selected language: lineups.json", () => {
  const p = { providerId: "claude", model: "m", role: null };
  const lineups = (json: unknown) => {
    const d = tmp();
    writeFileSync(join(d, "lineups.json"), typeof json === "string" ? json : JSON.stringify(json));
    return d;
  };
  const cases: [string, unknown, string, string][] = [
    ["лишнее поле", [{ id: "a", name: "A", participants: [p, p], zz: 1 }], "0: лишнее поле «zz»", "0: extra field «zz»"],
    ["неверный тип", [{ id: 1, name: "A", participants: [p, p] }], "0.id: ожидается строка", "0.id: expected string"],
    ["повтор id", [{ id: "a", name: "A", participants: [p, p] }, { id: "a", name: "B", participants: [p, p] }], "1.id: идентификатор «a» повторяется", "1.id: identifier “a” is repeated"],
    ["повтор названия", [{ id: "a", name: "A", participants: [p, p] }, { id: "b", name: "A", participants: [p, p] }], "1.name: название «A» уже занято позицией 0", "1.name: the name “A” is already used by item 0"],
    ["пустое название", [{ id: "a", name: " ", participants: [p, p] }], "0.name: название не может быть пустым", "0.name: the name cannot be empty"],
    ["мало участников", [{ id: "a", name: "A", participants: [p] }], "0.participants: ожидается не меньше 2 элементов", "0.participants: expected at least 2 items"],
    ["длинное название", [{ id: "a", name: "x".repeat(101), participants: [p, p] }], "0.name: название не длиннее 100 знаков", "0.name: the name must be at most 100 characters"],
  ];
  for (const [name, json, ru, en] of cases) {
    it(`${name}: ru unchanged, en in English, both languages in a row`, () => {
      const d = lineups(json);
      const mRu = lang("ru", () => failure(() => readLineups(d)));
      const mEn = lang("en", () => failure(() => readLineups(d)));
      expect(mRu).toBe(`lineups.json: ${ru}`);
      expect(mEn).toBe(`lineups.json: ${en}`);
    });
  }
  it("not JSON and save errors", async () => {
    expect(lang("ru", () => failure(() => readLineups(lineups("{"))))).toContain("lineups.json: не JSON — ");
    expect(lang("en", () => failure(() => readLineups(lineups("{"))))).toContain("lineups.json: not JSON — ");
    const d = tmp();
    const msg = async (l: "en" | "ru", name: string, ps = [p, p]) => {
      setProcessLanguage(l);
      try { await saveLineup(d, { name, participants: ps }); } catch (e) { expect(e).toBeInstanceOf(LineupsError); return (e as Error).message; }
      throw new Error("ожидалась ошибка");
    };
    expect(await msg("ru", " ")).toBe("Название состава не может быть пустым.");
    expect(await msg("en", " ")).toBe("The lineup name cannot be empty.");
    expect(await msg("ru", "a\nb")).toBe("Название состава должно быть в одну строку.");
    expect(await msg("en", "a\nb")).toBe("The lineup name must be on one line.");
    expect(await msg("en", "x".repeat(101))).toBe("The lineup name must be at most 100 characters.");
    expect(await msg("ru", "A", [p])).toBe("В составе должно быть не меньше двух участников.");
    expect(await msg("en", "A", [p])).toBe("A lineup must have at least two participants.");
    expect(await msg("en", "A", [p, { ...p, model: "" }])).toBe("Every lineup participant must have a provider and a model.");
    const saved = await saveLineup(d, { name: "A", participants: [p, p] });
    expect(await msg("ru", "A")).toBe(`Название «A» уже занято составом ${saved.id}.`);
    expect(await msg("en", "A")).toBe(`The name “A” is already used by lineup ${saved.id}.`);
  });
});

describe("Core messages in the selected language: lineup check", () => {
  const registry = {
    providers: [cli, { id: "gpt", kind: "openai-http", label: "GPT", baseUrl: "http://x", models: [] }],
    defaults: {},
  } as unknown as Parameters<typeof checkLineup>[1]["registry"];
  const st = (id: string, o: Partial<ProviderStatus> = {}) =>
    ({ id, kind: "cli", label: id, available: true, models: ["m1"], modelsConfirmed: true, ...o }) as ProviderStatus;
  const run = (l: "en" | "ru", statuses: ProviderStatus[], participants: [string, string][], scripted: LineupCheckContext["scripted"] = null) =>
    lang(l, () => checkLineup({ id: "l", name: "L", participants: participants.map(([providerId, model]) => ({ providerId, model, role: null })) }, { registry, statuses, scripted }).participants);

  it("reasons and marks in both languages with the same values", () => {
    const ps: [string, string][] = [["scripted", "s"], ["gone", "m1"], ["gpt", DEFAULT_MODEL], ["claude", "zz"]];
    const ru = run("ru", [st("claude", { modelsConfirmed: false, modelsReason: "нет данных" })], ps);
    const en = run("en", [st("claude", { modelsConfirmed: false, modelsReason: "нет данных" })], ps);
    expect(ru.map((x) => x.reason ?? x.modelNote)).toEqual([
      "Сценарные участники доступны только при COUNCIL_DEV=1.",
      "Провайдер «gone» не найден в реестре.",
      "Для провайдера «gpt» нужна модель.",
      "Модели «zz» нет в перечне провайдера «claude» (перечень не подтверждён: нет данных).",
    ]);
    expect(en.map((x) => x.reason ?? x.modelNote)).toEqual([
      "Scripted participants are available only with COUNCIL_DEV=1.",
      "Provider “gone” not found in the registry.",
      "Provider “gpt” needs a model.",
      "Model “zz” is not in the list of provider “claude” (list not confirmed: нет данных).",
    ]);
  });
  it("not inspected and unavailable", () => {
    const ps: [string, string][] = [["claude", "m1"]];
    expect(run("ru", [], ps)[0]!.reason).toBe("Провайдер не осмотрен");
    expect(run("en", [], ps)[0]!.reason).toBe("Provider not inspected");
    expect(run("ru", [st("claude", { available: false })], ps)[0]!.reason).toBe("Провайдер недоступен");
    expect(run("en", [st("claude", { available: false })], ps)[0]!.reason).toBe("Provider unavailable");
  });
});

describe("Core messages in the selected language: provider unavailability reasons", () => {
  const found = async () => ({ agent: "claude" as const, found: true, path: "/x/claude", searchPath: "/x" });
  const http = (o: object = {}) => ({ id: "h", kind: "openai-http" as const, label: "H", baseUrl: "http://x", models: [], ...o });
  const reason = async (l: "en" | "ru", p: Parameters<typeof inspectProvider>[0], o: Parameters<typeof inspectProvider>[1]) => {
    setProcessLanguage(l);
    return (await inspectProvider(p, o)).status;
  };

  it("command not found", async () => {
    const deps = { locate: async () => ({ agent: "claude" as const, found: false, searchPath: "/x" }) };
    expect((await reason("ru", cli as never, { env: {}, deps })).reason).toBe("Команда claude не найдена");
    expect((await reason("en", cli as never, { env: {}, deps })).reason).toBe("Command claude not found");
  });
  it("help not readable", async () => {
    const deps = { locate: found, readHelp: async () => { throw new Error("boom"); } };
    expect((await reason("ru", cli as never, { env: {}, deps })).reason).toBe("Не удалось прочитать справку claude: boom");
    expect((await reason("en", cli as never, { env: {}, deps })).reason).toBe("Could not read the help of claude: boom");
  });
  it("inspection failed", async () => {
    const deps = { locate: async () => { throw new Error("boom"); } };
    expect((await reason("ru", cli as never, { env: {}, deps })).reason).toBe("Осмотр claude завершился ошибкой: boom");
    expect((await reason("en", cli as never, { env: {}, deps })).reason).toBe("Inspection of claude failed: boom");
  });
  it("key not set, default file and set one", async () => {
    const p = http({ apiKeyEnv: "K" });
    expect((await reason("ru", p, { env: {} })).reason).toBe("Ключ не задан: впишите значение переменной K в файл .env папки данных");
    expect((await reason("en", p, { env: {} })).reason).toBe("Key not set: put the value of the variable K into the file .env in the data folder");
    expect((await reason("en", p, { env: {}, keyFile: "/d/.env" })).reason).toContain("into the file /d/.env");
  });
});

describe("Core messages in the selected language: describeIssue", () => {
  const issue = (schema: z.ZodType, value: unknown) => {
    const r = schema.safeParse(value);
    if (r.success) throw new Error("ожидалась проблема");
    return r.error.issues[0]!;
  };
  const cases: [string, z.ZodType, unknown, string, string][] = [
    ["invalid_type number", z.number(), "x", "ожидается число", "expected number"],
    ["invalid_type string", z.string(), 1, "ожидается строка", "expected string"],
    ["invalid_type array", z.array(z.string()), 1, "ожидается массив", "expected array"],
    ["invalid_type object", z.object({}), 1, "ожидается объект", "expected object"],
    ["invalid_type boolean", z.boolean(), 1, "ожидается логическое значение", "expected boolean"],
    ["invalid_type прочее", z.bigint(), 1, "ожидается bigint", "expected bigint"],
    ["too_small string", z.string().min(1), "", "ожидается непустая строка", "expected a non-empty string"],
    ["too_small array", z.array(z.string()).min(2), [], "ожидается не меньше 2 элементов", "expected at least 2 items"],
    ["too_small number", z.number().min(3), 1, "ожидается число не меньше 3", "expected a number not less than 3"],
    ["regex", z.string().regex(/^a$/), "b", "значение не подходит под шаблон /^a$/", "value does not match the pattern /^a$/"],
    ["format", z.email(), "b", "ожидается формат email", "expected format email"],
    ["unrecognized_keys", z.strictObject({}), { a: 1, b: 2 }, "лишнее поле «a», «b»", "extra field «a», «b»"],
    ["invalid_value", z.enum(["x", "y"]), "z", "ожидается одно из: x, y", "expected one of: x, y"],
  ];
  for (const [name, schema, value, ru, en] of cases) {
    it(name, () => {
      const i = issue(schema, value);
      expect(lang("ru", () => describeIssue(i))).toBe(ru);
      expect(lang("en", () => describeIssue(i))).toBe(en);
    });
  }
  it("other codes: zod message as is", () => {
    const i = issue(z.string().refine(() => false, "свой текст"), "a");
    expect(describeIssue(i)).toBe("свой текст");
  });
});
