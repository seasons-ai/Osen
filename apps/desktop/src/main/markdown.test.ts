import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setProcessLanguage } from "@model-council/core/i18n";
import { SNAPSHOT_CASES, SNAPSHOT_CREATED_AT, SNAPSHOT_SELECTED_AT } from "./markdown.fixture.testutil.ts";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent } from "@model-council/core/protocol";
import { sessionMarkdown } from "./markdown.ts";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const fold = (bodies: Body[]) => foldEvents(bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent));
const created = (n = 3): Body => ({
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Цена", templateId: null, framing: "",
    participants: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Имя${i + 1}`, providerId: "scripted", model: "m", role: i === 0 ? "критик" : null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  },
});
const started = (turn: number, participantId: string): Body => ({ type: "turn_started", turn, round: 1, participantId });
const done = (
  turn: number, participantId: string, stance: "amend" | "agree" | "object", version: number,
  x: { reasoning?: string; questions?: { id: string; to: string; text: string }[]; answers?: { questionId: string; text: string }[] } = {},
): Body => ({
  type: "turn_completed", turn, round: 1, participantId, stance, normalized: false, reasoning: x.reasoning ?? `аргумент ${turn}`,
  solution: stance === "amend" ? `текст v${version}` : null, version, questions: x.questions ?? [], answers: x.answers ?? [],
  attempts: 1, usage: {}, durationMs: 5,
});
const fail = (turn: number, participantId: string, attempt: number): Body => ({
  type: "turn_failed", turn, round: 1, participantId, attempt, kind: "invalid_response", message: "мусор",
});

describe("sessionMarkdown", () => {
  it("agreement: all sections, no objections, one line break", () => {
    const md = sessionMarkdown(fold([
      created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1),
      { type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [] } as Body,
    ]), "consensus");
    for (const s of ["# Osen: обсуждение", "## Тема\n\nЦена", "- Статус: согласие достигнуто", "- Кругов: 1 из 3, ходов: 2",
      "1. Имя1 — scripted:m, роль: критик", "2. Имя2 — scripted:m, роль: без роли", "Версия 1, автор: Имя1. Согласны: Имя1, Имя2.",
      "### Ход 1 · круг 1 · Имя1 — правит (версия 1)", "**Версия 1:**\n\nтекст v1", "### Ход 2 · круг 1 · Имя2 — согласен\n\nаргумент 2"]) expect(md).toContain(s);
    expect(md).not.toContain("## Возражения");
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  it("no agreement: objections with an argument", () => {
    const md = sessionMarkdown(fold([
      created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1, { reasoning: "дорого" }),
      { type: "session_finished", status: "no_consensus", version: 1, agreed: ["p1"], objectors: [{ participantId: "p2", reasoning: "дорого" }] } as Body,
    ]), "no_consensus");
    expect(md).toContain("- Статус: согласия нет");
    expect(md).toContain("## Возражения\n\n- Имя2: дорого");
    expect(md).toContain("— возражает");
  });

  it("questions: addressee, status, quote, no answer for a dropped participant", () => {
    const md = sessionMarkdown(fold([
      created(3), started(1, "p1"),
      done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p2", text: "Сколько?" }, { id: "q2", to: "p3", text: "Когда?" }] }),
      started(2, "p2"), done(2, "p2", "agree", 1, { answers: [{ questionId: "q1", text: "Сто" }] }),
      { type: "participant_dropped", participantId: "p3", reason: "таймаут" } as Body,
      { type: "question_closed", questionId: "q1", reason: "answered" } as Body,
      { type: "question_closed", questionId: "q2", reason: "unanswered" } as Body,
    ]), "running");
    expect(md).toContain("**Вопрос q1 → Имя2:** Сколько? (отвечен)");
    expect(md).toContain("**Вопрос q2 → Имя3:** Когда? (остался без ответа)");
    expect(md).toContain("**Ответ на q1** (вопрос от Имя1: «Сколько?»): Сто");
    expect(md).toContain("3. Имя3 — scripted:m, роль: без роли — выбыл: таймаут");
    expect(md).toContain("- Статус: идёт");
  });

  it("failure before the first solution", () => {
    const md = sessionMarkdown(fold([
      created(2), started(1, "p1"), fail(1, "p1", 1),
      { type: "session_finished", status: "failed", version: null, agreed: [], objectors: [], reason: "нет участников" } as Body,
    ]), "failed");
    expect(md).toContain("Решения нет.");
    expect(md).toContain("Причина: нет участников");
    expect(md).toContain("- Сбой: ход 1 · Имя1 · попытка 1 — некорректный ответ: мусор.");
    expect(md).not.toContain("Повтор.");
  });

  it("failures and dropping out during the discussion", () => {
    const md = sessionMarkdown(fold([
      created(3), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), fail(2, "p2", 1), fail(2, "p2", 2),
      { type: "participant_dropped", participantId: "p2", reason: "таймаут" } as Body,
    ]), "running");
    expect(md).toContain("- Сбой: ход 2 · Имя2 · попытка 1 — некорректный ответ: мусор. Повтор.\n- Сбой: ход 2 · Имя2 · попытка 2 — некорректный ответ: мусор.\n- Имя2 выбыл: таймаут");
  });

  it("interrupted; no turns", () => {
    const md = sessionMarkdown(fold([created(2)]), "interrupted");
    expect(md).toContain("- Статус: прервана");
    expect(md).toContain("Ходов нет.");
    expect(md).toContain("Решения нет.");
  });

  it("session === null", () => {
    expect(() => sessionMarkdown(foldEvents([]), "running")).toThrow("Сессия не содержит события создания");
  });
});

describe("sessionMarkdown: objections outside no_consensus", () => {
  it("stopped: only the one who actually objected", () => {
    const md = sessionMarkdown(fold([
      created(3), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1, { reasoning: "дорого" }),
      { type: "session_finished", status: "stopped", version: 1, agreed: [], objectors: [{ participantId: "p2", reasoning: "дорого" }, { participantId: "p3", reasoning: null }] } as Body,
    ]), "stopped");
    expect(md).toContain("## Возражения\n\n- Имя2: дорого");
    expect(md).not.toContain("- Имя3: аргумент не записан");
  });
  it("failed before the first version: no section", () => {
    const md = sessionMarkdown(fold([
      created(2),
      { type: "session_finished", status: "failed", version: null, agreed: [], objectors: [{ participantId: "p2", reasoning: null }], reason: "сбой" } as Body,
    ]), "failed");
    expect(md).not.toContain("## Возражения");
  });
});

describe("sessionMarkdown: owner choice", () => {
  const pick = (x: { note?: string; statusAtSelection?: "consensus" | "no_consensus" | "stopped" | "failed" } = {}): Body =>
    ({ type: "owner_selected_version", version: 1, statusAtSelection: x.statusAtSelection ?? "no_consensus", ...(x.note ? { note: x.note } : {}) }) as Body;
  const finish = { type: "session_finished", status: "no_consensus", version: 3, agreed: ["p1"], objectors: [{ participantId: "p2", reasoning: "дорого" }] } as Body;
  const base: Body[] = [
    created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2),
    started(3, "p1"), done(3, "p1", "amend", 3), started(4, "p2"), done(4, "p2", "object", 3, { reasoning: "дорого" }), finish,
  ];
  const cut = (md: string) => md.replace(/## Выбор владельца[\s\S]*?(?=## Ход обсуждения)/, "");

  it("section after objections and before the discussion course; the result and status unchanged", () => {
    const md = sessionMarkdown(fold([...base, pick({ note: "Первая проще" })]), "no_consensus");
    expect(md).toContain("- Статус: согласия нет");
    expect(md).toContain("## Итоговое решение\n\nВерсия 3, автор: Имя1.");
    expect(md).toContain("текст v3");
    expect(md).toContain("## Возражения\n\n- Имя2: дорого");
    expect(md).toContain("## Выбор владельца\n\nВерсия 1, автор: Имя1. Выбрана ");
    expect(md).toContain("Статус на момент выбора: согласия нет. Это выбор владельца, а не согласие моделей.");
    expect(md).toContain("Заметка: Первая проще\n\nтекст v1\n\n## Ход обсуждения");
    expect(md.indexOf("## Выбор владельца")).toBeGreaterThan(md.indexOf("## Возражения"));
    expect(md.indexOf("## Выбор владельца")).toBeLessThan(md.indexOf("## Ход обсуждения"));
    expect(md).not.toContain("согласие достигнуто");
  });

  it("without a note there is no \"Note:\" line", () => {
    expect(sessionMarkdown(fold([...base, pick()]), "no_consensus")).not.toContain("Заметка:");
  });

  it("without a choice there is no section, the rest of the output does not change", () => {
    const plain = sessionMarkdown(fold(base), "no_consensus");
    const withPick = sessionMarkdown(fold([...base, pick({ note: "н" })]), "no_consensus");
    expect(plain).not.toContain("## Выбор владельца");
    expect(cut(withPick)).toBe(plain);
  });

  it("choice, then resume and a new finish: the choice status unchanged, the header current", () => {
    const md = sessionMarkdown(fold([
      ...base, pick(),
      { type: "session_resumed", pid: 1, maxRounds: 5 } as Body,
      started(5, "p1"), done(5, "p1", "agree", 3), started(6, "p2"), done(6, "p2", "agree", 3),
      { type: "session_finished", status: "consensus", version: 3, agreed: ["p1", "p2"], objectors: [] } as Body,
    ]), "consensus");
    expect(md).toContain("- Статус: согласие достигнуто");
    expect(md).toContain("## Выбор владельца");
    expect(md).toContain("Статус на момент выбора: согласия нет.");
  });
});

describe("sessionMarkdown: materials", () => {
  const base = created(2) as Extract<Body, { type: "session_created" }>;
  const mats = [{ id: "m1", name: "notes.md", chars: 120, sha256: "c".repeat(64) }, { id: "m2", name: "b.txt", chars: 3, sha256: "d".repeat(64) }];
  const tail: Body[] = [started(1, "p1"), done(1, "p1", "amend", 1), { type: "session_finished", status: "stopped", version: 1, agreed: [], objectors: [] } as Body];
  it("section between \"Participants\" and \"Final solution\"", () => {
    const md = sessionMarkdown(fold([{ ...base, session: { ...base.session, materials: mats } }, ...tail]), "stopped");
    const a = md.indexOf("## Участники"), m = md.indexOf("## Материалы"), r = md.indexOf("## Итоговое решение");
    expect(a).toBeGreaterThan(-1);
    expect(m).toBeGreaterThan(a);
    expect(r).toBeGreaterThan(m);
    expect(md).toContain("- notes.md — 120 знаков\n- b.txt — 3 знака\n\nВсего: 2 материала, 123 знака");
    expect(md).not.toContain("sha256");
    expect(md).not.toContain("cccc");
  });
  it("without materials there is no section, the output is unchanged", () => {
    const plain = sessionMarkdown(fold([base, ...tail]), "stopped");
    const empty = sessionMarkdown(fold([{ ...base, session: { ...base.session, materials: [] } }, ...tail]), "stopped");
    expect(plain).not.toContain("## Материалы");
    expect(empty).toBe(plain);
  });

  describe("owner messages", () => {
    const ask = (to = "owner"): Body => done(1, "p1", "amend", 1, { questions: [{ id: "q1", to, text: "Какой бюджет?" }] });
    const say = (id: string, afterTurn: number, text: string, answers?: { questionId: string; text: string }[]): Body =>
      ({ type: "owner_message", id, text, afterTurn, requestId: `r-${id}`, ...(answers ? { answers } : {}) }) as Body;
    const at = (md: string, s: string) => md.indexOf(s);

    it("after turn 2 — between turns 2 and 3", () => {
      const md = sessionMarkdown(fold([
        created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1),
        say("o1", 2, "Учтите срок"), started(3, "p3"), done(3, "p3", "agree", 1),
      ]), "running");
      const h = "### Владелец · o1 · после хода 2\n\nУчтите срок";
      expect(at(md, h)).toBeGreaterThan(at(md, "### Ход 2 "));
      expect(at(md, h)).toBeLessThan(at(md, "### Ход 3 "));
    });

    it("before the first turn — before turn 1", () => {
      const md = sessionMarkdown(fold([created(), say("o1", 0, "Старт"), started(1, "p1"), done(1, "p1", "amend", 1)]), "running");
      expect(at(md, "### Владелец · o1 · до первого хода\n\nСтарт")).toBeGreaterThan(-1);
      expect(at(md, "### Владелец · o1")).toBeLessThan(at(md, "### Ход 1 "));
    });

    it("an answer with the same text is not duplicated; the question is answered, the addressee is Owner", () => {
      const md = sessionMarkdown(fold([
        created(), started(1, "p1"), ask(), say("o1", 1, "Сто", [{ questionId: "q1", text: "Сто" }]),
        { type: "question_closed", questionId: "q1", reason: "answered" } as Body,
      ]), "running");
      expect(md).toContain("**Вопрос q1 → Владелец:** Какой бюджет? (отвечен)");
      expect(md).toContain("### Владелец · o1 · после хода 1\n\n**Ответ на q1** (вопрос от Имя1: «Какой бюджет?»): Сто\n");
      expect(md.split("Сто").length - 1).toBe(1);
    });

    it("an answer and a separate text — both", () => {
      const md = sessionMarkdown(fold([
        created(), started(1, "p1"), ask(), say("o1", 1, "Сто, но не больше", [{ questionId: "q1", text: "Сто" }]),
      ]), "running");
      expect(md).toContain("**Ответ на q1** (вопрос от Имя1: «Какой бюджет?»): Сто\n\nСто, но не больше");
    });

    it("closed without an answer only for the owner", () => {
      const md = sessionMarkdown(fold([
        created(), started(1, "p1"),
        done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "owner", text: "А?" }, { id: "q2", to: "p2", text: "Б?" }] }),
        { type: "question_closed", questionId: "q1", reason: "unanswered" } as Body,
        { type: "question_closed", questionId: "q2", reason: "unanswered" } as Body,
      ]), "running");
      expect(md).toContain("**Вопрос q1 → Владелец:** А? (закрыт без ответа)");
      expect(md).toContain("**Вопрос q2 → Имя2:** Б? (остался без ответа)");
    });

    it("two messages after one turn — in order of application", () => {
      const md = sessionMarkdown(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), say("o1", 1, "раз"), say("o2", 1, "два")]), "running");
      expect(at(md, "### Владелец · o1")).toBeGreaterThan(-1);
      expect(at(md, "### Владелец · o1")).toBeLessThan(at(md, "### Владелец · o2"));
    });

    it("a turn failure before a message stands above its heading", () => {
      const md = sessionMarkdown(fold([created(), started(1, "p1"), fail(1, "p1", 1), say("o1", 1, "реплика")]), "running");
      expect(at(md, "- Сбой: ход 1")).toBeGreaterThan(-1);
      expect(at(md, "- Сбой: ход 1")).toBeLessThan(at(md, "### Владелец · o1"));
    });

    it("without messages and owner questions — a section without mentions of the owner", () => {
      const md = sessionMarkdown(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1)]), "running");
      expect(md).not.toContain("Владелец");
    });
  });
});

describe("sessionMarkdown: participant replacement", () => {
  const newbie = { id: "p4", name: "Новый", providerId: "scripted", model: "m", role: null };
  const resumed = (old: string): Body[] => [
    { type: "session_finished", status: "failed", version: 1, agreed: [], objectors: [] } as Body,
    { type: "session_resumed", pid: 2, maxRounds: 5, replacements: [{ oldParticipantId: old, participant: newbie }] } as Body,
  ];
  const lines = (md: string) => md.split("\n");
  it("dropped and replaced: replaced by a participant, the reason after a semicolon", () => {
    const md = sessionMarkdown(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), { type: "participant_dropped", participantId: "p2", reason: "таймаут" }, ...resumed("p2")]), "running");
    expect(lines(md)).toContain("2. Имя2 — scripted:m, роль: без роли — заменён участником p4 «Новый»; выбыл: таймаут");
    expect(lines(md)).toContain("4. Новый — scripted:m, роль: без роли — заменил p2");
    expect(md).not.toContain("причина не указана");
  });
  it("replaced by an active one: without a drop reason", () => {
    const md = sessionMarkdown(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), ...resumed("p3")]), "running");
    expect(lines(md)).toContain("3. Имя3 — scripted:m, роль: без роли — заменён участником p4 «Новый»");
    expect(lines(md)).toContain("1. Имя1 — scripted:m, роль: критик");
  });
  it("the question word for the replaced one", () => {
    const md = sessionMarkdown(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p2", text: "?" }] }), ...resumed("p2")]), "running");
    expect(md).toContain("(закрыт: участник заменён)");
  });
  it("without replacements the export is unchanged", () => {
    const md = sessionMarkdown(fold([created(), { type: "participant_dropped", participantId: "p2", reason: "таймаут" }]), "running");
    expect(lines(md)).toContain("2. Имя2 — scripted:m, роль: без роли — выбыл: таймаут");
    expect(md).not.toContain("заменён");
  });
});

describe("sessionMarkdown: replaced by an active one did not drop out", () => {
  const newbie = { id: "p4", name: "Новый", providerId: "scripted", model: "m", role: null };
  const tail: Body[] = [
    { type: "session_finished", status: "stopped", version: 1, agreed: [], objectors: [] } as Body,
    { type: "session_resumed", pid: 2, maxRounds: 5, replacements: [{ oldParticipantId: "p2", participant: newbie }] } as Body,
  ];
  it("a failed attempt without dropping out: no \"dropped out\" line in the discussion course", () => {
    const md = sessionMarkdown(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), fail(2, "p2", 1), ...tail]), "running");
    expect(md).toContain("- Сбой: ход 2");
    expect(md).not.toContain("выбыл");
  });
  it("dropped and replaced: the \"dropped out\" line remains", () => {
    const md = sessionMarkdown(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), fail(2, "p2", 1), fail(2, "p2", 2),
      { type: "participant_dropped", participantId: "p2", reason: "таймаут" }, ...tail]), "running");
    expect(md).toContain("- Имя2 выбыл: таймаут");
  });
});

describe("sessionMarkdown: language", () => {
  afterEach(() => { setProcessLanguage("ru"); });
  const rich = SNAPSHOT_CASES.find((c) => c.name === "rich")!;

  for (const c of SNAPSHOT_CASES) {
    it(`ru reference: ${c.name}`, () => {
      const ref = readFileSync(join(import.meta.dirname, "testdata", `export-ru-${c.name}.md`), "utf8")
        .replaceAll("{{DATE}}", new Date(SNAPSHOT_CREATED_AT).toLocaleDateString("ru-RU"))
        .replaceAll("{{WHEN}}", new Date(SNAPSHOT_SELECTED_AT).toLocaleString("ru-RU"));
      expect(sessionMarkdown(c.state, c.status)).toBe(ref);
    });
  }

  it("en: English labels, the recorded text verbatim", () => {
    const md = sessionMarkdown(rich.state, rich.status, "en");
    for (const s of ["# Osen: discussion", "## Topic", "- Status: no consensus", "- Rounds: 3 of 5, turns: 4", "## Participants", "## Materials",
      "## Final solution", "## Objections", "## Owner's choice", "## Discussion log", "### Turn 1 · round 1 · Первый — amends (version 1)",
      "**Question q1 → Owner:**", "(answered)", "- Failure: turn 2",
      "Цена продукта", "Решение версии 1: цена 100 рублей.", "Первый аргумент.", "Бюджет сто тысяч. И срок — месяц.", "Первая проще", "заметки.md", "- Третий dropped out: таймаут хода"]) expect(md).toContain(s);
    for (const s of ["Статус", "Участники", "Ход обсуждения", "выбыл:", "Версия", "Кругов"]) expect(md).not.toContain(s);
  });

  it("material size: 1 and 5 characters by language", () => {
    const en = sessionMarkdown(rich.state, rich.status, "en");
    expect(en).toContain("заметки.md — 1 character");
    expect(en).toContain("b.txt — 5 characters");
    const ru = sessionMarkdown(rich.state, rich.status, "ru");
    expect(ru).toContain("заметки.md — 1 знак\n");
    expect(ru).toContain("b.txt — 5 знаков");
  });

  it("date by language", () => {
    expect(sessionMarkdown(rich.state, rich.status, "en")).toContain(`- Date: ${new Intl.DateTimeFormat("en").format(new Date(SNAPSHOT_CREATED_AT))}`);
    expect(sessionMarkdown(rich.state, rich.status, "ru")).toContain(`- Дата: ${new Date(SNAPSHOT_CREATED_AT).toLocaleDateString("ru-RU")}`);
  });

  it("the language is taken at export time, the state does not change", () => {
    const f = SNAPSHOT_CASES.find((c) => c.name === "failed")!;
    const copy = structuredClone(f.state);
    setProcessLanguage("ru");
    const ru = sessionMarkdown(f.state, f.status);
    setProcessLanguage("en");
    const en = sessionMarkdown(f.state, f.status);
    expect(ru).toContain("## Ход обсуждения");
    expect(ru).toContain("Причина: Активных участников осталось меньше двух.");
    expect(en).toContain("## Discussion log");
    expect(en).toContain("Reason: Fewer than two active participants remain.");
    expect(en).not.toContain("Активных участников");
    expect(f.state).toEqual(copy);
  });

  it("a reason with a code — by the code in the export language, without a code — as recorded", () => {
    const f = SNAPSHOT_CASES.find((c) => c.name === "failed")!;
    const finish = { ...f.state.finish!, reason: "Fewer than two active participants remain." }; // recorded by the engine in en
    const enRecorded = { ...f.state, finish };
    expect(sessionMarkdown(enRecorded, "failed", "ru")).toContain("Причина: Активных участников осталось меньше двух.");
    const noCode = { ...f.state, finish: { ...finish, reason: "нет участников", reasonCode: null } };
    expect(sessionMarkdown(noCode, "failed", "en")).toContain("Reason: нет участников");
  });

  it("a session without creation: the English refusal text", () => {
    setProcessLanguage("en");
    expect(() => sessionMarkdown(fold([]), "running")).toThrow("The session has no creation event");
  });
});

describe("sessionMarkdown: partially read journal", () => {
  const st = () => fold([created(2)]);
  const plain = sessionMarkdown(st(), "interrupted", "ru");
  it("newer_version: a mark, a blank line, a heading; the status replaced by a badge", () => {
    const ru = sessionMarkdown(st(), "interrupted", "ru", { reason: "newer_version", lastEvent: 5 });
    const l = ru.split("\n");
    expect(l[0]).toContain("Показано начало журнала до события №5");
    expect(l[1]).toBe("");
    expect(l[2]!.startsWith("# ")).toBe(true);
    expect(ru).not.toContain("Статус: прервана");
    expect(ru).toContain("- Статус: нужна новая версия");
    const en = sessionMarkdown(st(), "interrupted", "en", { reason: "newer_version", lastEvent: 5 });
    expect(en.split("\n")[0]).toContain("Showing the start of the journal up to event No. 5");
    expect(en).toContain("- Status: newer version needed");
    expect(en).not.toContain("Status: interrupted");
  });
  it("corrupted: the first line and the status", () => {
    const md = sessionMarkdown(st(), "interrupted", "ru", { reason: "corrupted", lastEvent: 4 });
    expect(md.split("\n")[0]).toBe("> Журнал повреждён: показано начало до события №4");
    expect(md).toContain("- Статус: журнал повреждён");
  });
  it("without partial the export has no mark", () => {
    expect(sessionMarkdown(st(), "interrupted", "ru", null)).toBe(plain);
    expect(plain.startsWith("# ")).toBe(true);
    expect(plain).toContain("- Статус: прервана");
  });
});

describe("sessionMarkdown: reason in words, not a code", () => {
  const fin = (status: "stopped" | "failed", reason: string): Body =>
    ({ type: "session_finished", status, version: 1, agreed: [], objectors: [], reason }) as Body;
  const capped = () => fold([
    { ...created(2), session: { ...(created(2) as { session: object }).session, limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000, maxTotalTokens: 200 } } } as Body,
    started(1, "p1"), { ...done(1, "p1", "amend", 1), usage: { inputTokens: 60, outputTokens: 40 } } as Body, fin("stopped", "token_cap"),
  ]);
  const withDrafts = (reason: string) => fold([
    { ...created(2), session: { ...(created(2) as { session: object }).session, drafts: { enabled: true, synthesizerId: "p2" } } } as Body,
    fin("failed", reason),
  ]);

  it("token_cap: \"N of M tokens spent\", no code", () => {
    const md = sessionMarkdown(capped(), "stopped", "ru");
    expect(md).toContain("Причина: Израсходовано 100 из 200 токенов.");
    expect(md).not.toContain("token_cap");
    const en = sessionMarkdown(capped(), "stopped", "en");
    expect(en).toContain("Reason: 100 of 200 tokens spent.");
    expect(en).not.toContain("token_cap");
  });

  it("token_cap: \"of CAP\" declines by the ceiling — \"21 of 21 tokens spent.\"", () => {
    const cap21 = fold([
      { ...created(2), session: { ...(created(2) as { session: object }).session, limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000, maxTotalTokens: 21 } } } as Body,
      started(1, "p1"), { ...done(1, "p1", "amend", 1), usage: { inputTokens: 21, outputTokens: 0 } } as Body, fin("stopped", "token_cap"),
    ]);
    expect(sessionMarkdown(cap21, "stopped", "ru")).toContain("Причина: Израсходовано 21 из 21 токена.");
    expect(sessionMarkdown(cap21, "stopped", "en")).toContain("Reason: 21 of 21 tokens spent.");
  });

  it("synthesizer_unavailable: the synthesizer name, no code", () => {
    const ru = sessionMarkdown(withDrafts("synthesizer_unavailable"), "failed", "ru");
    expect(ru).toContain("Причина: Синтезатор «Имя2» выбыл, не создав версию 1.");
    expect(ru).not.toContain("synthesizer_unavailable");
    const en = sessionMarkdown(withDrafts("synthesizer_unavailable"), "failed", "en");
    expect(en).toContain("Reason: Synthesizer “Имя2” dropped out before creating version 1.");
    expect(en).not.toContain("synthesizer_unavailable");
  });

  it("draft_context_limit: the limit text, no code", () => {
    const ru = sessionMarkdown(withDrafts("draft_context_limit"), "failed", "ru");
    expect(ru).toContain("Причина: Суммарный текст независимых черновиков превысил лимит контекста");
    expect(ru).not.toContain("draft_context_limit");
    const en = sessionMarkdown(withDrafts("draft_context_limit"), "failed", "en");
    expect(en).toContain("Reason: The combined text of the independent drafts exceeded the context limit");
    expect(en).not.toContain("draft_context_limit");
  });

  it("without a finish there is no reason line", () => {
    expect(sessionMarkdown(fold([created(2)]), "running", "ru")).not.toContain("Причина:");
  });
});

describe("sessionMarkdown: objections without session_finished (change 109)", () => {
  const body: Body[] = [created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1, { reasoning: "дорого" })];
  const section = (md: string) => md.slice(md.indexOf("## Возражения"), md.indexOf("## Ход обсуждения"));

  it("interrupted: only p2 objects, with an argument", () => {
    const md = sessionMarkdown(fold([...body, { type: "turn_started", turn: 3, round: 2, participantId: "p1" } as Body]), "interrupted");
    expect(md).toContain("## Возражения\n\n- Имя2: дорого");
    expect(section(md)).not.toContain("Имя1");
  });
  it("partial newer_version journal: the same", () => {
    const md = sessionMarkdown(fold(body), "interrupted", undefined, { reason: "newer_version", lastEvent: 5 });
    expect(md).toContain("## Возражения\n\n- Имя2: дорого");
    expect(section(md)).not.toContain("Имя1");
  });
  it("no_consensus without a finish event: all who do not agree", () => {
    // p1 edited (agrees), p2 objects; p3 did not take a turn — does not agree
    const md = sessionMarkdown(fold([created(3), ...body.slice(1)]), "no_consensus");
    expect(section(md)).toContain("- Имя2: дорого");
    expect(section(md)).toContain("- Имя3: аргумент не записан");
    expect(section(md)).not.toContain("Имя1");
  });
  it("interrupted: a participant who did not take a turn does not get into the section", () => {
    const md = sessionMarkdown(fold([created(3), ...body.slice(1)]), "interrupted");
    expect(section(md)).toContain("- Имя2: дорого");
    expect(section(md)).not.toContain("Имя3");
  });
});

describe("sessionMarkdown: independent drafts (change 109)", () => {
  afterEach(() => { setProcessLanguage("ru"); });
  const SHA = "a".repeat(64);
  const names = (en: boolean) => (en ? ["Alpha", "Beta", "Gamma"] : ["Имя1", "Имя2", "Имя3"]);
  const make = (en: boolean, synth = "p2"): Body => {
    const c = created(3) as Extract<Body, { type: "session_created" }>;
    return { ...c, session: { ...c.session, topic: en ? "Price" : "Цена", participants: c.session.participants.map((p, i) => ({ ...p, name: names(en)[i]!, role: null })), drafts: { enabled: true, synthesizerId: synth } } };
  };
  const dst = (d: string, p: string, attempt = 1): Body => ({ type: "draft_attempt_started", draftId: d, participantId: p, attempt });
  const dfail = (d: string, p: string, attempt: number): Body => ({ type: "draft_attempt_failed", draftId: d, participantId: p, attempt, kind: "timeout", message: "slow." });
  const dok = (d: string, p: string, attempts = 1, chars = 12): Body =>
    ({ type: "draft_completed", draftId: d, participantId: p, attempts, durationMs: 1, usage: {}, chars, sha256: SHA, reasoning: `reason-${d}` });
  const fin: Body = { type: "drafts_finished" };
  const views = [1, 2, 3].map((i) => ({ draftId: `d${i}`, participantId: `p${i}`, attempts: i === 1 ? 2 : 1, chars: 12, reasoning: `reason-d${i}`, text: `TEXT-FULL-${i}`, error: null }));
  const full = (en: boolean): Body[] => [make(en), dst("d1", "p1"), dfail("d1", "p1", 1), dst("d1", "p1", 2), dok("d1", "p1", 2), dst("d2", "p2"), dok("d2", "p2"),
    dst("d3", "p3"), dok("d3", "p3"), fin, started(1, "p2"), done(1, "p2", "amend", 1)];
  const order = (md: string, marks: string[]) => {
    let at = -1;
    for (const m of marks) { const i = md.indexOf(m, at + 1); expect(i, m).toBeGreaterThan(at); at = i; }
  };

  it("ru: order phase → failure → drafts → mark → turn 1", () => {
    const md = sessionMarkdown(fold(full(false)), "running", "ru", null, views);
    order(md, ["### Независимые черновики — участники пишут варианты, не видя чужих",
      "- Сбой: черновик d1 · Имя1 · попытка 1 — таймаут: slow. Повтор.",
      "### Черновик 1 · Имя1 · попыток: 2 · 12 знаков", "reason-d1", "**Текст черновика:**", "TEXT-FULL-1",
      "### Черновик 2 · Имя2 · 12 знаков", "TEXT-FULL-2", "### Черновик 3 · Имя3", "TEXT-FULL-3",
      "**Обсуждение начато · синтезатор 2 · Имя2**", "### Ход 1"]);
    expect(md).not.toContain("Ходов нет.");
  });
  it("en: order and labels without Russian", () => {
    const md = sessionMarkdown(fold(full(true)), "running", "en", null, views);
    order(md, ["### Independent drafts — participants write their versions without seeing the others'",
      "- Failure: draft d1 · Alpha · attempt 1 — timeout: slow. Retried.",
      "### Draft 1 · Alpha · attempts: 2 · 12 characters", "reason-d1", "**Draft text:**", "TEXT-FULL-1", "### Draft 2 · Beta", "TEXT-FULL-2", "### Draft 3 · Gamma", "TEXT-FULL-3",
      "**Discussion started · synthesizer 2 · Beta**", "### Turn 1"]);
    expect(md.replace(/текст v1|аргумент 1/g, "")).not.toMatch(/[А-Яа-я]/);
  });
  it("a slot participant that dropped out — a drop-out line", () => {
    const md = sessionMarkdown(fold([make(false), dst("d1", "p1"), dok("d1", "p1"), dst("d3", "p3"), dfail("d3", "p3", 1),
      { type: "participant_dropped", participantId: "p3", reason: "таймаут" } as Body]), "running", "ru", null, views);
    order(md, ["- Сбой: черновик d3 · Имя3 · попытка 1", "- Имя3 выбыл: таймаут"]);
    expect(md).not.toContain("Повтор.");
  });
  it("synthesizer_unavailable: the phase and the accepted draft are present, no \"No turns.\" and no start mark", () => {
    const md = sessionMarkdown(fold([make(false), dst("d1", "p1"), dok("d1", "p1"),
      { type: "session_finished", status: "failed", version: null, agreed: [], objectors: [], reason: "synthesizer_unavailable" } as Body]), "failed", "ru", null, views);
    expect(md).toContain("### Независимые черновики");
    expect(md).toContain("### Черновик 1 · Имя1");
    expect(md).not.toContain("Ходов нет.");
    expect(md).not.toContain("Обсуждение начато");
  });
  it("text: null and error — \"Text unavailable\", no exception; without a view too", () => {
    const bad = [{ ...views[0]!, text: null, error: "снимок d1 изменён" }];
    const bodies = [make(false), dst("d1", "p1"), dok("d1", "p1")];
    expect(sessionMarkdown(fold(bodies), "running", "ru", null, bad)).toContain("**Текст черновика:**\n\nТекст недоступен: снимок d1 изменён");
    expect(sessionMarkdown(fold(bodies), "running", "ru")).toContain("Текст недоступен: ");
    expect(sessionMarkdown(fold(bodies), "running", "en", null, bad)).toContain("**Draft text:**\n\nText unavailable: снимок d1 изменён");
  });
  it("stopped before drafts_finished with none accepted: the phase heading is present, no \"No turns.\" and no \"Discussion started\"", () => {
    const md = sessionMarkdown(fold([make(false), dst("d1", "p1")]), "interrupted", "ru");
    expect(md).toContain("### Независимые черновики");
    expect(md).not.toContain("Ходов нет.");
    expect(md).not.toContain("Обсуждение начато");
    expect(md).not.toContain("### Черновик");
  });
});
