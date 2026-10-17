import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../engine.ts";
import { createScriptedDriver } from "../participants/scripted.ts";
import type { Scenario } from "../participants/scripted.ts";
import { getProcessLanguage, setProcessLanguage } from "../i18n/index.ts";
import type { Language } from "../i18n/index.ts";
import type { Limits, Session, SessionEvent } from "../protocol/schema.ts";
import { appendEvent, createSessionJournal, eventsPath, resumeLockPath, sessionsDir } from "./journal.ts";
import { DataDirError, ensureDataDir } from "./data-dir.ts";
import { OwnerMessageRejectedError, OwnerReleaseRejectedError, openOwnerQueue, requestOwnerMessage, requestOwnerRelease } from "./owner-messages.ts";
import { OWNER_NOTE_MAX, OwnerSelectionRejectedError, selectOwnerVersion } from "./owner-selection.ts";
import { loadPreparedMaterials, PreparedMaterialsError } from "./prepared-materials.ts";
import { runStoredSession } from "./run.ts";
import { StopRejectedError, partialNote, requestStop } from "./sessions.ts";
import { tariffsPath } from "./tariffs.ts";
import { readUsageSummary, type UsageSkip } from "./usage.ts";

const initial: Language = getProcessLanguage();
afterEach(() => setProcessLanguage(initial));

type Rejected = Error & { reason?: string; problem?: string };
const alive = () => true;
const dead = () => false;

// The same input in ru and en: the refusal code and text in each language.
function both(fn: () => unknown, code: "reason" | "problem" = "reason") {
  const run = (lang: Language) => {
    setProcessLanguage(lang);
    try { fn(); } catch (e) { return { code: (e as Rejected)[code], message: (e as Error).message }; }
    throw new Error("не отклонено");
  };
  return { ru: run("ru"), en: run("en") };
}
// Requirements "Core messages in the selected language" and "Refusal codes and identifiers do not depend on language".
function expectBoth(fn: () => unknown, code: string, values: string[], ruText: string, field: "reason" | "problem" = "reason") {
  const { ru, en } = both(fn, field);
  expect(ru.code).toBe(code);
  expect(en.code).toBe(code);
  expect(ru.message).toBe(ruText);
  expect(en.message).not.toBe(ru.message);
  expect(en.message).not.toMatch(/[Ѐ-ӿ]/);
  for (const v of values) {
    expect(ru.message).toContain(v);
    expect(en.message).toContain(v);
  }
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-storelang-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ts = new Date(Date.UTC(2026, 0, 1)).toISOString();
const mkSession = (id: string): Session => ({
  id, createdAt: ts, origin: "cli", topic: "Тема", templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
});
function start(id: string, pid = 1) {
  createSessionJournal(dir, id);
  appendEvent(dir, id, { seq: 1, ts, type: "session_created", session: mkSession(id), pid });
}
const finish = (seq: number): SessionEvent => ({ seq, ts, type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [] });
const qEvent = (seq: number, id: string, to: string): SessionEvent => ({
  seq, ts, type: "turn_completed", turn: seq, round: 1, participantId: "p1", stance: "amend", normalized: false,
  reasoning: "r", solution: "s", version: 1, questions: [{ id, to, text: "?" }], answers: [], attempts: 1, usage: {}, durationMs: 1,
});
const qClosed = (seq: number, questionId: string, reason: "answered" | "unanswered"): SessionEvent => ({ seq, ts, type: "question_closed", questionId, reason });
const waitStarted = (seq: number, waitId: string): SessionEvent => ({
  seq, ts, type: "owner_wait_started", waitId, reasons: ["round_boundary"], questionIds: [], afterTurn: 1, deadline: ts,
});

describe("Core messages in the selected language: DataDirError", () => {
  it("path and reason substituted in both languages, class name unchanged", () => {
    writeFileSync(join(dir, "file.txt"), "x");
    const target = join(dir, "file.txt", "data");
    const msgs = (["ru", "en"] as const).map((l) => {
      setProcessLanguage(l);
      try { ensureDataDir(target); } catch (e) { expect(e).toBeInstanceOf(DataDirError); return (e as Error).message; }
      throw new Error("не отклонено");
    });
    expect(msgs[0]).toMatch(/^Папка данных недоступна: /);
    expect(msgs[1]).toMatch(/^Data folder is unavailable: /);
    for (const m of msgs) expect(m).toContain(target);
    const reason = msgs[0]!.split(" — ")[1]!;
    expect(msgs[1]).toContain(reason);
  });
});

describe("Core messages in the selected language: owner message refusals", () => {
  const send = (id: string, text = "x", questionId?: string) =>
    () => requestOwnerMessage(dir, id, text, { isAlive: alive, ...(questionId ? { questionId } : {}) });

  it("empty, not_found, finished, interrupted, closing", () => {
    expectBoth(send("a", "  "), "empty", [], "Реплика должна быть непустой.");
    expectBoth(send("nope"), "not_found", ["nope"], "Сессия nope не найдена.");
    start("f");
    openOwnerQueue(dir, "f");
    appendEvent(dir, "f", finish(2));
    expectBoth(send("f"), "finished", ["f", "consensus"], "Сессия f уже завершена: consensus.");
    start("d");
    openOwnerQueue(dir, "d");
    expectBoth(() => requestOwnerMessage(dir, "d", "x", { isAlive: dead }), "interrupted", ["d"], "Сессия d прервана: её исполнитель не работает.");
    start("c");
    expect(() => send("c")()).toThrow(OwnerMessageRejectedError);
    expectBoth(send("c"), "closing", ["c"], "Сессия c сейчас не принимает реплики: исполнитель завершает обсуждение или запущен версией без реплик.");
  });

  it("questions: question_not_found, question_not_owner, question_closed (answered and unanswered)", () => {
    start("q");
    openOwnerQueue(dir, "q");
    appendEvent(dir, "q", qEvent(2, "q1", "owner"));
    appendEvent(dir, "q", qEvent(3, "q2", "p2"));
    appendEvent(dir, "q", qEvent(4, "q3", "owner"));
    appendEvent(dir, "q", qClosed(5, "q3", "answered"));
    appendEvent(dir, "q", qEvent(6, "q4", "owner"));
    appendEvent(dir, "q", qClosed(7, "q4", "unanswered"));
    expectBoth(send("q", "x", "q99"), "question_not_found", ["q99"], "Вопрос q99 не найден.");
    expectBoth(send("q", "x", "q2"), "question_not_owner", ["q2"], "Вопрос q2 не адресован владельцу.");
    expectBoth(send("q", "x", "q3"), "question_closed", ["q3"], "Вопрос q3 уже закрыт: отвечен.");
    expectBoth(send("q", "x", "q4"), "question_closed", ["q4"], "Вопрос q4 уже закрыт: остался без ответа.");
    const en = both(send("q", "x", "q3")).en.message;
    expect(en).toContain("answered");
    expect(both(send("q", "x", "q4")).en.message).toContain("unanswered");
  });
});

describe("Core messages in the selected language: releasing wait refusals", () => {
  const rel = (id: string, waitId?: string) => () => requestOwnerRelease(dir, id, { isAlive: alive, ...(waitId ? { waitId } : {}) });
  it("not_found, corrupted, finished, interrupted, not_waiting, stale_wait, closing", () => {
    expectBoth(rel("nope"), "not_found", ["nope"], "Сессия nope не найдена.");

    start("c");
    appendEvent(dir, "c", waitStarted(2, "w1"));
    appendFileSync(eventsPath(dir, "c"), '{"seq":3,"ts"');
    expectBoth(rel("c"), "corrupted", ["c", "2"], "Сессия c: журнал сессии повреждён: после события №2 идёт неполная или невалидная запись; снять ожидание невозможно.");

    start("f");
    appendEvent(dir, "f", waitStarted(2, "w1"));
    appendEvent(dir, "f", finish(3));
    expectBoth(rel("f"), "finished", ["f", "consensus"], "Сессия f уже завершена: consensus.");

    start("d");
    appendEvent(dir, "d", waitStarted(2, "w1"));
    expectBoth(() => requestOwnerRelease(dir, "d", { isAlive: dead }), "interrupted", ["d", "council resume d"],
      "Сессия d прервана: её исполнитель не работает. Ожидание продолжится после council resume d.");

    start("n");
    expectBoth(rel("n"), "not_waiting", ["n"], "Сессия n не ждёт владельца: снимать нечего.");

    start("t");
    appendEvent(dir, "t", waitStarted(2, "w2"));
    expectBoth(rel("t", "w1"), "stale_wait", ["t", "w1", "w2"], "Сессия t: ожидание w1 уже снято, текущее — w2.");

    start("k");
    appendEvent(dir, "k", waitStarted(2, "w1"));
    openOwnerQueue(dir, "k").take(true);
    expectBoth(rel("k"), "closing", ["k"], "Сессия k сейчас не принимает запросы: исполнитель завершает обсуждение или запущен версией без ожидания.");
    expect(() => rel("k")()).toThrow(OwnerReleaseRejectedError);
  });
});

describe("Core messages in the selected language: stop refusal", () => {
  it("not_found, finished, interrupted", () => {
    const stop = (id: string, f = alive) => () => requestStop(dir, id, f);
    expectBoth(stop("nope"), "not_found", ["nope"], "Сессия nope не найдена.");
    start("f");
    appendEvent(dir, "f", finish(2));
    expectBoth(stop("f"), "finished", ["f", "consensus"], "Сессия f уже завершена: consensus.");
    start("d", 999999);
    expectBoth(stop("d", dead), "interrupted", ["d"], "Сессия d прервана: её исполнитель не работает.");
    expect(() => stop("d", dead)()).toThrow(StopRejectedError);
  });
});

describe("Core messages in the selected language: owner version selection refusal", () => {
  type Step = Scenario["steps"][number];
  const resp = (stance: string, solution: string | null): Step => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });
  const scripted = (...steps: Step[]) => createScriptedDriver({ steps }, { COUNCIL_DEV: "1" });
  const mk = (id: string) => createSession(
    {
      topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 20000 } as Limits,
      participants: [0, 1].map((i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id },
  );
  const run = (id: string, a: Step, b: Step) =>
    runStoredSession({ session: mk(id), drivers: { p1: scripted(a), p2: scripted(b) }, dataDir: dir });
  const sel = (id: string, version: number, note?: string, isAlive = dead) => () => selectOwnerVersion(dir, id, { version, note }, { isAlive });

  it("bad_note, not_found, running, interrupted, unknown_version, corrupted, busy", async () => {
    expectBoth(sel("s", 1, "x".repeat(OWNER_NOTE_MAX + 1)), "bad_note", [String(OWNER_NOTE_MAX)], `Заметка длиннее ${OWNER_NOTE_MAX} знаков.`);
    expectBoth(sel("nope", 1), "not_found", ["nope"], "Сессия nope не найдена.");

    start("r");
    expectBoth(sel("r", 1, undefined, alive), "running", ["r"], "Сессия r ещё идёт: выбрать версию можно после завершения.");
    expectBoth(sel("r", 1, undefined, dead), "interrupted", ["r"], "Сессия r прервана без итога: сначала продолжите или остановите её.");

    const fatal: Step = { error: "fatal", retryable: false };
    await run("f", fatal, fatal);
    expectBoth(sel("f", 1), "unknown_version", ["f"], "В сессии f нет ни одной версии решения: выбирать нечего.");

    await run("s", resp("amend", "v1"), resp("object", null));
    expectBoth(sel("s", 9), "unknown_version", ["s", "9"], "В сессии s нет версии 9.");

    writeFileSync(resumeLockPath(dir, "s"), "4242");
    expectBoth(sel("s", 1, undefined, alive), "busy", ["s"], "Сессию s сейчас продолжает другой процесс: выбор не записан.");
    rmSync(resumeLockPath(dir, "s"));

    appendFileSync(eventsPath(dir, "s"), '{"seq":');
    expectBoth(sel("s", 1), "corrupted", ["s", "6"], "Сессия s: журнал сессии повреждён: после события №6 идёт неполная или невалидная запись; выбор версии невозможен.");
    expect(sel("s", 1)).toThrow(OwnerSelectionRejectedError);
  });
});

describe("Core messages in the selected language: PreparedMaterialsError", () => {
  it("invalid, unknown", () => {
    expectBoth(() => loadPreparedMaterials(dir, "../x"), "invalid", [], "Недопустимый идентификатор подготовленного набора", "problem");
    expectBoth(() => loadPreparedMaterials(dir, "0".repeat(32)), "unknown", [], "Подготовленный набор не найден", "problem");
    expect(() => loadPreparedMaterials(dir, "../x")).toThrow(PreparedMaterialsError);
  });
});

describe("Core messages in the selected language: usage summary skip and tariffs", () => {
  const ids = (n: number) => `20260310-10000${n}-aaaa`;
  it("usage skip reasons: numbers in both languages", () => {
    const sid = ids(2);
    createSessionJournal(dir, sid);
    appendEvent(dir, sid, { seq: 1, ts, type: "session_created", session: mkSession(sid), pid: 1 });
    appendFileSync(eventsPath(dir, sid), "{мусор\n");
    createSessionJournal(dir, ids(3));
    writeFileSync(eventsPath(dir, ids(3)), "не json\n");
    const reasons = (l: Language) => {
      setProcessLanguage(l);
      const skips: UsageSkip[] = [];
      readUsageSummary(dir, "2026-01-01", "2026-12-31", (k) => skips.push(k));
      return Object.fromEntries(skips.map((k) => [k.kind, k.reason]));
    };
    const ru = reasons("ru");
    const en = reasons("en");
    const m = /^прочитано (\d+) из (\d+) байт$/.exec(ru.truncated!)!;
    expect(en.truncated).toBe(`read ${m[1]} of ${m[2]} bytes`);
    expect(ru.unreadable).toBe("нет читаемого события session_created");
    expect(en.unreadable).toBe("no readable session_created event");
  });

  it("tariffs.json unreadable: warning with same code in both languages", () => {
    mkdirSync(tariffsPath(dir));
    const warn = (l: Language) => { setProcessLanguage(l); return readUsageSummary(dir, "2026-01-01", "2026-12-31").tariffs.warnings[0]!; };
    const ru = warn("ru");
    const en = warn("en");
    const code = /\((\w+)\)$/.exec(ru)![1]!;
    expect(ru).toBe(`tariffs.json: не удалось прочитать (${code})`);
    expect(en).toBe(`tariffs.json: could not read (${code})`);
  });
});

describe("Core messages in the selected language: newer-version journal", () => {
  const future = (id: string, seq: number) => appendFileSync(eventsPath(dir, id), JSON.stringify({ seq, ts, type: "future_event" }) + "\n");
  const ruNote = "журнал записан более новой версией, прочитан до события №2";

  it("newer_version for message, wait release and version selection", () => {
    start("n");
    appendEvent(dir, "n", waitStarted(2, "w1"));
    future("n", 3);
    expectBoth(() => requestOwnerMessage(dir, "n", "x", { isAlive: alive }), "newer_version", ["n", "2"], `Сессия n: ${ruNote}; реплика невозможна. Обновите приложение.`);
    expectBoth(() => requestOwnerRelease(dir, "n", { isAlive: alive }), "newer_version", ["n", "2"], `Сессия n: ${ruNote}; снять ожидание невозможно. Обновите приложение.`);
    expectBoth(() => selectOwnerVersion(dir, "n", { version: 1 }, { isAlive: dead }), "newer_version", ["n", "2"], `Сессия n: ${ruNote}; выбор версии невозможен. Обновите приложение.`);
  });

  it("interrupted for stop: variant for newer-version journal", () => {
    start("n");
    appendEvent(dir, "n", waitStarted(2, "w1"));
    future("n", 3);
    expectBoth(() => requestStop(dir, "n", dead), "interrupted", ["n", "2"], `Сессия n: исполнитель не работает, останавливать нечего; ${ruNote}.`);
  });

  it("partialNote: both reasons", () => {
    setProcessLanguage("ru");
    expect(partialNote({ reason: "newer_version", lastEvent: 3 })).toBe("журнал записан более новой версией, прочитан до события №3");
    expect(partialNote({ reason: "corrupted", lastEvent: 7 })).toBe("журнал повреждён, прочитан до события №7");
    setProcessLanguage("en");
    expect(partialNote({ reason: "newer_version", lastEvent: 3 })).toBe("the journal was written by a newer version, read up to event No. 3");
    expect(partialNote({ reason: "corrupted", lastEvent: 7 })).toBe("the journal is corrupted, read up to event No. 7");
  });
});
