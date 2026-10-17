import { describe, it, expect } from "vitest";
import { initialState } from "./state.ts";
import type { SessionState, QuestionState } from "./state.ts";
import {
  RAW_LIMIT, extractJsonObject, parseTurnResponse, truncateRaw, buildCorrectionPrompt, parseFileRequest, parseDraftResponse,
} from "./parse.ts";

const q = (id: string, to: string, status: QuestionState["status"]): QuestionState => ({
  id, from: "p1", to, text: "вопрос " + id, turn: 1, status, answer: null,
});
const state = (): SessionState => ({
  ...initialState(),
  versions: [{ number: 1, text: "t", authorId: "p1", turn: 1 }],
  participants: [
    { id: "p1", status: "active", dropReason: null },
    { id: "p2", status: "active", dropReason: null },
    { id: "p3", status: "dropped", dropReason: "x" },
  ],
});
const resp = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ stance: "agree", reasoning: "ок", solution: null, answers: [], questions: [], ...o });
const run = (raw: string, s = state(), id = "p1") => parseTurnResponse(raw, s, id);
const errs = (r: ReturnType<typeof run>) => (r.ok ? [] : r.errors);

describe("extractJsonObject / parseTurnResponse: extraction", () => {
  it("object in a code block with an explanation", () => {
    const raw = `Вот ответ:\n\`\`\`json\n${resp()}\n\`\`\`\nГотово.`;
    expect(run(raw).ok).toBe(true);
  });
  it("plain JSON", () => {
    expect(run(resp()).ok).toBe(true);
  });
  it("object in the middle of text, with brackets and a quote in a string", () => {
    const raw = `Мой ход: ${resp({ reasoning: 'вариант {A} лучше, "B" хуже \\ ' })} спасибо`;
    const r = run(raw);
    expect(r.ok && r.turn.reasoning).toBe('вариант {A} лучше, "B" хуже \\ ');
  });
  it("no object", () => {
    for (const raw of ["просто текст", "[1,2]", "null"]) {
      expect(errs(run(raw))).toEqual(["В ответе не найден JSON-объект."]);
    }
    expect(extractJsonObject("{не json} и {\"a\":1}")).toEqual({ a: 1 });
  });
});

describe("parseTurnResponse: schema", () => {
  it("stance maybe", () => expect(run(resp({ stance: "maybe" })).ok).toBe(false));
  it("empty reasoning", () => {
    const r = run(resp({ reasoning: " " }));
    expect(r.ok).toBe(false);
    expect(errs(r)[0]).toMatch(/^reasoning: /);
  });
  it("amend without solution", () => expect(run(resp({ stance: "amend" })).ok).toBe(false));
  it("agree with solution", () => {
    expect(run(resp({ solution: "текст" })).ok).toBe(false);
    expect(run(resp({ solution: "текст", questions: [{ to: "p2", text: "?" }] })).ok).toBe(false);
  });
  it("object with solution", () => expect(run(resp({ stance: "object", solution: "т" })).ok).toBe(false));
  it("no answers field", () => {
    const o = JSON.parse(resp());
    delete o.answers;
    expect(run(JSON.stringify(o)).ok).toBe(false);
  });
});

describe("parseTurnResponse: state", () => {
  it("first turn: only amend", () => {
    const s = { ...state(), versions: [] };
    expect(run(resp(), s).ok).toBe(false);
    expect(run(resp({ stance: "object" }), s).ok).toBe(false);
    expect(run(resp({ stance: "amend", solution: "v1" }), s).ok).toBe(true);
  });
  it("agree with a question becomes object", () => {
    const r = run(resp({ questions: [{ to: "p2", text: "почему?" }] }));
    expect(r).toMatchObject({
      ok: true, turn: { stance: "object", normalized: true, questions: [{ to: "p2", text: "почему?" }] },
    });
  });
  it("agree without questions", () => {
    expect(run(resp())).toMatchObject({ ok: true, turn: { stance: "agree", normalized: false } });
  });
  it("invalid question addressees", () => {
    expect(errs(run(resp({ questions: [{ to: "p1", text: "?" }] })))).toEqual(["Вопрос самому себе недопустим."]);
    expect(errs(run(resp({ questions: [{ to: "p3", text: "?" }] })))).toEqual(["Вопрос адресован выбывшему участнику p3."]);
    expect(errs(run(resp({ questions: [{ to: "p9", text: "?" }] })))).toEqual(["Вопрос адресован несуществующему участнику p9."]);
  });
  it("no answer to an open question", () => {
    const s = { ...state(), questions: [q("q2", "p1", "open")] };
    const e = errs(run(resp(), s));
    expect(e).toHaveLength(1);
    expect(e[0]).toContain("q2");
  });
  it("answer to an open question is accepted", () => {
    const s = { ...state(), questions: [q("q2", "p1", "open")] };
    const r = run(resp({ answers: [{ questionId: "q2", text: "так" }, { questionId: "q2", text: "иначе" }] }), s);
    expect(r.ok && r.turn.answers).toEqual([{ questionId: "q2", text: "так" }]);
  });
  it("extra answers are dropped", () => {
    const s = { ...state(), questions: [q("q1", "p2", "open"), q("q3", "p1", "answered")] };
    const answers = ["q1", "q3", "q99"].map((questionId) => ({ questionId, text: "т" }));
    const r = run(resp({ answers }), s);
    expect(r.ok && r.turn.answers).toEqual([]);
  });
  it("several errors at once", () => {
    const s = { ...state(), questions: [q("q2", "p1", "open")] };
    const e = errs(run(resp({ questions: [{ to: "p1", text: "?" }] }), s));
    expect(e).toHaveLength(2);
    expect(e.join("\n")).toContain("самому себе");
    expect(e.join("\n")).toContain("q2");
  });
});

describe("truncateRaw / buildCorrectionPrompt", () => {
  it("short string is not changed", () => expect(truncateRaw("abc", "ru")).toBe("abc"));
  it("long string is truncated with a note", () => {
    const raw = "x".repeat(RAW_LIMIT + 50);
    const t = truncateRaw(raw, "ru");
    expect(t.startsWith("x".repeat(RAW_LIMIT) + " … [усечено")).toBe(true);
    expect(t).toContain(`всего ${RAW_LIMIT + 50} символов`);
  });
  it("correction request", () => {
    const raw = "y".repeat(RAW_LIMIT + 1);
    const p = buildCorrectionPrompt("ИСХОДНЫЙ", raw, ["ош1", "ош2"], "ru");
    expect(p.startsWith("ИСХОДНЫЙ\n\n# Исправь предыдущий ответ")).toBe(true);
    expect(p).toContain("- ош1\n- ош2");
    expect(p).toContain(truncateRaw(raw, "ru"));
    expect(p.endsWith("без пояснений вокруг.")).toBe(true);
  });
});

describe("question to the owner", () => {
  const ask = (stance = "object") => run(resp({ stance, questions: [{ to: "owner", text: "что важнее?" }] }));
  it("accepted", () => {
    const r = ask();
    expect(r.ok && r.turn.questions).toEqual([{ to: "owner", text: "что важнее?" }]);
  });
  it("agree with a question to the owner becomes object", () => {
    const r = ask("agree");
    expect(r.ok && r.turn).toMatchObject({ stance: "object", normalized: true });
  });
  it("questions to oneself, to a non-existent one and to a dropped-out one are still invalid", () => {
    expect(errs(run(resp({ questions: [{ to: "p1", text: "x" }] })))).toEqual(["Вопрос самому себе недопустим."]);
    expect(errs(run(resp({ questions: [{ to: "p9", text: "x" }] })))).toEqual(["Вопрос адресован несуществующему участнику p9."]);
    expect(errs(run(resp({ questions: [{ to: "p3", text: "x" }] })))).toEqual(["Вопрос адресован выбывшему участнику p3."]);
  });
});

describe("parseFileRequest", () => {
  it("non-empty files: names", () => {
    expect(parseFileRequest(resp({ files: [" a/b ", "c"] }))).toEqual(["a/b", "c"]);
  });
  it("empty, no field, empty strings, not JSON: null", () => {
    expect(parseFileRequest(resp({ files: [] }))).toBeNull();
    expect(parseFileRequest(resp())).toBeNull();
    expect(parseFileRequest(resp({ files: ["", "  "] }))).toBeNull();
    expect(parseFileRequest("просто текст")).toBeNull();
  });
  it("code block with text around it", () => {
    expect(parseFileRequest("Вот:\n```json\n" + resp({ files: ["a"] }) + "\n```\nготово")).toEqual(["a"]);
  });
  it("other fields are invalid: names anyway", () => {
    expect(parseFileRequest(JSON.stringify({ stance: "???", files: ["a"] }))).toEqual(["a"]);
  });
  it("parseTurnResponse accepts files, and without them", () => {
    expect(run(resp({ files: ["a"] })).ok).toBe(true);
    expect(run(resp()).ok).toBe(true);
  });
});

describe("parseDraftResponse", () => {
  const amend = (o: Record<string, unknown> = {}) =>
    JSON.stringify({ stance: "amend", reasoning: "обосн", solution: "РЕШЕНИЕ", answers: [], questions: [], ...o });
  const dErrs = (raw: string) => {
    const r = parseDraftResponse(raw, "ru");
    return r.ok ? [] : r.errors;
  };
  it("valid amend", () => {
    expect(parseDraftResponse(amend(), "ru")).toEqual({ ok: true, draft: { solution: "РЕШЕНИЕ", reasoning: "обосн" } });
  });
  it("agree and object are rejected", () => {
    expect(dErrs(amend({ stance: "agree", solution: null }))).toContain("В независимом черновике допустима только позиция amend.");
    expect(dErrs(amend({ stance: "object", solution: null }))).toContain("В независимом черновике допустима только позиция amend.");
  });
  it("questions to the owner and to a participant are rejected", () => {
    const msg = "В независимом черновике нельзя задавать вопросы, в том числе владельцу.";
    expect(dErrs(amend({ questions: [{ to: "owner", text: "?" }] }))).toContain(msg);
    expect(dErrs(amend({ questions: [{ to: "p2", text: "?" }] }))).toContain(msg);
  });
  it("non-empty answers are rejected", () => {
    expect(dErrs(amend({ answers: [{ questionId: "q1", text: "x" }] }))).toContain(
      "В независимом черновике поле answers должно быть пустым.",
    );
  });
  it("non-JSON is rejected as in parseTurnResponse", () => {
    const r = parseDraftResponse("просто текст", "ru");
    expect(r).toEqual({ ok: false, errors: ["В ответе не найден JSON-объект."] });
    expect(errs(run("просто текст"))).toEqual(dErrs("просто текст"));
  });
  it("files is ignored", () => {
    expect(parseDraftResponse(amend({ files: ["a.md"] }), "ru").ok).toBe(true);
  });
});

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Parsing a response does not depend on language", () => {
  const session = (language: "en" | "ru") => ({
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli" as const, topic: "t", templateId: null, framing: "",
    participants: ["p1", "p2", "p3"].map((id) => ({ id, name: id, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 1, contextChars: 1 }, language,
  });
  const withLang = (s: SessionState, language: "en" | "ru"): SessionState => ({ ...s, session: session(language) });

  // Responses at the boundaries: empty strings, extra and missing fields, wrong types and positions, questions to oneself, to dropped-out participants, to the owner.
  function genResponse(rnd: () => number): string {
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    if (rnd() < 0.08) return pick(["", "не JSON", "{", "[]", "```json\n{}\n```"]);
    if (rnd() < 0.4) {
      const stance = pick(["amend", "agree", "object"]);
      return JSON.stringify({ stance, reasoning: "r", solution: stance === "amend" ? "text" : null, answers: [{ questionId: "q1", text: "a" }], questions: rnd() < 0.5 ? [] : [{ to: pick(["p2", "owner"]), text: "?" }], files: [] });
    }
    const o: Record<string, unknown> = {
      stance: pick(["amend", "agree", "object", "maybe", 1]),
      reasoning: pick(["r", "", "  ", 5]),
      solution: pick([null, "", " ", "text"]),
      answers: pick([[], [{ questionId: "q1", text: "a" }], [{ questionId: "q1", text: " " }], "x"]),
      questions: pick([[], [{ to: "p2", text: "?" }], [{ to: "p1", text: "?" }], [{ to: "p3", text: "?" }], [{ to: "p9", text: "?" }], [{ to: "owner", text: "" }]]),
      files: pick([[], ["a"], undefined]),
    };
    if (rnd() < 0.15) delete o[pick(Object.keys(o))];
    if (rnd() < 0.1) o.extra = 1;
    return JSON.stringify(o);
  }

  it("One response in two languages: the decision to accept or reject and the result are the same (property, 2000 responses)", () => {
    const rnd = mulberry32(63);
    let accepted = 0, rejected = 0;
    for (let i = 0; i < 2000; i++) {
      const raw = genResponse(rnd);
      const base = rnd() < 0.5 ? state() : { ...state(), versions: [], questions: [q("q1", "p1", "open")] };
      const en = parseTurnResponse(raw, withLang(base, "en"), "p1");
      const ru = parseTurnResponse(raw, withLang(base, "ru"), "p1");
      expect(en.ok, raw).toBe(ru.ok);
      if (en.ok && ru.ok) { expect(en.turn, raw).toEqual(ru.turn); accepted++; }
      else if (!en.ok && !ru.ok) { expect(en.errors.length, raw).toBe(ru.errors.length); rejected++; }
      const de = parseDraftResponse(raw, "en"), dr = parseDraftResponse(raw, "ru");
      expect(de.ok, raw).toBe(dr.ok);
      if (de.ok && dr.ok) expect(de.draft).toEqual(dr.draft);
    }
    expect(accepted).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(50);
  });

  it("The same failure: an invalid response is rejected in both languages, only the text differs", () => {
    const raw = JSON.stringify({ stance: "amend", reasoning: " ", solution: "x", answers: [], questions: [{ to: "p1", text: "?" }] });
    const noAnswers = JSON.stringify({ stance: "agree", reasoning: "r", solution: null, questions: [] });
    expect(parseTurnResponse(noAnswers, withLang(state(), "en"), "p1")).toEqual(parseTurnResponse(noAnswers, withLang(state(), "ru"), "p1"));
    expect(parseTurnResponse(noAnswers, withLang(state(), "en"), "p1").ok).toBe(false);
    const en = parseTurnResponse(raw, withLang(state(), "en"), "p1");
    const ru = parseTurnResponse(raw, withLang(state(), "ru"), "p1");
    expect(en).toEqual({ ok: false, errors: ["reasoning: string must not be blank"] });
    expect(ru).toEqual({ ok: false, errors: ["reasoning: строка не должна быть пустой"] });
    expect(errs(parseTurnResponse(resp({ questions: [{ to: "p1", text: "?" }] }), withLang(state(), "en"), "p1"))).toEqual(["A question to yourself is not allowed."]);
    expect(parseDraftResponse("text", "en")).toEqual({ ok: false, errors: ["No JSON object found in the answer."] });
    expect(truncateRaw("x".repeat(RAW_LIMIT + 1), "en").endsWith(` … [truncated, ${RAW_LIMIT + 1} characters in total]`)).toBe(true);
  });
});
