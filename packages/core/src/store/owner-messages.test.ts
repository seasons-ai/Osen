import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OwnerMessageRequest } from "../engine.ts";
import { appendEvent, createSessionJournal, eventsPath, sessionDir } from "./journal.ts";
import {
  OwnerMessageRejectedError, OwnerReleaseRejectedError, discardOwnerRequests, openOwnerQueue, ownerMessagesDir, requestOwnerMessage,
  requestOwnerRelease,
} from "./owner-messages.ts";
import type { Session, SessionEvent } from "../protocol/schema.ts";

const ts = new Date(Date.UTC(2026, 0, 1)).toISOString();
const mkSession = (id: string): Session => ({
  id, createdAt: ts, origin: "cli", topic: "Тема", templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
});
const created = (s: Session, pid: number): SessionEvent => ({ seq: 1, ts, type: "session_created", session: s, pid });
const finished: SessionEvent = { seq: 2, ts, type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [] };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-om-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function start(id = "a", pid = 1) {
  createSessionJournal(dir, id);
  appendEvent(dir, id, created(mkSession(id), pid));
}
const alive = () => true;
const dead = () => false;
const send = (t: string, id = "a") => requestOwnerMessage(dir, id, t, { isAlive: alive });
const reject = (f: () => unknown): OwnerMessageRejectedError => {
  try { f(); } catch (e) { return e as OwnerMessageRejectedError; }
  throw new Error("не отклонено");
};
const log = (id: string) => readFileSync(eventsPath(dir, id));

function sender(id: string, tag: string, count: number) {
  const url = pathToFileURL(fileURLToPath(new URL("./owner-messages.ts", import.meta.url))).href;
  const code = `const m = await import(${JSON.stringify(url)});
for (let i = 0; i < ${count}; i++) m.requestOwnerMessage(${JSON.stringify(dir)}, ${JSON.stringify(id)}, ${JSON.stringify(tag)} + i);`;
  return new Promise<void>((res, rej) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit"] });
    c.once("exit", (k) => (k === 0 ? res() : rej(new Error(`sender exit ${k}`))));
  });
}

describe("owner-messages", () => {
  it("sender -> executor: order, texts, identifiers", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    const r1 = send("первая");
    const r2 = send("вторая");
    const got = q.take(false);
    expect(got.map((g) => (g as OwnerMessageRequest).text)).toEqual(["первая", "вторая"]);
    expect(got.map((g) => g.requestId)).toEqual([r1.requestId, r2.requestId]);
    expect(r1.requestId).not.toBe(r2.requestId);
    expect(readdirSync(ownerMessagesDir(dir, "a")).sort()).toEqual([`${r1.requestId}.json`, `${r2.requestId}.json`]);
  });

  it("text is saved verbatim", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    const t = "  --флаг\nстрока 2 😀 Привет  \n";
    send(t);
    expect((q.take(false)[0] as OwnerMessageRequest).text).toBe(t);
  });

  it("30 requests in a row and two child processes", async () => {
    start();
    const q = openOwnerQueue(dir, "a");
    const texts = Array.from({ length: 30 }, (_, i) => `m${i}`);
    for (const t of texts) send(t);
    expect(q.take(false).map((g) => (g as OwnerMessageRequest).text)).toEqual(texts);
    for (const g of q.take(false)) q.done(g.requestId);
    await Promise.all([sender("a", "x", 20), sender("a", "y", 20)]);
    const got = q.take(false).map((g) => (g as OwnerMessageRequest).text);
    expect(got).toHaveLength(40);
    expect(new Set(got).size).toBe(40);
    for (const tag of ["x", "y"]) {
      expect(got.filter((t) => t.startsWith(tag))).toEqual(Array.from({ length: 20 }, (_, i) => `${tag}${i}`));
    }
  });

  it("empty and whitespace text", () => {
    start();
    openOwnerQueue(dir, "a");
    for (const t of ["", "  \n\t"]) expect(reject(() => send(t)).reason).toBe("empty");
    expect(readdirSync(ownerMessagesDir(dir, "a"))).toEqual([]);
  });

  it("unfinished files are not visible and not deleted", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    const d = ownerMessagesDir(dir, "a");
    writeFileSync(join(d, ".tmp-xyz"), "{}");
    writeFileSync(join(d, "partial.json"), '{"text":');
    expect(q.take(false)).toEqual([]);
    expect(readdirSync(d).sort()).toEqual([".tmp-xyz", "partial.json"]);
  });

  it("refusals: unknown and invalid session", () => {
    expect(reject(() => send("x", "nope")).reason).toBe("not_found");
    expect(existsSync(sessionDir(dir, "nope"))).toBe(false);
    expect(reject(() => send("x", "../x")).reason).toBe("not_found");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refusals: finished and executor dead", () => {
    start("f");
    openOwnerQueue(dir, "f");
    appendEvent(dir, "f", finished);
    const before = log("f");
    const e = reject(() => send("x", "f"));
    expect(e.reason).toBe("finished");
    expect(e.message).toContain("consensus");
    expect(log("f").equals(before)).toBe(true);
    start("d");
    openOwnerQueue(dir, "d");
    const b2 = log("d");
    expect(reject(() => requestOwnerMessage(dir, "d", "x", { isAlive: dead })).reason).toBe("interrupted");
    expect(log("d").equals(b2)).toBe(true);
    expect(readdirSync(ownerMessagesDir(dir, "d"))).toEqual([]);
  });

  it("done: deletes file, safe for a foreign one", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    const r1 = send("1");
    send("2");
    q.done(r1.requestId);
    expect(q.take(false).map((g) => (g as OwnerMessageRequest).text)).toEqual(["2"]);
    q.done(r1.requestId);
    q.done("nope");
    q.done("../x");
    writeFileSync(join(dir, "keep.json"), "{}");
    q.done("../../keep");
    expect(existsSync(join(dir, "keep.json"))).toBe(true);
    expect(q.take(false)).toHaveLength(1);
  });

  it("closing: folder missing, repeat after reopen", async () => {
    start();
    const q = openOwnerQueue(dir, "a");
    expect(q.take(true)).toEqual([]);
    expect(existsSync(ownerMessagesDir(dir, "a"))).toBe(false);
    setTimeout(() => q.reopen(), 100);
    const p = sender("a", "z", 1);
    await p;
    expect(q.take(false).map((g) => (g as OwnerMessageRequest).text)).toEqual(["z0"]);
  });

  it("closing without reopen: closing", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    q.take(true);
    expect(reject(() => send("x")).reason).toBe("closing");
  });

  it("closed and finished: finished", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    q.take(true);
    appendEvent(dir, "a", finished);
    expect(reject(() => send("x")).reason).toBe("finished");
  });

  it("requests before take(true) are returned from the closed folder", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    const r = send("до");
    const got = q.take(true);
    expect(got.map((g) => (g as OwnerMessageRequest).text)).toEqual(["до"]);
    expect(existsSync(ownerMessagesDir(dir, "a"))).toBe(false);
    q.done(r.requestId);
    expect(q.take(true)).toEqual([]);
    q.reopen();
    expect(readdirSync(sessionDir(dir, "a")).filter((n) => n.startsWith("owner-messages"))).toEqual(["owner-messages"]);
  });

  it("old-version executor without folder: closing", () => {
    start();
    expect(reject(() => send("x")).reason).toBe("closing");
  });

  it("take without folder returns []", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    rmSync(ownerMessagesDir(dir, "a"), { recursive: true });
    expect(q.take(false)).toEqual([]);
  });
  const folders = () => readdirSync(sessionDir(dir, "a")).filter((n) => n.startsWith("owner-messages"));

  it("empty closed folder is deleted at once", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    expect(q.take(true)).toEqual([]);
    expect(folders()).toEqual([]);
  });

  it("closed folder disappears after the last done", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    const r1 = send("1");
    const r2 = send("2");
    q.take(true);
    expect(folders()).toEqual(["owner-messages.closed-1"]);
    q.done(r1.requestId);
    expect(folders()).toEqual(["owner-messages.closed-1"]);
    q.done(r2.requestId);
    expect(folders()).toEqual([]);
  });

  it("closed folder with a foreign file stays", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    const r = send("1");
    writeFileSync(join(ownerMessagesDir(dir, "a"), ".tmp-x"), "");
    q.take(true);
    q.done(r.requestId);
    expect(readdirSync(join(sessionDir(dir, "a"), "owner-messages.closed-1"))).toEqual([".tmp-x"]);
  });
});

describe("owner-messages: answer to an owner question", () => {
  const qEvent = (seq: number, id: string, to: string): SessionEvent => ({
    seq, ts, type: "turn_completed", turn: seq, round: 1, participantId: "p1", stance: "amend", normalized: false,
    reasoning: "r", solution: "s", version: 1, questions: [{ id, to, text: "?" }], answers: [], attempts: 1, usage: {}, durationMs: 1,
  });
  const closedEv = (seq: number, questionId: string, reason: "answered" | "unanswered"): SessionEvent => ({
    seq, ts, type: "question_closed", questionId, reason,
  });
  const files = (id = "a") => readdirSync(ownerMessagesDir(dir, id));
  const ask = (t: string, questionId: string, id = "a") => requestOwnerMessage(dir, id, t, { questionId, isAlive: alive });

  it("accepted: file contains questionId, take(false) returns it", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    appendEvent(dir, "a", { ...qEvent(2, "q1", "owner") });
    const r = ask("Ответ", "q1");
    const file = JSON.parse(readFileSync(join(ownerMessagesDir(dir, "a"), `${r.requestId}.json`), "utf8"));
    expect(file.questionId).toBe("q1");
    expect(q.take(false)).toEqual([{ requestId: r.requestId, text: "Ответ", questionId: "q1" }]);
  });

  it("without questionId: file without the field", () => {
    start();
    const q = openOwnerQueue(dir, "a");
    const r = send("обычная");
    const file = JSON.parse(readFileSync(join(ownerMessagesDir(dir, "a"), `${r.requestId}.json`), "utf8"));
    expect("questionId" in file).toBe(false);
    expect(q.take(false)).toEqual([{ requestId: r.requestId, text: "обычная" }]);
  });

  it("question refusals: texts, no file and no journal change", () => {
    start();
    openOwnerQueue(dir, "a");
    appendEvent(dir, "a", qEvent(2, "q1", "owner"));
    appendEvent(dir, "a", qEvent(3, "q2", "p2"));
    appendEvent(dir, "a", qEvent(4, "q3", "owner"));
    appendEvent(dir, "a", closedEv(5, "q3", "answered"));
    appendEvent(dir, "a", qEvent(6, "q4", "owner"));
    appendEvent(dir, "a", closedEv(7, "q4", "unanswered"));
    const before = log("a");
    const cases: [string, string, string][] = [
      ["q99", "question_not_found", "Вопрос q99 не найден."],
      ["q2", "question_not_owner", "Вопрос q2 не адресован владельцу."],
      ["q3", "question_closed", "Вопрос q3 уже закрыт: отвечен."],
      ["q4", "question_closed", "Вопрос q4 уже закрыт: остался без ответа."],
    ];
    for (const [qid, reason, message] of cases) {
      const e = reject(() => ask("x", qid));
      expect(e.reason).toBe(reason);
      expect(e.message).toBe(message);
    }
    expect(files()).toEqual([]);
    expect(log("a").equals(before)).toBe(true);
  });

  it("finished session: finished before the question check", () => {
    start("f");
    openOwnerQueue(dir, "f");
    appendEvent(dir, "f", finished);
    expect(reject(() => ask("x", "q99", "f")).reason).toBe("finished");
  });
});

describe("owner-messages: releasing owner wait", () => {
  const waitStarted = (seq: number, waitId: string): SessionEvent => ({
    seq, ts, type: "owner_wait_started", waitId, reasons: ["round_boundary"], questionIds: [], afterTurn: 1, deadline: ts,
  });
  const waitFinished = (seq: number, waitId: string): SessionEvent => ({
    seq, ts, type: "owner_wait_finished", waitId, reason: "continued",
  });
  const waiting = (id = "a", waitId = "w1") => { start(id); appendEvent(dir, id, waitStarted(2, waitId)); };
  const release = (id = "a", waitId?: string) => requestOwnerRelease(dir, id, { isAlive: alive, ...(waitId !== undefined ? { waitId } : {}) });
  const rej = (f: () => unknown): OwnerReleaseRejectedError => {
    try { f(); } catch (e) { return e as OwnerReleaseRejectedError; }
    throw new Error("не отклонено");
  };
  const releaseSender = (id: string) => {
    const url = pathToFileURL(fileURLToPath(new URL("./owner-messages.ts", import.meta.url))).href;
    const code = `const m = await import(${JSON.stringify(url)});
m.requestOwnerRelease(${JSON.stringify(dir)}, ${JSON.stringify(id)}, { isAlive: () => true });`;
    return new Promise<void>((res, rej2) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "inherit"] });
      c.once("exit", (k) => (k === 0 ? res() : rej2(new Error(`sender exit ${k}`))));
    });
  };

  it("1. live wait: file, take(false), journal untouched", () => {
    waiting();
    const q = openOwnerQueue(dir, "a");
    const before = log("a");
    const r = release();
    expect(r.waitId).toBe("w1");
    const names = readdirSync(ownerMessagesDir(dir, "a"));
    expect(names).toEqual([`${r.requestId}.json`]);
    expect(JSON.parse(readFileSync(join(ownerMessagesDir(dir, "a"), names[0]!), "utf8")).releaseWaitId).toBe("w1");
    expect(q.take(false)).toEqual([{ requestId: r.requestId, releaseWaitId: "w1" }]);
    expect(log("a").equals(before)).toBe(true);
  });

  it("2. common order of message, release and answer; done deletes", () => {
    waiting();
    const q = openOwnerQueue(dir, "a");
    const r1 = send("реплика");
    const r2 = release();
    const r3 = send("ответ");
    const got = q.take(false);
    expect(got.map((g) => g.requestId)).toEqual([r1.requestId, r2.requestId, r3.requestId]);
    expect("text" in got[1]!).toBe(false);
    for (const g of got) {
      q.done(g.requestId);
      expect(existsSync(join(ownerMessagesDir(dir, "a"), `${g.requestId}.json`))).toBe(false);
    }
    expect(readdirSync(ownerMessagesDir(dir, "a"))).toEqual([]);
  });

  it("3. separate process: release visible to the queue, journal untouched", async () => {
    waiting();
    const q = openOwnerQueue(dir, "a");
    const before = log("a");
    await releaseSender("a");
    expect(q.take(false)).toMatchObject([{ releaseWaitId: "w1" }]);
    expect(log("a").equals(before)).toBe(true);
    const names = readdirSync(sessionDir(dir, "a")).filter((n) => n.startsWith("owner-messages"));
    expect(names).toEqual(["owner-messages"]);
  });

  it("4a. whole journal accepted, incomplete tail gives corrupted (no seam for growth between read and check)", () => {
    waiting("g");
    openOwnerQueue(dir, "g");
    expect(release("g").waitId).toBe("w1");
    appendFileSync(eventsPath(dir, "g"), '{"seq":3,"ts"');
    expect(rej(() => release("g")).reason).toBe("corrupted");
  });

  it("4b. newer_version: release and message rejected, no request files, journal the same; corrupted for message as before", () => {
    waiting("n");
    appendFileSync(eventsPath(dir, "n"), JSON.stringify({ seq: 3, ts, type: "future_event" }) + "\n");
    const before = log("n");
    const r = rej(() => release("n"));
    expect(r.reason).toBe("newer_version");
    expect(r.message).toBe("Сессия n: журнал записан более новой версией, прочитан до события №2; снять ожидание невозможно. Обновите приложение.");
    const m = reject(() => send("привет", "n"));
    expect(m.reason).toBe("newer_version");
    expect(m.message).toBe("Сессия n: журнал записан более новой версией, прочитан до события №2; реплика невозможна. Обновите приложение.");
    expect(existsSync(ownerMessagesDir(dir, "n"))).toBe(false);
    expect(readdirSync(sessionDir(dir, "n"))).toEqual(["events.jsonl"]);
    expect(log("n").equals(before)).toBe(true);

    waiting("k");
    appendFileSync(eventsPath(dir, "k"), '{"seq":3,"ts"');
    openOwnerQueue(dir, "k");
    expect(send("привет", "k").requestId).toBeTruthy();
  });

  it("4. refusals without folder and file", () => {
    const noDir = (id: string) => expect(existsSync(ownerMessagesDir(dir, id))).toBe(false);
    expect(rej(() => release("nope")).reason).toBe("not_found");
    expect(rej(() => release("../x")).reason).toBe("not_found");
    expect(readdirSync(dir)).toEqual([]);

    waiting("c");
    appendFileSync(eventsPath(dir, "c"), '{"seq":3,"ts"');
    const e = rej(() => release("c"));
    expect(e.reason).toBe("corrupted");
    expect(e.message).toContain("после события №2");
    noDir("c");

    waiting("f");
    appendEvent(dir, "f", { ...finished, seq: 3 });
    expect(rej(() => release("f")).reason).toBe("finished");
    noDir("f");

    waiting("d");
    const e2 = rej(() => requestOwnerRelease(dir, "d", { isAlive: dead }));
    expect(e2.reason).toBe("interrupted");
    expect(e2.message).toContain("council resume d");
    noDir("d");

    start("n");
    expect(rej(() => release("n")).reason).toBe("not_waiting");
    noDir("n");

    waiting("s");
    appendEvent(dir, "s", waitFinished(3, "w1"));
    expect(rej(() => release("s")).reason).toBe("not_waiting");
    noDir("s");

    waiting("t", "w2");
    const e3 = rej(() => release("t", "w1"));
    expect(e3.reason).toBe("stale_wait");
    expect(e3.message).toBe("Сессия t: ожидание w1 уже снято, текущее — w2.");
    noDir("t");

    openOwnerQueue(dir, "t");
    expect(release("t", "w2").waitId).toBe("w2");
    expect(readdirSync(ownerMessagesDir(dir, "t"))).toHaveLength(1);
  });

  it("5. closing intake: closing or pass after reopen", async () => {
    waiting();
    const q = openOwnerQueue(dir, "a");
    q.take(true);
    expect(rej(() => release()).reason).toBe("closing");
    expect(existsSync(ownerMessagesDir(dir, "a"))).toBe(false);
    setTimeout(() => q.reopen(), 100);
    await releaseSender("a");
    expect(q.take(false)).toMatchObject([{ releaseWaitId: "w1" }]);
  });

  it("6. take(true) returns release from closed folder; folder removed after done", () => {
    waiting();
    const q = openOwnerQueue(dir, "a");
    const r = release();
    expect(q.take(true)).toEqual([{ requestId: r.requestId, releaseWaitId: "w1" }]);
    expect(folders()).toEqual(["owner-messages.closed-1"]);
    q.done(r.requestId);
    expect(folders()).toEqual([]);
  });

  it("7. discardOwnerRequests: deletes both kinds, returns only messages", () => {
    waiting();
    openOwnerQueue(dir, "a");
    const m = send("не применена");
    const r = release();
    expect(discardOwnerRequests(dir, "a", new Set())).toEqual([{ requestId: m.requestId, text: "не применена" }]);
    expect(readdirSync(ownerMessagesDir(dir, "a"))).toEqual([]);
    release();
    expect(discardOwnerRequests(dir, "a", new Set())).toEqual([]);
    expect(readdirSync(ownerMessagesDir(dir, "a"))).toEqual([]);
    expect(r.requestId).toBeTruthy();
  });

  it("8. file without text and without releaseWaitId is skipped and not deleted", () => {
    waiting();
    const q = openOwnerQueue(dir, "a");
    const d = ownerMessagesDir(dir, "a");
    writeFileSync(join(d, "x.json"), '{"createdAt":"1"}');
    writeFileSync(join(d, "y.json"), '{"releaseWaitId":""}');
    expect(q.take(false)).toEqual([]);
    expect(readdirSync(d).sort()).toEqual(["x.json", "y.json"]);
  });
  const folders = () => readdirSync(sessionDir(dir, "a")).filter((n) => n.startsWith("owner-messages"));
});
