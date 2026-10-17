import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage, appendEvent, eventsPath, partialNote, collectMaterials, planResume, readRegistry, ensureRegistry, resumeDrivers, runResumedSession, draftPath, createSessionJournal, selectOwnerVersion, createScriptedDriver, createSession, listSessions, readScenario, readSession, runStoredSession } from "@model-council/core";
import type { Scenario, SessionEvent } from "@model-council/core";
import { ToolError } from "./context.ts";
import type { ToolContext } from "./context.ts";
import { councilStatus, councilStop, WAIT_CAP_SEC } from "./status.ts";

const root = join(import.meta.dirname, "../../..");
const scenarios = join(root, "packages/core/scenarios");
const env = { COUNCIL_DEV: "1" };
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const ctxOf = (dataDir: string): ToolContext => ({
  dataDir, env, pollMs: 20, shutdown: new AbortController().signal,
  logger: { info: () => {}, error: () => {} }, builtinTemplatesDir: "", scenariosDir: null,
});

const mk = (id: string, n: number, maxRounds = 3, maxTotalTokens?: number) =>
  createSession(
    {
      topic: "Как назвать кота", framing: "", origin: "mcp", limits: { maxRounds, turnTimeoutSec: 30, contextChars: 20000, ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }) },
      participants: Array.from({ length: n }, (_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id },
  );

const aborts: AbortController[] = [];
const runs: Promise<unknown>[] = [];
afterEach(async () => {
  for (const a of aborts.splice(0)) a.abort();
  await Promise.allSettled(runs.splice(0));
});

// starts a session in this process; returns the completion promise
async function start(dataDir: string, id: string, files: Scenario[] | string, maxRounds = 3, maxTotalTokens?: number) {
  const list = typeof files === "string"
    ? await Promise.all([1, 2, 3].map((i) => readScenario(join(scenarios, files, `p${i}.json`)).catch(() => null)))
    : files;
  const sc = list.filter((s): s is Scenario => s !== null);
  const drivers = Object.fromEntries(sc.map((s, i) => [`p${i + 1}`, createScriptedDriver(s, env)]));
  const ctl = new AbortController();
  aborts.push(ctl);
  const p = runStoredSession({ session: mk(id, sc.length, maxRounds, maxTotalTokens), drivers, dataDir, signal: ctl.signal });
  runs.push(p);
  return p;
}

const step = (stance: string, solution: string | null, delayMs?: number) => ({
  response: { stance, reasoning: `${stance}: ${solution ?? "ок"}`, solution, answers: [], questions: [] }, delayMs,
}) as Scenario["steps"][number];

const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("не дождались"); await new Promise((r) => setTimeout(r, 20)); }
};

describe("council_status", () => {
  it("1. running session: the full decision, no stats and objectors", async () => {
    const dir = tmp();
    void start(dir, "s1", [{ steps: [step("amend", "Назвать кота Тигра, длинный текст версии.")] }, { steps: [step("agree", null, 30000)] }]);
    await until(() => (readSession(dir, "s1")?.state.turns.length ?? 0) === 1);
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "s1" })) as any;
    expect(r).toMatchObject({ status: "running", statusText: "идёт", round: 1, maxRounds: 3, turns: 1, agreed: ["p1"] });
    expect(r.solution).toEqual({ version: 1, authorId: "p1", text: "Назвать кота Тигра, длинный текст версии." });
    expect(r.participants[0]).toMatchObject({ id: "p1", name: "N1", state: "active", lastStance: "amend" });
    expect(r.participants[1].lastStance).toBeNull();
    expect("stats" in r).toBe(false);
    expect("objectors" in r).toBe(false);
    expect(r.wait).toEqual({ requestedSec: 0, appliedSec: 0, truncated: false, changed: false });
  });

  it("2. consensus: result and statistics", async () => {
    const dir = tmp();
    await start(dir, "s2", "consensus");
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "s2" })) as any;
    expect(r).toMatchObject({ status: "consensus", statusText: "согласие достигнуто", agreed: ["p1", "p2"] });
    expect(r.solution.text).toBe("Назвать кота Мурзик Великий.");
    expect(r.objectors).toEqual([]);
    expect(r.stats).toMatchObject({ rounds: 2, turns: 3, inputTokens: null, outputTokens: null, costUsd: 0 });
    expect(r.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("language: statusText of a finished session on en, status as before; refusal on an unknown id on en without Cyrillic", async () => {
    const dir = tmp();
    await start(dir, "s2en", "consensus");
    setProcessLanguage("en");
    try {
      const r = (await councilStatus.run(ctxOf(dir), { sessionId: "s2en" })) as any;
      expect(r.status).toBe("consensus");
      expect(r.statusText).toMatch(/^consensus/);
      const e = await councilStatus.run(ctxOf(dir), { sessionId: "20200101-000000-nope" }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ToolError);
      expect((e as Error).message).toBe("Session 20200101-000000-nope was not found.");
    } finally { setProcessLanguage("ru"); }
  });

  it("3. no_consensus: an objector with an argument", async () => {
    const dir = tmp();
    await start(dir, "s3", "no-consensus", 2);
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "s3" })) as any;
    expect(r).toMatchObject({ status: "no_consensus", statusText: "согласия нет", round: 2, maxRounds: 2, turns: 6 });
    expect(r.solution.text).toBe("Назвать кота Барсик.");
    expect(r.agreed).toEqual(["p1", "p2"]);
    expect(r.objectors).toEqual([{ participantId: "p3", name: "N3", reasoning: "По-прежнему нужно более редкое имя." }]);
    expect(r.stats).toMatchObject({ rounds: 2, turns: 6 });
  });

  it("3a. the owner's choice does not change the discussion result", async () => {
    const dir = tmp();
    await start(dir, "s3a", "no-consensus", 2);
    const before = (await councilStatus.run(ctxOf(dir), { sessionId: "s3a" })) as any;
    expect("ownerSelection" in before).toBe(false);
    const text1 = readSession(dir, "s3a")!.state.versions.find((v) => v.number === 1)!.text;
    const sel = selectOwnerVersion(dir, "s3a", { version: 1, note: "Берём первую" });
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "s3a" })) as any;
    expect(r.status).toBe("no_consensus");
    expect(r.solution).toEqual(before.solution);
    expect(r.objectors).toEqual(before.objectors);
    expect(r.ownerSelection).toEqual({ version: 1, text: text1, note: "Берём первую", selectedAt: sel.ts, statusAtSelection: "no_consensus" });
    const { ownerSelection, ...rest } = r;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(before).sort());
    const stop = (await councilStop.run(ctxOf(dir), { sessionId: "s3a" })) as any;
    expect(stop.ownerSelection).toEqual(r.ownerSelection);
  });

  it("3b. a choice without a note: note equals null", async () => {
    const dir = tmp();
    await start(dir, "s3b", "no-consensus", 2);
    selectOwnerVersion(dir, "s3b", { version: 1 });
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "s3b" })) as any;
    expect(r.ownerSelection.note).toBeNull();
  });

  it("4. unknown and invalid identifier", async () => {
    const dir = tmp();
    for (const id of ["нет-такой", "../x"]) {
      await expect(councilStatus.run(ctxOf(dir), { sessionId: id })).rejects.toThrow(ToolError);
      await expect(councilStatus.run(ctxOf(dir), { sessionId: id })).rejects.toThrow("не найдена");
    }
  });

  it("5. early return on a new turn", async () => {
    const dir = tmp();
    void start(dir, "s5", [{ steps: [step("amend", "Версия А", 400)] }, { steps: [step("agree", null, 30000)] }]);
    await until(() => readSession(dir, "s5") !== null);
    const t0 = Date.now();
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "s5", waitSec: 10 })) as any;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.wait).toMatchObject({ requestedSec: 10, appliedSec: 10, truncated: false, changed: true });
    expect(r.turns).toBe(1);
  });

  it("6. time expiry without changes", async () => {
    const dir = tmp();
    void start(dir, "s6", [{ steps: [step("amend", "Версия А", 30000)] }, { steps: [step("agree", null)] }]);
    await until(() => readSession(dir, "s6") !== null);
    const t0 = Date.now();
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "s6", waitSec: 1 })) as any;
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(900);
    expect(dt).toBeLessThan(2500);
    expect(r.wait).toMatchObject({ changed: false });
    expect(r.turns).toBe(0);
    expect(r.status).toBe("running");
  });

  it("7. wait truncation; a finished session answers immediately", async () => {
    const dir = tmp();
    await start(dir, "s7", "consensus");
    const t0 = Date.now();
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "s7", waitSec: 120 })) as any;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.wait).toEqual({ requestedSec: 120, appliedSec: WAIT_CAP_SEC, truncated: true, changed: false });
    await expect(councilStatus.run(ctxOf(dir), { sessionId: "s7", waitSec: -1 })).rejects.toThrow(ToolError);
    await expect(councilStatus.run(ctxOf(dir), { sessionId: "s7", waitSec: Number.NaN })).rejects.toThrow(ToolError);
  });
});

describe("council_stop", () => {
  it("8. own session: stopped and the latest version", async () => {
    const dir = tmp();
    const done = start(dir, "t8", [{ steps: [step("amend", "Версия А")] }, { steps: [step("agree", null, 30000)] }]);
    await until(() => (readSession(dir, "t8")?.state.turns.length ?? 0) === 1);
    const r = (await councilStop.run(ctxOf(dir), { sessionId: "t8" })) as any;
    await done;
    expect(r).toMatchObject({ status: "stopped", message: "Сессия остановлена." });
    expect(r.solution.text).toBe("Версия А");
    expect(r.stats).toBeDefined();
  });

  describe("9. session in another process", () => {
    let child: ChildProcess | undefined;
    afterEach(() => { child?.kill("SIGKILL"); });

    it("stops the terminal command, code 4", async () => {
      const home = tmp();
      const slow = join(tmp(), "slow.json");
      writeFileSync(slow, JSON.stringify({ steps: [step("amend", "Версия А", 30000)] }));
      const other = join(scenarios, "slow/p1.json");
      child = spawn(
        process.execPath,
        ["packages/core/src/council.ts", "--topic", "Как назвать кота", "--participant", `scripted:${slow}`, "--participant", `scripted:${other}`, "--max-rounds", "3"],
        { cwd: root, env: { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: home }, stdio: "ignore" },
      );
      const exit = new Promise<number | null>((res) => child!.on("close", res));
      await until(() => listSessions(home).length === 1, 10000);
      const id = listSessions(home)[0]!.id;
      const r = (await councilStop.run(ctxOf(home), { sessionId: id })) as any;
      expect(r).toMatchObject({ status: "stopped", message: "Сессия остановлена." });
      expect(await exit).toBe(4);
    });
  });

  it("10. a finished session is not an error", async () => {
    const dir = tmp();
    await start(dir, "t10", "consensus");
    const r = (await councilStop.run(ctxOf(dir), { sessionId: "t10" })) as any;
    expect(r.status).toBe("consensus");
    expect(r.message).toBe("Сессия уже завершена: согласие достигнуто.");
    expect(r.solution.text).toBe("Назвать кота Мурзик Великий.");
  });

  it("11. unknown session", async () => {
    await expect(councilStop.run(ctxOf(tmp()), { sessionId: "нет" })).rejects.toThrow(ToolError);
    await expect(councilStop.run(ctxOf(tmp()), { sessionId: "../x" })).rejects.toThrow("не найдена");
  });
});

describe("session materials in council_status and council_stop", () => {
  const SECRET = "СЕКРЕТНЫЙ-ТЕКСТ-МАТЕРИАЛА";
  // starts a session with two materials (a.txt, folder/b.txt); hold — the second participant does not answer for 30 s
  async function startWithMaterials(dir: string, id: string, hold: boolean) {
    const src = realpathSync(tmp());
    writeFileSync(join(src, "a.txt"), `${SECRET} 1`);
    mkdirSync(join(src, "folder"));
    writeFileSync(join(src, "folder", "b.txt"), `${SECRET} 22`);
    const set = collectMaterials([join(src, "a.txt"), join(src, "folder", "b.txt")], { materialsChars: 1000, materialsIgnore: [] });
    const session = createSession({ ...mkInput(id), materials: set.materials }, { maxParticipants: 8, id });
    const scs: Scenario[] = [{ steps: [step("amend", "Версия А")] }, { steps: [step("agree", null, hold ? 30000 : undefined)] }];
    const drivers = Object.fromEntries(scs.map((s, i) => [`p${i + 1}`, createScriptedDriver(s, env)]));
    const ctl = new AbortController();
    aborts.push(ctl);
    const p = runStoredSession({ session, drivers, dataDir: dir, signal: ctl.signal, materials: set.materials });
    runs.push(p);
    return { set, done: p };
  }
  const mkInput = (id: string) => {
    const { materials: _m, ...rest } = mk(id, 2) as any;
    rest.limits = { ...rest.limits, materialsChars: 1000 };
    return rest;
  };

  it("12. names and total size, no texts or sha256; running, finished and stop", async () => {
    const dir = tmp();
    const { set } = await startWithMaterials(dir, "m1", true);
    const names = set.materials.map((m) => m.name);
    const chars = set.materials.reduce((n, m) => n + m.chars, 0);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe("a.txt");
    await until(() => (readSession(dir, "m1")?.state.turns.length ?? 0) === 1);
    const running = (await councilStatus.run(ctxOf(dir), { sessionId: "m1" })) as any;
    expect(running.status).toBe("running");
    expect(running.materials).toEqual({ names, chars });
    const stopped = (await councilStop.run(ctxOf(dir), { sessionId: "m1" })) as any;
    expect(stopped.status).toBe("stopped");
    expect(stopped.materials).toEqual({ names, chars });
    const finished = (await councilStatus.run(ctxOf(dir), { sessionId: "m1" })) as any;
    expect(finished.materials).toEqual({ names, chars });
    for (const r of [running, stopped, finished]) {
      const json = JSON.stringify(r);
      expect(json).not.toContain(SECRET);
      for (const m of set.materials) expect(json).not.toContain(m.sha256);
    }
  });

  it("13. finished session with and without materials", async () => {
    const dir = tmp();
    const { done } = await startWithMaterials(dir, "m2", false);
    await done;
    const withM = (await councilStatus.run(ctxOf(dir), { sessionId: "m2" })) as any;
    expect(withM.status).not.toBe("running");
    expect(withM.materials.names).toHaveLength(2);
    await start(dir, "m3", "consensus");
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "m3" })) as any;
    expect(r.materials).toEqual({ names: [], chars: 0 });
    expect(r).toMatchObject({ status: "consensus", topic: "Как назвать кота", agreed: ["p1", "p2"] });
    expect(r.solution.text).toBe("Назвать кота Мурзик Великий.");
  });
});

describe("council_status: token cap", () => {
  const get = async (dir: string, id: string) => (await councilStatus.run(ctxOf(dir), { sessionId: id })) as any;

  it("8. stop by the cap: reason, cap, spending, version and objectors", async () => {
    const dir = tmp();
    await start(dir, "t1", "token-cap", 3, 1200);
    const r = await get(dir, "t1");
    expect(r).toMatchObject({ status: "stopped", reason: "token_cap", maxTotalTokens: 1200, tokens: { input: 900, output: 600, total: 1500, incomplete: false } });
    expect(r.solution.text.length).toBeGreaterThan(0);
    expect(r.objectors.length).toBeGreaterThan(0);
    expect(r.objectors[0].reasoning).toBeTruthy();
  });

  it("9. without a cap: reason null, maxTotalTokens null, tokens counted", async () => {
    const dir = tmp();
    await start(dir, "t2", "token-cap/agree");
    const r = await get(dir, "t2");
    expect(r.reason).toBeNull();
    expect(r.maxTotalTokens).toBeNull();
    expect(r.tokens).toEqual({ input: expect.any(Number), output: expect.any(Number), total: 1200, incomplete: false });
  });

  it("10. incomplete accounting: participants do not report tokens", async () => {
    const dir = tmp();
    await start(dir, "t3", "consensus");
    const r = await get(dir, "t3");
    expect(r.tokens.incomplete).toBe(true);
    expect(r.tokens.total).toBe(0);
  });

  it("11. the fields are present for a running session and in the council_stop response", async () => {
    const dir = tmp();
    void start(dir, "t4", [{ steps: [step("amend", "Версия.")] }, { steps: [step("agree", null, 30000)] }], 3, 9000);
    await until(() => (readSession(dir, "t4")?.state.turns.length ?? 0) === 1);
    const r = await get(dir, "t4");
    expect(r).toMatchObject({ status: "running", maxTotalTokens: 9000 });
    expect(r.tokens).toMatchObject({ total: 0, incomplete: true });
    const stopped = (await councilStop.run(ctxOf(dir), { sessionId: "t4" })) as any;
    expect(stopped.maxTotalTokens).toBe(9000);
    expect(stopped.tokens).toBeDefined();
  });

  it("12. consensus when the cap is exceeded: consensus, reason null", async () => {
    const dir = tmp();
    await start(dir, "t5", "token-cap/agree", 3, 800);
    const r = await get(dir, "t5");
    expect(r).toMatchObject({ status: "consensus", reason: null, maxTotalTokens: 800 });
    expect(r.tokens.total).toBe(1200);
  });
});

describe("council_status: spending of the failure of the previous segment", () => {
  it("Accumulated session metrics: the failure of turn 2 before resuming is included in the 270 tokens and the cap", async () => {
    const dir = tmp();
    const ac = new AbortController();
    let n = 0;
    // turn 2: an invalid answer of 250 tokens, the retry is cut off by a stop
    const p2First = {
      call: () => {
        if (n++ === 0) return Promise.resolve({ text: "это не JSON", usage: { inputTokens: 150, outputTokens: 100 } });
        ac.abort();
        return new Promise<never>(() => {});
      },
    };
    await runStoredSession({
      session: mk("f1", 2, 2, 270),
      drivers: { p1: createScriptedDriver({ steps: [step("amend", "v1")] }, env), p2: p2First },
      dataDir: dir, signal: ac.signal,
    });
    // resuming repeats turn 2 at 10/10 (objection) and hits the cap
    const plan = planResume(dir, "f1", { isAlive: () => false });
    const valid = JSON.stringify({ stance: "object", reasoning: "r", solution: null, answers: [], questions: [] });
    await runResumedSession({
      dataDir: dir, plan, isAlive: () => false,
      drivers: {
        p1: createScriptedDriver({ steps: [] }, env),
        p2: { call: async () => ({ text: valid, usage: { inputTokens: 10, outputTokens: 10 } }) },
      },
    });
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "f1" })) as any;
    expect(r).toMatchObject({ status: "stopped", reason: "token_cap", maxTotalTokens: 270 });
    expect(r.tokens).toMatchObject({ input: 160, output: 110, total: 270 });
  });
});

describe("council_status: owner questions, waiting and messages", () => {
  const get = async (dir: string, id: string, waitSec?: number) => (await councilStatus.run(ctxOf(dir), { sessionId: id, waitSec })) as any;

  // a journal assembled by hand; the executor's pid is this process (alive) or a nonexistent one (interrupted)
  type Ev = Record<string, unknown>;
  const journal = (dir: string, id: string, events: Ev[], pid = 1) => {
    createSessionJournal(dir, id);
    let seq = 0;
    const add = (e: Ev) => appendEvent(dir, id, { seq: ++seq, ts: new Date().toISOString(), ...e } as SessionEvent);
    add({ type: "session_created", session: mk(id, 2), pid });
    events.forEach(add);
    return add;
  };
  const turn = (n: number, participantId: string, questions: { id: string; to: string; text: string }[] = []) => [
    { type: "turn_started", turn: n, round: 1, participantId },
    {
      type: "turn_completed", turn: n, round: 1, participantId, stance: "amend", normalized: false, reasoning: "р", solution: "Версия",
      version: 1, questions, answers: [], attempts: 1, usage: {}, durationMs: 1,
    },
  ];
  const wait = (waitId = "w1", extra: Ev = {}) => ({
    type: "owner_wait_started", waitId, reasons: ["owner_question"], questionIds: ["q1"], afterTurn: 1,
    deadline: new Date(Date.now() + 600000).toISOString(), ...extra,
  });
  const ask = [...turn(1, "p1", [{ id: "q1", to: "owner", text: "Какой бюджет?" }, { id: "q2", to: "p2", text: "А ты?" }])];
  const msg = (answers?: { questionId: string; text: string }[]) => ({
    type: "owner_message", id: "o1", text: "СЕКРЕТНАЯ-РЕПЛИКА", afterTurn: 1, requestId: "r1", ...(answers ? { answers } : {}),
  });
  // a call with a wait: the journal changes after 300 ms; the answer is noticeably earlier than waitSec, no turns were added
  async function early(dir: string, id: string, change: () => void) {
    const turns = (await get(dir, id)).turns;
    setTimeout(change, 300);
    const t0 = Date.now();
    const r = await get(dir, id, 10);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.wait.changed).toBe(true);
    expect(r.turns).toBe(turns);
    return r;
  }

  it("ownerQuestions: only open owner questions, openQuestions counts all", async () => {
    const dir = tmp();
    journal(dir, "o1", [...ask, { type: "question_closed", questionId: "q2", reason: "unanswered" }, ...turn(2, "p2", [{ id: "q3", to: "owner", text: "Срок?" }]),
      { type: "question_closed", questionId: "q3", reason: "unanswered" }]);
    let r = await get(dir, "o1");
    expect(r.ownerQuestions).toEqual([{ id: "q1", authorId: "p1", author: "N1", text: "Какой бюджет?", turn: 1 }]);
    expect(r.openQuestions).toBe(1);
    const dir2 = tmp();
    journal(dir2, "o2", ask);
    r = await get(dir2, "o2");
    expect(r.ownerQuestions.map((q: any) => q.id)).toEqual(["q1"]);
    expect(r.openQuestions).toBe(2);
  });

  it("waiting: four fields and statusText; without waiting null", async () => {
    const dir = tmp();
    const w = wait("w1", { reasons: ["round_boundary", "owner_question"], deadline: "2099-01-01T00:00:00.000Z" });
    journal(dir, "w1", [...ask, w]);
    const r = await get(dir, "w1");
    expect(r.waiting).toEqual({ waitId: "w1", reasons: ["round_boundary", "owner_question"], questionIds: ["q1"], deadline: "2099-01-01T00:00:00.000Z" });
    expect(r).toMatchObject({ status: "running", statusText: "идёт, ждёт владельца" });
    const dir2 = tmp();
    journal(dir2, "w2", ask);
    const r2 = await get(dir2, "w2");
    expect(r2.waiting).toBeNull();
    expect(r2.statusText).toBe("идёт");
  });

  it("old journal: the new fields are empty", async () => {
    const dir = tmp();
    await start(dir, "old", "consensus");
    const r = await get(dir, "old");
    expect(r).toMatchObject({ ownerQuestions: [], waiting: null, ownerMessages: [] });
  });

  it("interrupted session with a wait: status interrupted, waiting preserved", async () => {
    const dir = tmp();
    journal(dir, "int", [...ask, wait()], 2147483646);
    const r = await get(dir, "int");
    expect(r.status).toBe("interrupted");
    expect(r.statusText).toBe("прервана");
    expect(r.waiting).toMatchObject({ waitId: "w1", questionIds: ["q1"] });
  });

  it("ownerSelection next to the new fields", async () => {
    const dir = tmp();
    await start(dir, "sel", "no-consensus", 2);
    selectOwnerVersion(dir, "sel", { version: 1 });
    const r = await get(dir, "sel");
    expect(r.ownerSelection.version).toBe(1);
    expect(r).toMatchObject({ ownerQuestions: [], waiting: null, ownerMessages: [] });
  });

  it("ownerMessages: requestId, afterTurn, answered, no message text", async () => {
    const dir = tmp();
    journal(dir, "om", [...ask, msg([{ questionId: "q1", text: "СЕКРЕТНЫЙ-ОТВЕТ" }])]);
    const r = await get(dir, "om");
    expect(r.ownerMessages).toEqual([{ requestId: "r1", afterTurn: 1, answered: ["q1"] }]);
    expect(JSON.stringify(r)).not.toContain("СЕКРЕТНАЯ-РЕПЛИКА");
    expect(JSON.stringify(r)).not.toContain("СЕКРЕТНЫЙ-ОТВЕТ");
  });

  it("wait: an answer to an owner question wakes", async () => {
    const dir = tmp();
    const add = journal(dir, "e1", ask);
    const r = await early(dir, "e1", () => add({ ...msg([{ questionId: "q1", text: "100" }]) }));
    expect(r.ownerMessages).toHaveLength(1);
  });

  it("wait: closing a question wakes", async () => {
    const dir = tmp();
    const add = journal(dir, "e2", ask);
    const r = await early(dir, "e2", () => add({ type: "question_closed", questionId: "q1", reason: "unanswered" }));
    expect(r.ownerQuestions).toEqual([]);
  });

  it("wait: a regular message wakes", async () => {
    const dir = tmp();
    const add = journal(dir, "e3", turn(1, "p1"));
    const r = await early(dir, "e3", () => add(msg()));
    expect(r.ownerMessages).toHaveLength(1);
  });

  it("wait: a resume request (clearing the wait) wakes", async () => {
    const dir = tmp();
    const add = journal(dir, "e4", [...ask, wait()]);
    const r = await early(dir, "e4", () => add({ type: "owner_wait_finished", waitId: "w1", reason: "continued", requestId: "c1" }));
    expect(r.waiting).toBeNull();
  });

  it("wait: deadline expiry wakes", async () => {
    const dir = tmp();
    const add = journal(dir, "e5", [...ask, wait()]);
    const r = await early(dir, "e5", () => add({ type: "owner_wait_finished", waitId: "w1", reason: "expired" }));
    expect(r.waiting).toBeNull();
  });

  it("wait: the start of a wait wakes", async () => {
    const dir = tmp();
    const add = journal(dir, "e6", ask);
    const r = await early(dir, "e6", () => add(wait()));
    expect(r.waiting).toMatchObject({ waitId: "w1" });
  });

  it("wait: a reasons update wakes", async () => {
    const dir = tmp();
    const add = journal(dir, "e7", [...ask, wait()]);
    const r = await early(dir, "e7", () => add({ type: "owner_wait_updated", waitId: "w1", reasons: ["round_boundary", "owner_question"], questionIds: ["q1"] }));
    expect(r.waiting.reasons).toEqual(["round_boundary", "owner_question"]);
  });

  it("nothing changed: turn_started does not wake, answer when waitSec expires", async () => {
    const dir = tmp();
    const add = journal(dir, "n1", ask);
    setTimeout(() => add({ type: "turn_started", turn: 2, round: 1, participantId: "p2" }), 300);
    const t0 = Date.now();
    const r = await get(dir, "n1", 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(r.wait.changed).toBe(false);
    expect(r.turns).toBe(1);
  });
});

describe("council_status: folder snapshot and reading", () => {
  const MARK = "МЕТКА-СНИМОК-39";
  const workspace = [
    { name: "sample/src/engine.ts", text: `export const f = () => 1; // ${MARK}` },
    { name: "sample/README.md", text: "Описание примера." },
  ];
  const total = workspace.reduce((n, w) => n + w.text.length, 0);
  // hold — the second participant does not answer for 30 s
  async function startFolder(dir: string, id: string, hold: boolean, ask?: string[]) {
    const input = (({ materials: _m, ...r }) => r)(mk(id, 2) as any);
    const session = createSession({ ...input, workspace }, { maxParticipants: 8, id });
    const p1 = await readScenario(join(scenarios, "folder/p1.json"));
    if (ask) (p1.steps[0] as any).response.files = ask;
    const scs: Scenario[] = [p1, hold ? { steps: [step("agree", null, 30000)] } : await readScenario(join(scenarios, "folder/p2.json"))];
    const drivers = Object.fromEntries(scs.map((s, i) => [`p${i + 1}`, createScriptedDriver(s, env)]));
    const ctl = new AbortController();
    aborts.push(ctl);
    const p = runStoredSession({ session, drivers, dataDir: dir, signal: ctl.signal, workspace });
    runs.push(p);
    return p;
  }

  it("a. reading from the snapshot: folder and filesRead without texts", async () => {
    const dir = tmp();
    await startFolder(dir, "f1", false);
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "f1" })) as any;
    expect(r.folder).toEqual({ files: 2, chars: total });
    expect(r.filesRead).toHaveLength(1);
    const f = r.filesRead[0];
    const t = readSession(dir, "f1")!.state.turns.find((x) => x.participantId === "p1" && x.filesRead?.length)!;
    expect(f).toMatchObject({ name: "sample/src/engine.ts", participantId: "p1", turn: t.turn, chars: workspace[0]!.text.length });
    expect(f.shown).toBeLessThanOrEqual(f.chars);
    expect(JSON.stringify(r)).not.toContain(MARK);
  });

  it("a2. a requested but not served name does not get into filesRead", async () => {
    const dir = tmp();
    await startFolder(dir, "f1b", false, ["sample/src/engine.ts", "sample/нет-такого.ts"]);
    expect(readSession(dir, "f1b")!.state.turns.flatMap((t) => t.filesRead ?? []).map((f) => f.shown)).toEqual([workspace[0]!.text.length, 0]);
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "f1b" })) as any;
    expect(r.filesRead.map((f: any) => f.name)).toEqual(["sample/src/engine.ts"]);
  });

  it("b. a running session and council_stop give the same view", async () => {
    const dir = tmp();
    void startFolder(dir, "f2", true);
    await until(() => (readSession(dir, "f2")?.state.turns.length ?? 0) >= 1);
    const running = (await councilStatus.run(ctxOf(dir), { sessionId: "f2" })) as any;
    expect(running.status).toBe("running");
    expect(running.folder).toEqual({ files: 2, chars: total });
    expect(Array.isArray(running.filesRead)).toBe(true);
    const stopped = (await councilStop.run(ctxOf(dir), { sessionId: "f2" })) as any;
    expect(stopped.folder).toEqual(running.folder);
    expect(Array.isArray(stopped.filesRead)).toBe(true);
    expect(JSON.stringify([running, stopped])).not.toContain(MARK);
  });

  it("c. session without a folder: folder null, filesRead empty", async () => {
    const dir = tmp();
    await start(dir, "f3", "consensus");
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "f3" })) as any;
    expect(r.folder).toBeNull();
    expect(r.filesRead).toEqual([]);
    expect(r).toMatchObject({ status: "consensus", materials: { names: [], chars: 0 } });
    expect(r.solution.text).toBe("Назвать кота Мурзик Великий.");
  });

  it("d. tool description", () => {
    for (const w of ["folder", "filesRead", "без текстов"]) expect(councilStatus.description).toContain(w);
  });
});

describe("council_status: independent drafts", () => {
  const dstep = (stance: string, solution: string | null, extra: Record<string, unknown> = {}) =>
    ({ response: { stance, reasoning: `обоснование ${solution ?? stance}`, solution, answers: [], questions: [] }, ...extra }) as Scenario["steps"][number];
  const scn = (n: number, delayMs?: number): Scenario[] => [
    { steps: [dstep("amend", "ЧЕРНОВИК-1", { inputTokens: 10, outputTokens: 5 }), dstep("amend", "Итог", { inputTokens: 100, outputTokens: 50 })] },
    { steps: [dstep("amend", "ЧЕРНОВИК-2", { inputTokens: 20, outputTokens: 7, ...(delayMs ? { delayMs } : {}) }), dstep("agree", null, { inputTokens: 100, outputTokens: 50 })] },
    { steps: [dstep("amend", "ЧЕРНОВИК-3", { inputTokens: 30, outputTokens: 9 }), dstep("agree", null, { inputTokens: 100, outputTokens: 50 })] },
  ].slice(0, n) as Scenario[];
  const run = (dir: string, id: string, files: Scenario[], synthesizerId?: string) => {
    const drivers = Object.fromEntries(files.map((s, i) => [`p${i + 1}`, createScriptedDriver(s, env)]));
    const ctl = new AbortController();
    aborts.push(ctl);
    const session = createSession(
      { topic: "Т", framing: "", origin: "mcp", limits: { maxRounds: 2, turnTimeoutSec: 30, contextChars: 20000 }, drafts: synthesizerId ? { synthesizerId } : {},
        participants: files.map((_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })) },
      { maxParticipants: 8, id },
    );
    const p = runStoredSession({ session, drivers, dataDir: dir, signal: ctl.signal });
    runs.push(p);
    return p;
  };
  const get = async (dir: string, id: string, waitSec?: number) => (await councilStatus.run(ctxOf(dir), { sessionId: id, ...(waitSec ? { waitSec } : {}) })) as any;

  it("during the phase: drafting, accepted grows, solution null, agreed empty, the wait wakes on a draft", async () => {
    const dir = tmp();
    void run(dir, "d1", scn(3, 800));
    await until(() => (readSession(dir, "d1")?.state.drafts.filter((d) => d.done).length ?? 0) === 1);
    const r = await get(dir, "d1");
    expect(r.statusText).toBe("идут независимые черновики: принято 1 из 3");
    expect(r.drafts).toMatchObject({ phase: "drafting", synthesizerId: "p1", accepted: 1, total: 3 });
    expect(r.drafts.items.map((i: any) => i.text)).toEqual(["ЧЕРНОВИК-1"]);
    expect(r.solution).toBeNull();
    expect(r.agreed).toEqual([]);
    const w = await get(dir, "d1", 10);
    expect(w.wait.changed).toBe(true);
    expect(w.drafts.accepted).toBeGreaterThanOrEqual(2);
  });

  it("after the phase: finished, texts of all drafts; stats counts the drafts", async () => {
    const dir = tmp();
    await run(dir, "d2", scn(3));
    const r = await get(dir, "d2");
    expect(r.drafts).toMatchObject({ phase: "finished", accepted: 3, total: 3 });
    expect(r.drafts.items.map((i: any) => i.text)).toEqual(["ЧЕРНОВИК-1", "ЧЕРНОВИК-2", "ЧЕРНОВИК-3"]);
    expect(r.solution.text).toBe("Итог");
    expect(r.stats).toMatchObject({ drafts: 3, inputTokens: 10 + 20 + 30 + 300, outputTokens: 5 + 7 + 9 + 150 });
  });

  it("corrupted snapshot: text null and error, the call does not fail", async () => {
    const dir = tmp();
    await run(dir, "d3", scn(3));
    writeFileSync(draftPath(dir, "d3", "d2"), "испорчено");
    const r = await get(dir, "d3");
    const bad = r.drafts.items.find((i: any) => i.draftId === "d2");
    expect(bad.text).toBeNull();
    expect(bad.error).toBeTruthy();
    expect(r.drafts.items.find((i: any) => i.draftId === "d1").text).toBe("ЧЕРНОВИК-1");
  });

  it("reason synthesizer_unavailable gets reasonText", async () => {
    const dir = tmp();
    await run(dir, "d4", [{ steps: [dstep("amend", "Ч1")] }, { steps: [{ error: "fatal", retryable: false }] }, { steps: [dstep("amend", "Ч3")] }], "p2");
    const r = await get(dir, "d4");
    expect(r).toMatchObject({ status: "failed", reason: "synthesizer_unavailable" });
    expect(r.reasonText).toBe("синтезатор p2 выбыл, не создав версию 1; замены нет — нужна новая сессия с другим синтезатором");
  });

  it("language: the synthesizer's reasonText on en — fully English with the identifier, on ru — the previous string", async () => {
    const dir = tmp();
    await run(dir, "d4en", [{ steps: [dstep("amend", "Ч1")] }, { steps: [{ error: "fatal", retryable: false }] }, { steps: [dstep("amend", "Ч3")] }], "p2");
    setProcessLanguage("en");
    try {
      const r = await get(dir, "d4en");
      expect(r.reasonText).toContain("p2");
      expect(r.reasonText).not.toMatch(/[А-Яа-яЁё]/);
      expect(r.reasonText).toMatch(/^synthesizer p2 dropped out/);
    } finally { setProcessLanguage("ru"); }
    expect((await get(dir, "d4en")).reasonText).toBe("синтезатор p2 выбыл, не создав версию 1; замены нет — нужна новая сессия с другим синтезатором");
  });

  it("session without drafts: drafts null", async () => {
    const dir = tmp();
    await start(dir, "d5", "consensus");
    const r = await get(dir, "d5");
    expect(r.drafts).toBeNull();
    expect(r.stats.drafts).toBe(0);
  });
});

describe("council_status: participant replacements", () => {
  const fatal = { error: "fatal", retryable: false } as Scenario["steps"][number];
  async function failed(dir: string, id: string) {
    await start(dir, id, [{ steps: [step("amend", "v1")] }, { steps: [fatal] }], 1);
    return (await councilStatus.run(ctxOf(dir), { sessionId: id })) as any;
  }

  it("failure 'fewer than two active': reasonCode and reasonText pointing to a replacement", async () => {
    const dir = tmp();
    const r = await failed(dir, "r1");
    expect(r).toMatchObject({ status: "failed", reasonCode: "insufficient_active_participants" });
    expect(r.reasonText).toContain("меньше двух активных");
    expect(r.reasonText).toContain("replacements");
    expect(r.participants.every((p: any) => !("replaces" in p) && !("replacedBy" in p))).toBe(true);
  });

  it("for a session without a result and with another result reasonCode is not added or null", async () => {
    const dir = tmp();
    await start(dir, "c1", "consensus");
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "c1" })) as any;
    expect(r.reasonCode).toBeNull();
    expect("reasonText" in r).toBe(false);
  });

  it("after a replacement: replacedBy on the old one, replaces on the new one", async () => {
    const dir = tmp(), scn = tmp();
    await failed(dir, "r2");
    writeFileSync(join(scn, "n.json"), JSON.stringify({ steps: [step("agree", null)] }));
    writeFileSync(join(scn, "m"), JSON.stringify({ steps: [step("amend", "v1"), step("agree", null)] })); // previous p1: the session's model is "m"
    await ensureRegistry(dir, { env, deps: { locate: async (agent: "claude" | "codex") => ({ agent, found: false, searchPath: "", reason: "нет" }) } });
    const plan = planResume(dir, "r2", { rounds: 1, replacements: [{ participantId: "p2", providerId: "scripted", model: "n.json" }] });
    const { drivers } = await resumeDrivers(plan, { registry: readRegistry(dir), env, dataDir: dir, scenarioPath: (m: string) => join(scn, m) });
    const ctl = new AbortController();
    aborts.push(ctl);
    await runResumedSession({ dataDir: dir, plan, drivers, signal: ctl.signal });
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "r2" })) as any;
    expect(r.participants.find((p: any) => p.id === "p2")).toMatchObject({ state: "dropped", replacedBy: "p3" });
    expect(r.participants.find((p: any) => p.id === "p3")).toMatchObject({ state: "active", replaces: "p2" });
    expect("replaces" in r.participants[0]).toBe(false);
  });
});

describe("council_status: journal of a newer version", () => {
  const future = (dir: string, id: string, seq: number) => appendFileSync(eventsPath(dir, id), JSON.stringify({ seq, ts: "2026-01-01T00:00:00.000Z", type: "future_event" }) + "\n");
  // a journal truncated after the first turn and belonging to a dead executor: no result
  const unfinished = async (dir: string, id: string) => {
    await start(dir, id, "consensus");
    const all = readFileSync(eventsPath(dir, id), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const keep = all.slice(0, all.findIndex((e) => e.type === "turn_completed") + 1);
    keep[0].pid = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(eventsPath(dir, id), keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return keep.length;
  };

  it("journal equals newer_version and lastEvent, statusText about the newer version (without a result)", async () => {
    const dir = tmp();
    const n = await unfinished(dir, "nv1");
    future(dir, "nv1", n + 1);
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "nv1" })) as any;
    expect(r.journal).toEqual({ reason: "newer_version", lastEvent: n });
    const note = partialNote(r.journal);
    expect(r.statusText).toBe(`состояние не определено: ${note}; обновите приложение, чтобы прочитать сессию целиком`);
    expect(r.statusText).not.toMatch(/прервана|идёт/);
    expect(r.status).toBe("interrupted");
    expect(r.solution).not.toBeNull();
  });

  it("journal newer_version with a result: the previous result text, the decision and a note", async () => {
    const dir = tmp();
    await start(dir, "nv2", "consensus");
    const n = readFileSync(eventsPath(dir, "nv2"), "utf8").trim().split("\n").length;
    future(dir, "nv2", n + 1);
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "nv2" })) as any;
    expect(r.journal).toEqual({ reason: "newer_version", lastEvent: n });
    expect(r.status).toBe("consensus");
    expect(r.statusText).toBe(`согласие достигнуто · ${partialNote(r.journal)}`);
    expect(r.solution.text).toBe("Назвать кота Мурзик Великий.");
  });

  it("journal intact — journal equals null, the rest as before", async () => {
    const dir = tmp();
    await start(dir, "nv3", "consensus");
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "nv3" })) as any;
    expect(r.journal).toBeNull();
    expect(r).toMatchObject({ status: "consensus", statusText: "согласие достигнуто" });
  });

  it("corrupted — journal.reason corrupted, statusText with a corruption note", async () => {
    const dir = tmp();
    await start(dir, "nv4", "consensus");
    const n = readFileSync(eventsPath(dir, "nv4"), "utf8").trim().split("\n").length;
    appendFileSync(eventsPath(dir, "nv4"), '{"seq":99,"ts":"x","ty');
    const r = (await councilStatus.run(ctxOf(dir), { sessionId: "nv4" })) as any;
    expect(r.journal).toEqual({ reason: "corrupted", lastEvent: n });
    expect(r.statusText).toBe(`согласие достигнуто · журнал повреждён, прочитан до события №${n}`);
  });

  it("council_stop for a newer_version session is accepted as before", async () => {
    const dir = tmp();
    const n = await unfinished(dir, "nv5");
    future(dir, "nv5", n + 1);
    const before = readFileSync(eventsPath(dir, "nv5"));
    const r = (await councilStop.run(ctxOf(dir), { sessionId: "nv5" })) as any;
    expect(r.message).toBe(`Остановка не выполнена: ${r.statusText}.`);
    expect(r.message).not.toMatch(/прервана|идёт/);
    expect(r.journal).toEqual({ reason: "newer_version", lastEvent: n });
    expect(readFileSync(eventsPath(dir, "nv5")).equals(before)).toBe(true);
  });
});
