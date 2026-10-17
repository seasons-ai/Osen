import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage, getProcessLanguage } from "../i18n/process-language.ts";
import { parseTurnResponse } from "./parse.ts";
import { SessionEventSchema, SessionSchema } from "./schema.ts";
import { initialState } from "./state.ts";
import { parseTariffs } from "./tariffs.ts";

const issues = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues.map((i) => i.message) ?? [];
const session = (over: Record<string, unknown> = {}) => ({
  id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "T", templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `N${i}`, providerId: "x", model: "m", role: null })),
  limits: { maxRounds: 5, turnTimeoutSec: 30, contextChars: 20000 }, ...over,
});

describe("Core messages in the selected language: schemas and tariffs", () => {
  const before = getProcessLanguage();
  afterEach(() => setProcessLanguage(before));

  it("SessionSchema: empty topic and synthesizer outside the lineup in both languages", () => {
    const bad = session({ topic: " ", drafts: { enabled: true, synthesizerId: "p9" } });
    setProcessLanguage("en");
    expect(issues(SessionSchema.safeParse(bad))).toEqual(["string must not be blank", "synthesizer p9 is not in the participant list"]);
    setProcessLanguage("ru");
    expect(issues(SessionSchema.safeParse(bad))).toEqual(["строка не должна быть пустой", "синтезатор p9 не входит в список участников"]);
  });

  it("Model request texts are not translated: model response errors are Russian on en", () => {
    const raw = '{"stance":"amend","reasoning":" ","solution":null,"answers":[],"questions":[]}';
    const errors = () => {
      const r = parseTurnResponse(raw, initialState(), "p1");
      return r.ok ? [] : r.errors;
    };
    setProcessLanguage("ru");
    const ru = errors();
    setProcessLanguage("en");
    expect(errors()).toEqual(ru);
    expect(ru).toEqual([
      "reasoning: строка не должна быть пустой",
      'solution: поле solution: при stance "amend" нужен непустой текст новой версии решения',
    ]);
  });

  it("turn_completed event schema: refine message", () => {
    const ev = {
      seq: 1, ts: "2026-01-01T00:00:00Z", type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "agree",
      normalized: false, reasoning: "r", solution: "x", version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 0,
    };
    setProcessLanguage("en");
    expect(issues(SessionEventSchema.safeParse(ev))).toEqual(['field solution: not null if and only if stance is "amend"']);
    setProcessLanguage("ru");
    expect(issues(SessionEventSchema.safeParse(ev))).toEqual(['поле solution: не null тогда и только тогда, когда stance равен "amend"']);
  });

  it("tariffs: reasons and warnings in both languages, enumeration follows the language rules", () => {
    const e = { providerId: "a", model: "b", source: "s", asOf: "2026-01-01", currency: "USD", inputPerMillion: 1, outputPerMillion: 2 };
    const text = JSON.stringify({ tariffs: [e, e, e, { providerId: "" }] });
    setProcessLanguage("en");
    const en = parseTariffs(text).warnings;
    expect(en.some((w) => w.includes("entries 1, 2, and 3 are not applied — duplicate pair a / b"))).toBe(true);
    expect(en.some((w) => w.includes("entry 4 is not applied — providerId: non-empty string"))).toBe(true);
    expect(parseTariffs("{").warnings).toEqual(["tariffs.json: not JSON"]);
    setProcessLanguage("ru");
    const ru = parseTariffs(text).warnings;
    expect(ru.some((w) => w.includes("записи 1, 2 и 3 не применяются — повтор пары a / b"))).toBe(true);
    expect(ru.some((w) => w.includes("запись 4 не применяется — providerId: непустая строка"))).toBe(true);
  });
});
