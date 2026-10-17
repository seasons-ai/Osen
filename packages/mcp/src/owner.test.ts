import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage, appendEvent, createLogger, eventsPath, createScriptedDriver, createSession, createSessionJournal, ownerMessagesDir, readEvents, readScenario, readSession, runStoredSession } from "@model-council/core";
import type { OwnerWaitSettings, Scenario, SessionEvent } from "@model-council/core";
import { ToolError } from "./context.ts";
import type { ToolContext } from "./context.ts";
import { councilContinue, councilSay } from "./owner.ts";

const root = join(import.meta.dirname, "../../..");
const scenarios = join(root, "packages/core/scenarios");
const env = { COUNCIL_DEV: "1" };
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), "council-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const ctxOf = (dataDir: string, logger: ToolContext["logger"] = { info: () => {}, error: () => {} }): ToolContext => ({
  dataDir, env, pollMs: 20, shutdown: new AbortController().signal, logger, builtinTemplatesDir: "", scenariosDir: null,
});

const aborts: AbortController[] = [];
const runs: Promise<unknown>[] = [];
const kids: ChildProcess[] = [];
afterEach(async () => {
  for (const k of kids.splice(0)) k.kill("SIGKILL");
  for (const a of aborts.splice(0)) a.abort();
  await Promise.allSettled(runs.splice(0));
});

const step = (stance: string, solution: string | null, questions: unknown[] = []) =>
  ({ response: { stance, reasoning: `${stance}: ${solution ?? "ок"}`, solution, answers: [], questions } }) as Scenario["steps"][number];
const plain = (): Scenario[] => [
  { steps: [step("amend", "Версия один."), step("amend", "Версия два.")] },
  { steps: [step("amend", "Версия три."), step("agree", null)] },
];

// starts a session in this process — this is the executor, separate from the tool; the shared request queue lives in the data folder
function start(dataDir: string, id: string, files: Scenario[], ownerWait?: OwnerWaitSettings, maxRounds = 3) {
  const drivers = Object.fromEntries(files.map((s, i) => [`p${i + 1}`, createScriptedDriver(s, env)]));
  const session = createSession(
    {
      topic: "Как назвать кота", framing: "", origin: "mcp", ownerWait,
      limits: { maxRounds, turnTimeoutSec: 30, contextChars: 20000 },
      participants: files.map((_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id },
  );
  const ctl = new AbortController();
  aborts.push(ctl);
  const p = runStoredSession({ session, drivers, dataDir, signal: ctl.signal, waitPollMs: 20 });
  runs.push(p);
  return p;
}

type Ev = Record<string, any> & { type: string; seq: number };
const evs = (dir: string, id: string) => readEvents(dir, id)!.events as unknown as Ev[];
const of = (dir: string, id: string, type: string) => evs(dir, id).filter((e) => e.type === type);
const queued = (dir: string, id: string) => { try { return readdirSync(ownerMessagesDir(dir, id)).length; } catch { return 0; } };
const until = async <T>(f: () => T | false | undefined | null, ms = 10000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    let r: T | false | undefined | null;
    try { r = f(); } catch { r = undefined; }
    if (r) return r;
  }
  throw new Error("не дождались");
};
const waiting = (dir: string, id: string) => until(() => of(dir, id, "owner_wait_started").at(-1));
const rejected = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } throw new Error("не отклонено"); };
const say = (dir: string, sessionId: string, text: string, questionId?: string) => councilSay.run(ctxOf(dir), { sessionId, text, questionId }) as Promise<any>;
const cont = (dir: string, sessionId: string, waitId: string) => councilContinue.run(ctxOf(dir), { sessionId, waitId }) as Promise<any>;

// session without an executor: a journal with the pid of a finished process
function dead(dir: string, id: string) {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid!;
  createSessionJournal(dir, id);
  const session = createSession(
    { topic: "т", framing: "", origin: "mcp", limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000 }, participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })) },
    { maxParticipants: 8, id },
  );
  appendEvent(dir, id, { seq: 1, ts: new Date().toISOString(), type: "session_created", session, pid } as SessionEvent);
}

/** A refusal changes neither the journal nor the queue. */
async function refused(dir: string, id: string, f: () => Promise<unknown>, re: RegExp) {
  const n = evs(dir, id).length, q = queued(dir, id);
  const e = await rejected(f());
  expect(e).toBeInstanceOf(ToolError);
  expect((e as Error).message).toMatch(re);
  expect(evs(dir, id).length).toBe(n);
  expect(queued(dir, id)).toBe(q);
}

describe("council_say", () => {
  it("a regular message is applied by the executor with this requestId", async () => {
    const dir = tmp();
    void start(dir, "s1", plain(), { pauseAfterRound: true, timeoutSec: 30 });
    await waiting(dir, "s1");
    const r = await say(dir, "s1", "Уложимся в неделю");
    expect(r).toMatchObject({ sessionId: "s1", questionId: null, queued: true });
    expect(r.requestId).toBeTruthy();
    const m = await until(() => of(dir, "s1", "owner_message")[0]);
    expect(m).toMatchObject({ requestId: r.requestId, text: "Уложимся в неделю" });
    expect(of(dir, "s1", "owner_wait_finished")).toEqual([]);
  });

  it("an answer to an owner question closes the question as answered", async () => {
    const dir = tmp();
    void start(dir, "s1", [{ steps: [step("amend", "Версия.", [{ to: "owner", text: "Таблица или текст?" }]), step("agree", null)] }, { steps: [step("agree", null)] }], { waitForOwner: true, timeoutSec: 30 });
    await waiting(dir, "s1");
    const r = await say(dir, "s1", "Таблицей", "q1");
    expect(r.questionId).toBe("q1");
    const m = await until(() => of(dir, "s1", "owner_message")[0]);
    expect(m.requestId).toBe(r.requestId);
    expect(m.answers).toEqual([{ questionId: "q1", text: "Таблицей" }]);
    await until(() => readSession(dir, "s1")!.state.questions.find((q) => q.id === "q1")?.status === "answered");
  });

  it("refusals write neither to the journal nor to the queue", async () => {
    const dir = tmp();
    // p2 asks participant p1 a question at the end of round 1: it stays open during the pause
    void start(dir, "s1", [
      { steps: [step("amend", "Версия."), step("amend", "Версия 2.")] },
      { steps: [step("amend", "Версия 3.", [{ to: "p1", text: "Почему?" }]), step("agree", null)] },
    ], { pauseAfterRound: true, waitForOwner: true, timeoutSec: 30 });
    // for the closed owner question — a separate session with two questions: we answer one while the pause holds the session
    void start(dir, "s2", [{ steps: [step("amend", "Версия.", [{ to: "owner", text: "Первый?" }]), step("agree", null)] }, { steps: [step("agree", null)] }], { pauseAfterRound: true, waitForOwner: true, timeoutSec: 30 });
    await waiting(dir, "s1");
    await waiting(dir, "s2");

    await refused(dir, "s1", () => say(dir, "s1", ""), /непуст/);
    await refused(dir, "s1", () => say(dir, "s1", "   \n "), /непуст/);
    await expect(say(dir, "20200101-000000-nope", "т")).rejects.toThrow(/не найдена/);
    setProcessLanguage("en");
    try {
      const e = await say(dir, "20200101-000000-nope", "т").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ToolError);
      expect((e as Error).message).toBe("Session 20200101-000000-nope was not found.");
      const c = await cont(dir, "s1", " ").catch((x: unknown) => x);
      expect((c as Error).message).toMatch(/^The waitId of the current wait is required/);
      expect((c as Error).message).not.toMatch(/[А-Яа-яЁё]/);
    } finally { setProcessLanguage("ru"); }
    await refused(dir, "s1", () => say(dir, "s1", "т", "q99"), /не найден/);
    await refused(dir, "s1", () => say(dir, "s1", "т", "q1"), /не адресован владельцу/);

    await say(dir, "s2", "Ответ", "q1");
    await until(() => readSession(dir, "s2")!.state.questions.find((q) => q.id === "q1")?.status === "answered");
    await refused(dir, "s2", () => say(dir, "s2", "Ещё", "q1"), /уже закрыт/);
  });

  it("finished and interrupted sessions", async () => {
    const dir = tmp();
    await start(dir, "done", plain());
    await refused(dir, "done", () => say(dir, "done", "т"), /завершена/);
    dead(dir, "gone");
    await refused(dir, "gone", () => say(dir, "gone", "т"), /прервана/);
  });

  it("a discussion participant cannot speak for the owner", async () => {
    const dir = tmp();
    void start(dir, "s1", plain(), { pauseAfterRound: true, timeoutSec: 30 });
    await waiting(dir, "s1");
    const n = evs(dir, "s1").length;
    const e = await rejected(councilSay.run({ ...ctxOf(dir), env: { ...env, COUNCIL_PARTICIPANT: "1" } }, { sessionId: "s1", text: "т" }));
    expect((e as Error).message).toMatch(/Участник обсуждения/);
    expect(evs(dir, "s1").length).toBe(n);
    expect(queued(dir, "s1")).toBe(0);
  });

  it("the message text does not get into the server journal", async () => {
    const dir = tmp();
    const mark = "МЕТКА-7c1f9e2a-ТЕКСТ";
    const logger = createLogger(dir, "mcp", env);
    void start(dir, "s1", plain(), { pauseAfterRound: true, timeoutSec: 30 });
    const w = await waiting(dir, "s1");
    const r = await councilSay.run(ctxOf(dir, logger), { sessionId: "s1", text: mark }) as any;
    await until(() => of(dir, "s1", "owner_message")[0]);
    await councilContinue.run(ctxOf(dir, logger), { sessionId: "s1", waitId: w.waitId });
    const log = readFileSync(join(dir, "logs/app.log"), "utf8");
    expect(log).toContain(r.requestId);
    expect(log).not.toContain(mark);
  });
});

describe("journal of a newer version", () => {
  it("council_say and council_continue: error with code newer_version, the journal and the queue do not change", async () => {
    const dir = tmp();
    dead(dir, "nv");
    appendFileSync(eventsPath(dir, "nv"), JSON.stringify({ seq: 2, ts: "2026-01-01T00:00:00.000Z", type: "future_event" }) + "\n");
    const raw = readFileSync(eventsPath(dir, "nv"));
    const re = /^newer_version: Сессия nv: журнал записан более новой версией, прочитан до события №1; /;
    await refused(dir, "nv", () => say(dir, "nv", "Привет"), re);
    await refused(dir, "nv", () => cont(dir, "nv", "w1"), re);
    const e = await rejected(say(dir, "nv", "Привет"));
    expect((e as Error).message).not.toMatch(/повреждён/);
    expect(readFileSync(eventsPath(dir, "nv")).equals(raw)).toBe(true);
    expect(queued(dir, "nv")).toBe(0);
  });
});

describe("council_continue", () => {
  it("clears the current wait by the previous executor without a new launch", async () => {
    const dir = tmp();
    const run = start(dir, "s1", plain(), { pauseAfterRound: true, timeoutSec: 30 });
    const w = await waiting(dir, "s1");
    const pid = readSession(dir, "s1")!.state.pid;
    const r = await cont(dir, "s1", w.waitId);
    expect(r).toMatchObject({ sessionId: "s1", waitId: w.waitId, queued: true });
    const f = await until(() => of(dir, "s1", "owner_wait_finished")[0]);
    expect(f).toMatchObject({ waitId: w.waitId, reason: "continued", requestId: r.requestId });
    await run;
    expect(of(dir, "s1", "session_created")).toHaveLength(1);
    expect(of(dir, "s1", "session_resumed")).toEqual([]);
    expect(readSession(dir, "s1")!.state.pid).toBe(pid);
  });

  it("refusals write neither to the journal nor to the queue", async () => {
    const dir = tmp();
    void start(dir, "s1", plain(), { pauseAfterRound: true, timeoutSec: 30 });
    await waiting(dir, "s1");
    await refused(dir, "s1", () => cont(dir, "s1", "w99"), /./);
    await refused(dir, "s1", () => cont(dir, "s1", ""), /waitId/);
    await refused(dir, "s1", () => cont(dir, "s1", "  "), /waitId/);
    await expect(cont(dir, "20200101-000000-nope", "w1")).rejects.toThrow(/не найдена/);

    await start(dir, "nowait", plain());
    await refused(dir, "nowait", () => cont(dir, "nowait", "w1"), /./);
    dead(dir, "gone");
    await refused(dir, "gone", () => cont(dir, "gone", "w1"), /прервана|исполнитель/);

    // running session without a wait
    void start(dir, "busy", [{ steps: [{ ...step("amend", "В"), delayMs: 3000 }, step("agree", null)] }, { steps: [step("agree", null)] }]);
    await until(() => existsSync(join(dir, "sessions", "busy")) || readSession(dir, "busy"));
    await refused(dir, "busy", () => cont(dir, "busy", "w1"), /./);
  });

  it("a discussion participant cannot clear the wait", async () => {
    const dir = tmp();
    void start(dir, "s1", plain(), { pauseAfterRound: true, timeoutSec: 30 });
    const w = await waiting(dir, "s1");
    const e = await rejected(councilContinue.run({ ...ctxOf(dir), env: { ...env, COUNCIL_PARTICIPANT: "1" } }, { sessionId: "s1", waitId: w.waitId }));
    expect((e as Error).message).toMatch(/Участник обсуждения/);
    expect(of(dir, "s1", "owner_wait_finished")).toEqual([]);
  });
});

describe("executor in another process", () => {
  it("a message and clearing the wait are applied by a separate council process", async () => {
    const dir = tmp();
    const sc = (n: string) => `scripted:${join(scenarios, "owner-wait", n)}.json`;
    const child = spawn(process.execPath, [
      join(root, "packages/core/src/council.ts"), "--topic", "Какой отчёт готовить к пятнице",
      "--participant", sc("plain-p1"), "--participant", sc("plain-p2"), "--max-rounds", "3", "--pause-after-round", "--owner-wait-sec", "60",
    ], { env: { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir } });
    kids.push(child);
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const id = await until(() => /^Сессия (\S+) ·/m.exec(out)?.[1]);
    const w = await waiting(dir, id);

    const r = await say(dir, id, "Реплика из другого процесса");
    const m = await until(() => of(dir, id, "owner_message")[0]);
    expect(m.requestId).toBe(r.requestId);
    expect(of(dir, id, "owner_wait_finished")).toEqual([]);

    const c = await cont(dir, id, w.waitId);
    const f = await until(() => of(dir, id, "owner_wait_finished")[0]);
    expect(f).toMatchObject({ reason: "continued", requestId: c.requestId });
    await until(() => readSession(dir, id)!.status === "consensus");
    expect(readSession(dir, id)!.state.pid).toBe(child.pid);
    expect(of(dir, id, "session_created")[0]!.pid).toBe(child.pid);
    expect(of(dir, id, "session_resumed")).toEqual([]);
  }, 40000);
});
