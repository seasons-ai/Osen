import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSession } from "../engine.ts";
import type { SessionRun } from "../engine.ts";
import type { CollectedMaterial } from "../materials.ts";
import { ParticipantCallError } from "../participants/driver.ts";
import type { ParticipantDriver, TurnRequest } from "../participants/driver.ts";
import { createScriptedDriver } from "../participants/scripted.ts";
import type { Scenario } from "../participants/scripted.ts";
import type { Limits, Session, SessionEvent } from "../protocol/schema.ts";
import { sessionTotals, tokenUsage } from "../protocol/state.ts";
import { foldEvents } from "../protocol/fold.ts";
import type { ResumePoint, SessionState } from "../protocol/state.ts";
import type { Registry } from "../registry/config.ts";
import { eventsPath, materialPath, readEvents, resumeLockPath, stopRequestPath } from "./journal.ts";
import { OwnerReleaseRejectedError, ownerMessagesDir, requestOwnerMessage, requestOwnerRelease } from "./owner-messages.ts";
import { planResume, ResumeRejectedError, resumeDrivers, runResumedSession, scriptedStartStep } from "./resume.ts";
import type { ResumePlan, ResumeRejection } from "./resume.ts";
import { runStoredSession } from "./run.ts";
import { StopRejectedError, listSessions, readSession, requestStop } from "./sessions.ts";

type Step = Scenario["steps"][number];
const resp = (stance: string, solution: string | null): Step => ({
  response: { stance, reasoning: "r", solution, answers: [], questions: [] },
});
const amend = (t: string) => resp("amend", t);
const agree = () => resp("agree", null);
const object = () => resp("object", null);
const fatal: Step = { error: "fatal", retryable: false };

const env = { COUNCIL_DEV: "1" };
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "resume-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const scripted = (...steps: Step[]) => createScriptedDriver({ steps }, env);
const dead = () => false;
const alive = () => true;
const registry = (providers: unknown[] = []) => ({ providers, defaults: {} }) as unknown as Registry;
const web = { id: "web", kind: "openai-http", label: "W", models: [], baseUrl: "http://127.0.0.1:1", apiKeyEnv: "WEB_KEY" };
const never = (): Promise<never> => new Promise(() => {});

interface MkOpts { n?: number; maxRounds?: number; providers?: string[]; models?: string[]; materials?: CollectedMaterial[]; ownerWait?: Session["ownerWait"] }
const mk = (id: string, o: MkOpts = {}): Session =>
  createSession(
    {
      topic: "Тема", framing: "", origin: "cli",
      limits: { maxRounds: o.maxRounds ?? 3, turnTimeoutSec: 30, contextChars: 20000, ...(o.materials ? { materialsChars: 10000 } : {}) } as Limits,
      participants: Array.from({ length: o.n ?? 2 }, (_, i) => ({
        name: `N${i + 1}`, providerId: o.providers?.[i] ?? "scripted", model: o.models?.[i] ?? "m", role: null,
      })),
      ...(o.materials ? { materials: o.materials } : {}),
      ...(o.ownerWait ? { ownerWait: o.ownerWait } : {}),
    },
    { maxParticipants: 8, id },
  );
const material = (id: string, name: string, text: string): CollectedMaterial => ({
  id, name, chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex"), text,
});

const prior = (dir: string, session: Session, ds: ParticipantDriver[], extra: Partial<Parameters<typeof runStoredSession>[0]> = {}) =>
  runStoredSession({ session, drivers: Object.fromEntries(ds.map((d, i) => [`p${i + 1}`, d])), dataDir: dir, ...extra });
const journal = (dir: string, id: string) => readFileSync(eventsPath(dir, id), "utf8");
const types = (events: readonly SessionEvent[]) => events.map((e) => e.type);
const cutAfter = (dir: string, id: string, pred: (e: SessionEvent) => boolean, nth = 1) => {
  const evs = readEvents(dir, id)!.events;
  let k = 0;
  const idx = evs.findIndex((e) => pred(e) && ++k === nth);
  // pid 1 is "another live process" (EPERM): an executor with the pid of the reading process and no registry entry counts as crashed.
  const foreign = (e: SessionEvent) => ("pid" in e ? ({ ...e, pid: 1 } as SessionEvent) : e);
  writeFileSync(eventsPath(dir, id), evs.slice(0, idx + 1).map((e) => JSON.stringify(foreign(e))).join("\n") + "\n");
};
const scenarioFile = (dir: string, name: string, steps: Step[]) => {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
};
const reasonOf = (fn: () => unknown): ResumeRejection | undefined => {
  try { fn(); } catch (e) { if (e instanceof ResumeRejectedError) return e.reason; throw e; }
  return undefined;
};
const rejects = async <T>(p: Promise<T>): Promise<ResumeRejectedError> => {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ResumeRejectedError); return e as ResumeRejectedError; }
  throw new Error("ожидался отказ");
};
const msg = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  return "";
};

const stripReasonCode = (dir: string, id: string) => {
  const evs = readEvents(dir, id)!.events.map((e) => {
    if (e.type !== "session_finished") return e;
    const { reasonCode: _drop, ...rest } = e;
    return rest as SessionEvent;
  });
  writeFileSync(eventsPath(dir, id), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

// Session id with two scripted participants: round 1 → no_consensus (p1 amend, p2 object); then both agree.
async function noConsensus(dir: string, id = "s", extra: MkOpts = {}) {
  const f1 = scenarioFile(dir, `${id}-p1`, [amend("v1"), agree()]);
  const f2 = scenarioFile(dir, `${id}-p2`, [object(), agree()]);
  const session = mk(id, { maxRounds: 1, models: [f1, f2], ...extra });
  await prior(dir, session, [scripted(amend("v1")), scripted(object())]);
  return session;
}
const go = async (dir: string, plan: ResumePlan, extra: Partial<Parameters<typeof runResumedSession>[0]> = {}) => {
  const { drivers } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
  return runResumedSession({ dataDir: dir, plan, drivers, isAlive: dead, ...extra });
};

describe("planResume: statuses", () => {
  it("no_consensus accepted, plan figures", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 2, isAlive: dead });
    expect(plan).toMatchObject({ id: "s", status: "no_consensus", addedRounds: 2, maxRounds: 3, maxCalls: 12 });
    expect(plan.point).toMatchObject({ turn: 3, round: 2, index: 0, redo: false, completedRounds: 1 });
    expect(plan.active.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(plan.materials).toEqual([]);
    expect(plan.journalBytes).toBe(Buffer.byteLength(journal(dir, "s")));
    expect(plan.events).toEqual(readEvents(dir, "s")!.events);
  });

  it("stopped accepted, unfinished turn repeated", async () => {
    const dir = tmp();
    const ac = new AbortController();
    const stopper: ParticipantDriver = { call: () => (ac.abort(), never()) };
    await prior(dir, mk("s"), [scripted(amend("v1"), amend("v2")), stopper], { signal: ac.signal });
    const plan = planResume(dir, "s", { isAlive: dead });
    expect(plan.status).toBe("stopped");
    expect(plan.point).toMatchObject({ turn: 2, round: 1, index: 1, redo: true, completedRounds: 0 });
    expect(plan.addedRounds).toBe(3);
  });

  it("interrupted accepted", async () => {
    const dir = tmp();
    await prior(dir, mk("s"), [scripted(amend("v1"), agree()), scripted(agree(), agree())]);
    cutAfter(dir, "s", (e) => e.type === "turn_completed");
    expect(planResume(dir, "s", { isAlive: dead }).status).toBe("interrupted");
  });

  it("consensus, failed and unknown session refused, journal unchanged", async () => {
    const dir = tmp();
    await prior(dir, mk("c"), [scripted(amend("v1")), scripted(agree())]);
    await prior(dir, mk("f"), [scripted(amend("v1")), scripted(fatal)]);
    stripReasonCode(dir, "f"); // failure without reasonCode: old journal or another reason, cannot be fixed by replacement
    const before = [journal(dir, "c"), journal(dir, "f")];
    expect(reasonOf(() => planResume(dir, "c", { isAlive: dead }))).toBe("consensus");
    expect(reasonOf(() => planResume(dir, "f", { isAlive: dead }))).toBe("failed");
    expect(reasonOf(() => planResume(dir, "nope", { isAlive: dead }))).toBe("not_found");
    expect(reasonOf(() => planResume(dir, "../x", { isAlive: dead }))).toBe("not_found");
    expect([journal(dir, "c"), journal(dir, "f")]).toEqual(before);
    expect(msg(() => planResume(dir, "c", { isAlive: dead }))).toContain("согласие достигнуто");
  });

  it("no result and executor running: running; result written — live process does not interfere", async () => {
    const dir = tmp();
    await prior(dir, mk("s"), [scripted(amend("v1"), agree()), scripted(agree(), agree())]);
    cutAfter(dir, "s", (e) => e.type === "turn_completed");
    const before = journal(dir, "s");
    expect(reasonOf(() => planResume(dir, "s", { isAlive: alive }))).toBe("running");
    expect(msg(() => planResume(dir, "s", { isAlive: alive }))).toContain("исполнитель ещё работает");
    expect(journal(dir, "s")).toBe(before);
    const d2 = tmp();
    await noConsensus(d2);
    expect(planResume(d2, "s", { rounds: 1, isAlive: alive }).status).toBe("no_consensus");
  });

  it("fewer than two active", async () => {
    const dir = tmp();
    await prior(dir, mk("s", { n: 3 }), [scripted(amend("v1")), scripted(fatal), scripted(fatal)]);
    cutAfter(dir, "s", (e) => e.type === "participant_dropped", 2);
    expect(reasonOf(() => planResume(dir, "s", { isAlive: dead }))).toBe("too_few_active");
  });
});

describe("planResume: rounds", () => {
  it("N set, remainder without N, no remainder, invalid values", async () => {
    const dir = tmp();
    await noConsensus(dir);
    expect(planResume(dir, "s", { rounds: 4, isAlive: dead })).toMatchObject({ addedRounds: 4, maxRounds: 5 });
    expect(reasonOf(() => planResume(dir, "s", { isAlive: dead }))).toBe("no_rounds_left");
    expect(msg(() => planResume(dir, "s", { isAlive: dead }))).toContain("--rounds");
    for (const rounds of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(reasonOf(() => planResume(dir, "s", { rounds, isAlive: dead }))).toBe("bad_rounds");
    }
    const d2 = tmp();
    await prior(d2, mk("r"), [scripted(amend("v1"), agree()), scripted(agree(), agree())]);
    cutAfter(d2, "r", (e) => e.type === "turn_completed");
    expect(planResume(d2, "r", { isAlive: dead })).toMatchObject({ addedRounds: 3, maxRounds: 3 });
  });
});

describe("planResume: journal integrity", () => {
  it("journal grows during check: running, not corrupted", async () => {
    const dir = tmp();
    await prior(dir, mk("s"), [scripted(amend("v1"), agree()), scripted(agree(), agree())]);
    cutAfter(dir, "s", (e) => e.type === "turn_completed");
    const last = readEvents(dir, "s")!.events.at(-1)!;
    const growing = () => {
      appendFileSync(eventsPath(dir, "s"), JSON.stringify({ ...last, seq: last.seq + 1 }) + "\n");
      return true;
    };
    expect(reasonOf(() => planResume(dir, "s", { isAlive: growing }))).toBe("running");
  });

  it("live executor writing a line: tail without a newline gives running; the same tail with a dead executor gives corrupted, bytes the same", async () => {
    const dir = tmp();
    await prior(dir, mk("s"), [scripted(amend("v1"), agree()), scripted(agree(), agree())]);
    cutAfter(dir, "s", (e) => e.type === "turn_completed");
    appendFileSync(eventsPath(dir, "s"), '{"seq":99,"ts":"2026-01-01T00:00:00.000Z","type":"turn_st');
    const before = journal(dir, "s");
    expect(reasonOf(() => planResume(dir, "s", { isAlive: alive }))).toBe("running");
    expect(reasonOf(() => planResume(dir, "s", { rounds: 1, isAlive: dead }))).toBe("corrupted");
    expect(journal(dir, "s")).toBe(before);
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
  });

  it("truncated and invalid entry: corrupted, prefix readable, bytes the same", async () => {
    for (const tail of ['{"seq":99,"ts":"x","ty', '{"bad":1}\n']) {
      const dir = tmp();
      await noConsensus(dir);
      appendFileSync(eventsPath(dir, "s"), tail);
      const before = journal(dir, "s");
      expect(reasonOf(() => planResume(dir, "s", { rounds: 1, isAlive: dead }))).toBe("corrupted");
      expect(msg(() => planResume(dir, "s", { rounds: 1, isAlive: dead }))).toContain("после события №");
      expect(readSession(dir, "s", dead)?.status).toBe("no_consensus");
      expect(journal(dir, "s")).toBe(before);
    }
  });
});

describe("planResume: newer-version journal", () => {
  const future = (dir: string, seq: number) => appendFileSync(eventsPath(dir, "s"), JSON.stringify({ seq, ts: "2026-01-01T00:00:00.000Z", type: "future_event" }) + "\n");
  const sha = (dir: string) => createHash("sha256").update(readFileSync(eventsPath(dir, "s"))).digest("hex");

  it("newer_version: code, text about a newer version and event No. N, journal and lock untouched", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const n = readEvents(dir, "s")!.events.length;
    future(dir, n + 1);
    appendFileSync(eventsPath(dir, "s"), JSON.stringify({ ...readEvents(dir, "s")!.events.at(-1)!, seq: n + 2 }) + "\n");
    const before = sha(dir);
    expect(reasonOf(() => planResume(dir, "s", { rounds: 1, isAlive: dead }))).toBe("newer_version");
    const m = msg(() => planResume(dir, "s", { rounds: 1, isAlive: dead }));
    expect(m).toBe(`Сессия s: журнал записан более новой версией, прочитан до события №${n}; продолжение невозможно. Обновите приложение.`);
    expect(m).not.toContain("журнал сессии повреждён");
    expect(sha(dir)).toBe(before);
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
  });

  it("control: incomplete line — previous corrupted and previous text", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const n = readEvents(dir, "s")!.events.length;
    appendFileSync(eventsPath(dir, "s"), '{"seq":');
    expect(reasonOf(() => planResume(dir, "s", { rounds: 1, isAlive: dead }))).toBe("corrupted");
    expect(msg(() => planResume(dir, "s", { rounds: 1, isAlive: dead })))
      .toBe(`Сессия s: журнал сессии повреждён: после события №${n} идёт неполная или невалидная запись; продолжение невозможно.`);
  });
});

describe("planResume: materials", () => {
  const mats = [material("m1", "a.txt", "Текст А"), material("m2", "b.txt", "Текст Б")];
  const withMaterials = async (dir: string) => {
    const session = mk("s", { maxRounds: 1, materials: mats });
    await prior(dir, session, [scripted(amend("v1")), scripted(object())], { materials: mats });
  };

  it("snapshots in place: texts in the plan and in the request of the first new turn", async () => {
    const dir = tmp();
    await withMaterials(dir);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    expect(plan.materials).toEqual(mats);
    const prompts: string[] = [];
    const spy: ParticipantDriver = { call: (r: TurnRequest) => { prompts.push(r.prompt); return scripted(agree()).call(r); } };
    await runResumedSession({ dataDir: dir, plan, drivers: { p1: spy, p2: scripted(agree()) }, isAlive: dead });
    expect(prompts[0]).toContain("a.txt");
    expect(prompts[0]).toContain("Текст А");
    expect(prompts[0]).toContain("Текст Б");
    expect(prompts[0]!.indexOf("a.txt")).toBeLessThan(prompts[0]!.indexOf("b.txt"));
  });

  it("snapshot deleted and snapshot changed", async () => {
    const dir = tmp();
    await withMaterials(dir);
    const before = journal(dir, "s");
    rmSync(materialPath(dir, "s", "m2"));
    expect(reasonOf(() => planResume(dir, "s", { rounds: 1, isAlive: dead }))).toBe("material");
    const m = msg(() => planResume(dir, "s", { rounds: 1, isAlive: dead }));
    expect(m).toContain("b.txt");
    expect(m).toContain("снимок отсутствует");
    writeFileSync(materialPath(dir, "s", "m2"), "Другой текст");
    expect(msg(() => planResume(dir, "s", { rounds: 1, isAlive: dead }))).toContain("хеш снимка не совпал");
    expect(readFileSync(materialPath(dir, "s", "m2"), "utf8")).toBe("Другой текст");
    expect(journal(dir, "s")).toBe(before);
  });

  it("session without materials does not require a snapshot folder", async () => {
    const dir = tmp();
    await noConsensus(dir);
    expect(existsSync(join(dir, "sessions", "s", "materials"))).toBe(false);
    expect(planResume(dir, "s", { rounds: 1, isAlive: dead }).materials).toEqual([]);
  });
});

describe("resumeDrivers: scenarioPath", () => {
  it("participant model is translated to a path to the scenario file", async () => {
    const dir = tmp();
    const session = await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    const [m1, m2] = session.participants.map((p) => p.model as string);
    const asked: string[] = [];
    const plan2 = { ...plan, session: { ...plan.session, participants: plan.session.participants.map((p, i) => ({ ...p, model: `alias${i}` })) } };
    const { drivers } = await resumeDrivers(plan2, {
      registry: registry(), env, dataDir: dir,
      scenarioPath: (m) => { asked.push(m); return m === "alias0" ? m1! : m2!; },
    });
    expect(asked).toEqual(["alias0", "alias1"]);
    expect(Object.keys(drivers)).toEqual(["p1", "p2"]);
  });

  it("null — refusal with participant name", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    const err = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir, scenarioPath: () => null }).catch((e) => e);
    expect(err).toBeInstanceOf(ResumeRejectedError);
    expect(err).toMatchObject({ reason: "participant" });
    expect(err.message).toContain("«N1»");
    expect(err.message).toContain("сценарий «");
    expect(err.message).toContain("недоступен");
  });
});

describe("scriptedStartStep", () => {
  const st = (turns: [number, string, number][], failures: [number, string][], drafts: { draftId: string; started: number }[] = []) => ({
    turns: turns.map(([turn, participantId, attempts]) => ({ turn, participantId, attempts })),
    failures: failures.map(([turn, participantId]) => ({ turn, participantId })),
    session: { participants: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] }, drafts,
  }) as unknown as SessionState;
  const point = (turn: number, redo: boolean) => ({ turn, round: 1, index: 0, redo, completedRounds: 0 }) as ResumePoint;

  it("completed turns with repeats", () => {
    expect(scriptedStartStep(st([[1, "p1", 2], [3, "p1", 1], [2, "p2", 5]], []), "p1", point(4, false))).toBe(3);
  });
  it("repeatable turn replayed from the start, other failures of unfinished turns counted", () => {
    const s = st([[1, "p1", 1]], [[2, "p1"], [2, "p1"], [5, "p1"], [5, "p2"]]);
    expect(scriptedStartStep(s, "p1", point(2, true))).toBe(2);
    expect(scriptedStartStep(s, "p1", point(9, false))).toBe(4);
    expect(scriptedStartStep(s, "p2", point(9, false))).toBe(1);
  });
  it("dropped-out participant: its failed attempts counted, others have their own", () => {
    const s = st([[1, "p1", 1]], [[2, "p2"], [2, "p2"]]);
    expect(scriptedStartStep(s, "p2", point(3, false))).toBe(2);
    expect(scriptedStartStep(s, "p3", point(3, false))).toBe(0);
  });
  it("draft attempts are added to turns", () => {
    const drafts = [{ draftId: "d1", started: 2 }, { draftId: "d2", started: 1 }];
    expect(scriptedStartStep(st([], [], drafts), "p1", point(1, false))).toBe(2);
    expect(scriptedStartStep(st([[1, "p2", 1]], [], drafts), "p2", point(2, false))).toBe(2);
    expect(scriptedStartStep(st([[1, "p3", 1]], [], drafts), "p3", point(2, false))).toBe(1);
  });
});

describe("resumeDrivers", () => {
  it("active participant's provider removed from registry", async () => {
    const dir = tmp();
    await prior(dir, mk("s", { maxRounds: 1, providers: ["web", "gone"] }), [scripted(amend("v1")), scripted(object())]);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    const e = await rejects(resumeDrivers(plan, { registry: registry([web]), env: { WEB_KEY: "k" }, dataDir: dir }));
    expect(e.reason).toBe("participant");
    expect(e.message).toContain("p2");
    expect(e.message).toContain("gone");
  });

  it("HTTP provider without key: variable named, no values", async () => {
    const dir = tmp();
    await prior(dir, mk("s", { maxRounds: 1, providers: ["web", "web"] }), [scripted(amend("v1")), scripted(object())]);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    const e = await rejects(resumeDrivers(plan, { registry: registry([web]), env: { OTHER: "canary-123" }, dataDir: dir }));
    expect(e.reason).toBe("participant");
    expect(e.message).toContain("WEB_KEY");
    expect(e.message).not.toContain("canary-123");
  });

  it("saved model not substituted; dropped-out participant's provider not checked", async () => {
    const dir = tmp();
    await prior(dir, mk("s", { n: 3, maxRounds: 1, providers: ["web", "gone", "web"], models: ["saved-1", "saved-2", "saved-3"] }),
      [scripted(amend("v1")), scripted(fatal), scripted(object())]);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    expect(plan.active.map((p) => [p.id, p.model])).toEqual([["p1", "saved-1"], ["p3", "saved-3"]]);
    const reg = registry([{ ...web, models: ["other-default"] }]);
    const { drivers, warnings } = await resumeDrivers(plan, { registry: reg, env: { WEB_KEY: "k" }, dataDir: dir });
    expect(Object.keys(drivers)).toEqual(["p1", "p2", "p3"]);
    expect(warnings).toEqual([]);
    const err = await drivers.p2!.call({} as TurnRequest).catch((e) => e);
    expect(err).toBeInstanceOf(ParticipantCallError);
    expect(err.retryable).toBe(false);
  });

  it("scripted participant: without COUNCIL_DEV and with unreadable file — refusal with name", async () => {
    const dir = tmp();
    const f1 = scenarioFile(dir, "p1", [agree()]);
    await prior(dir, mk("s", { maxRounds: 1, models: [f1, join(dir, "нет.json")] }), [scripted(amend("v1")), scripted(object())]);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    let e = await rejects(resumeDrivers(plan, { registry: registry(), env: {}, dataDir: dir }));
    expect(e.message).toContain("N1");
    e = await rejects(resumeDrivers(plan, { registry: registry(), env, dataDir: dir }));
    expect(e.message).toContain("N2");
  });

  it("scripted participant continues from its step", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    const run = await go(dir, plan);
    expect(run.state.finish?.status).toBe("consensus");
    expect(run.events.filter((e) => e.type === "turn_completed")).toHaveLength(2);
  });
});

describe("runResumedSession", () => {
  it("appends session_resumed, prefix unchanged, result new", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const before = journal(dir, "s");
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    const run = await go(dir, plan);
    const after = journal(dir, "s");
    expect(after.startsWith(before)).toBe(true);
    const all = readEvents(dir, "s")!.events;
    expect(types(all).filter((t) => t === "session_created")).toHaveLength(1);
    expect(types(all).filter((t) => t === "session_resumed")).toHaveLength(1);
    expect(run.events[0]).toMatchObject({ type: "session_resumed", seq: plan.events.length + 1, maxRounds: 2 });
    expect(readSession(dir, "s", dead)?.status).toBe("consensus");
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
  });

  it("killed new executor: interrupted, repeat continuation accepted", async () => {
    const dir = tmp();
    await noConsensus(dir);
    await go(dir, planResume(dir, "s", { rounds: 1, isAlive: dead }));
    cutAfter(dir, "s", (e) => e.type === "session_resumed");
    expect(readSession(dir, "s", dead)?.status).toBe("interrupted");
    expect(readSession(dir, "s", alive)?.status).toBe("running");
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    expect(plan.status).toBe("interrupted");
    expect(plan.point.turn).toBe(3);
  });

  it("two starts at once: second gets busy, session_resumed one; stale lock does not interfere", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });
    const slow: ParticipantDriver = { call: async (r) => { started(); await gate; return scripted(agree()).call(r); } };
    const first = runResumedSession({ dataDir: dir, plan, drivers: { p1: slow, p2: scripted(agree()) } });
    await hasStarted;
    const e = await rejects(runResumedSession({ dataDir: dir, plan, drivers: { p1: scripted(agree()), p2: scripted(agree()) } }));
    expect(e.reason).toBe("busy");
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(true);
    release();
    await first;
    expect(types(readEvents(dir, "s")!.events).filter((t) => t === "session_resumed")).toHaveLength(1);

    const d2 = tmp();
    await noConsensus(d2);
    writeFileSync(resumeLockPath(d2, "s"), "999999");
    expect((await go(d2, planResume(d2, "s", { rounds: 1, isAlive: dead }))).state.finish?.status).toBe("consensus");
    const d3 = tmp();
    await noConsensus(d3);
    writeFileSync(resumeLockPath(d3, "s"), "мусор");
    expect((await go(d3, planResume(d3, "s", { rounds: 1, isAlive: dead }))).state.finish?.status).toBe("consensus");
  });

  it("journal changed after plan: stale_plan, no events, lock removed", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    appendFileSync(eventsPath(dir, "s"), "\n");
    const before = journal(dir, "s");
    writeFileSync(stopRequestPath(dir, "s"), "");
    const e = await rejects(go(dir, plan));
    expect(e.reason).toBe("stale_plan");
    expect(e.message).toBe("Сессия s: журнал изменился после проверки: повторите команду.");
    expect(journal(dir, "s")).toBe(before);
    expect(existsSync(stopRequestPath(dir, "s"))).toBe(true);
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
  });

  it("previous stop request deleted on acceptance; new one stops the segment", async () => {
    const dir = tmp();
    await noConsensus(dir);
    writeFileSync(stopRequestPath(dir, "s"), "");
    const run = await go(dir, planResume(dir, "s", { rounds: 1, isAlive: dead }));
    expect(run.state.finish?.status).toBe("consensus");
    expect(existsSync(stopRequestPath(dir, "s"))).toBe(false);

    const d2 = tmp();
    await noConsensus(d2);
    const plan = planResume(d2, "s", { rounds: 1, isAlive: dead });
    const requester: ParticipantDriver = { call: () => (writeFileSync(stopRequestPath(d2, "s"), ""), never()) };
    const t0 = Date.now();
    const r2 = await runResumedSession({ dataDir: d2, plan, drivers: { p1: requester, p2: scripted(agree()) }, isAlive: dead, stopPollMs: 20 });
    expect(r2.state.finish?.status).toBe("stopped");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("owner message requests: unapplied removed and returned, applied removed silently, refusal does not touch", async () => {
    const dir = tmp();
    // first segment: the message is applied after p1's turn
    const f1 = scenarioFile(dir, "a", [amend("v1"), agree()]);
    const f2 = scenarioFile(dir, "b", [object(), agree()]);
    const session = mk("s", { maxRounds: 1, models: [f1, f2] });
    let applied = "";
    const asker: ParticipantDriver = {
      call: (r) => {
        applied = requestOwnerMessage(dir, "s", "старая реплика", { isAlive: alive }).requestId;
        return scripted(amend("v1")).call(r);
      },
    };
    await prior(dir, session, [asker, scripted(object())]);
    expect(readSession(dir, "s", dead)!.state.ownerMessages.map((m) => m.requestId)).toEqual([applied]);

    const q = ownerMessagesDir(dir, "s");
    const put = (d: string, id: string, text: string) => { mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${id}.json`), JSON.stringify({ text })); };
    put(q, applied, "старая реплика");
    put(q, "000000000000001-a", "потерянная");
    put(`${q}.closed-1`, "000000000000000-b", "ещё потерянная");
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });

    // refusal does not touch the requests
    appendFileSync(eventsPath(dir, "s"), "\n");
    await rejects(go(dir, plan));
    expect(existsSync(join(q, `${applied}.json`))).toBe(true);
    expect(existsSync(join(`${q}.closed-1`, "000000000000000-b.json"))).toBe(true);
    // restore the journal to its previous form
    writeFileSync(eventsPath(dir, "s"), journal(dir, "s").slice(0, -1));

    const got: string[][] = [];
    const run = await go(dir, plan, { onAccepted: (i) => got.push(i.droppedOwnerRequests.map((r) => r.text)) });
    expect(got).toEqual([["ещё потерянная", "потерянная"]]);
    expect(existsSync(`${q}.closed-1`)).toBe(false);
    expect(existsSync(join(q, "000000000000001-a.json"))).toBe(false);
    expect(existsSync(join(q, `${applied}.json`))).toBe(false);
    const texts = readEvents(dir, "s")!.events.flatMap((e) => (e.type === "owner_message" ? [e.text] : []));
    expect(texts).toEqual(["старая реплика"]);
    expect(run.state.finish?.status).toBe("consensus");
  });

  it("new owner message during the new segment is applied", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    const asker: ParticipantDriver = {
      call: (r) => { requestOwnerMessage(dir, "s", "новая реплика"); return scripted(agree()).call(r); },
    };
    const run = await runResumedSession({ dataDir: dir, plan, drivers: { p1: asker, p2: scripted(agree()) }, isAlive: dead });
    expect(run.events.filter((e) => e.type === "owner_message").map((e) => (e as { text: string }).text)).toEqual(["новая реплика"]);
  });

  it("figures: turns and durations of two segments without double counting", async () => {
    const dir = tmp();
    const ac = new AbortController();
    const f1 = scenarioFile(dir, "a", [amend("v1"), agree()]);
    const f2 = scenarioFile(dir, "b", [agree()]);
    const stopper: ParticipantDriver = { call: () => (ac.abort(), never()) };
    await prior(dir, mk("s", { models: [f1, f2] }), [scripted(amend("v1")), stopper], { signal: ac.signal });
    const run: SessionRun = await go(dir, planResume(dir, "s", { isAlive: dead }));
    expect(run.state.finish?.status).toBe("consensus");
    const state = readSession(dir, "s", dead)!.state;
    const done = readEvents(dir, "s")!.events.filter((e) => e.type === "turn_completed");
    expect(done).toHaveLength(2);
    expect(sessionTotals(state).turns).toBe(2);
    expect(sessionTotals(state).durationMs).toBe(done.reduce((n, e) => n + (e as { durationMs: number }).durationMs, 0));
  });
});

describe("planResume: token cap", () => {
  // The old session's journal is assembled by hand: scripted participants do not set tokens yet.
  const rewrite = (dir: string, id: string, fn: (e: SessionEvent) => SessionEvent | null) => {
    const evs = readEvents(dir, id)!.events.map(fn).filter((e): e is SessionEvent => e !== null);
    writeFileSync(eventsPath(dir, id), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };
  // Usage 1500 (1000 + 500 on the first turn); cap — session cap; finish: "token_cap" | "interrupted" | "keep".
  async function spent(dir: string, cap: number | undefined, finish: "token_cap" | "interrupted" | "keep" = "token_cap", maxRounds = 3) {
    const f1 = scenarioFile(dir, "p1", [amend("v1"), agree()]);
    const f2 = scenarioFile(dir, "p2", [object(), agree()]);
    await prior(dir, mk("s", { maxRounds: 1, models: [f1, f2] }), [scripted(amend("v1")), scripted(object())]);
    let first = true;
    rewrite(dir, "s", (e) => {
      if (e.type === "session_created") {
        const limits = { ...e.session.limits, maxRounds, ...(cap !== undefined ? { maxTotalTokens: cap } : {}) };
        return { ...e, session: { ...e.session, limits } };
      }
      if (e.type === "turn_completed" && first) { first = false; return { ...e, usage: { inputTokens: 1000, outputTokens: 500 } }; }
      if (e.type === "session_finished") {
        if (finish === "interrupted") return null;
        if (finish === "token_cap") return { ...e, status: "stopped", reason: "token_cap" };
      }
      return e;
    });
  }

  it("stopped by cap, continuation unchanged: refusal, journal unchanged", async () => {
    const dir = tmp();
    await spent(dir, 1200);
    const before = journal(dir, "s");
    expect(reasonOf(() => planResume(dir, "s", { isAlive: dead }))).toBe("token_cap");
    const m = msg(() => planResume(dir, "s", { isAlive: dead }));
    expect(m).toContain("1200");
    expect(m).toContain("1500");
    expect(m).toContain("--max-tokens");
    expect(m).toContain("--no-max-tokens");
    expect(journal(dir, "s")).toBe(before);
  });

  it("new cap not above usage: refusal with both numbers", async () => {
    const dir = tmp();
    await spent(dir, 1200);
    const before = journal(dir, "s");
    for (const maxTotalTokens of [1500, 1000]) {
      expect(reasonOf(() => planResume(dir, "s", { maxTotalTokens, isAlive: dead }))).toBe("token_cap");
      const m = msg(() => planResume(dir, "s", { maxTotalTokens, isAlive: dead }));
      expect(m).toContain(String(maxTotalTokens));
      expect(m).toContain("1500");
    }
    expect(journal(dir, "s")).toBe(before);
  });

  it("cap above usage: plan accepted, value goes to the engine", async () => {
    const dir = tmp();
    await spent(dir, 1200);
    const plan = planResume(dir, "s", { maxTotalTokens: 2500, isAlive: dead });
    expect(plan).toMatchObject({ spentTokens: 1500, tokenCap: 2500, maxTotalTokens: 2500 });
    // ponytail: the journal is written by the neighbouring executor's engine; we check what the continuation record gets from the plan
    expect(plan.maxTotalTokens).toBe(2500);
  });

  it("cap removed: null accepted", async () => {
    const dir = tmp();
    await spent(dir, 1200);
    const plan = planResume(dir, "s", { maxTotalTokens: null, isAlive: dead });
    expect(plan.tokenCap).toBeNull();
    expect(plan.maxTotalTokens).toBeNull();
    expect(plan).toHaveProperty("maxTotalTokens", null);
  });

  it("interrupted session: same refusal without new cap; with cap above — accepted", async () => {
    const dir = tmp();
    await spent(dir, 1200, "interrupted");
    const before = journal(dir, "s");
    expect(readSession(dir, "s", dead)?.status).toBe("interrupted");
    expect(reasonOf(() => planResume(dir, "s", { isAlive: dead }))).toBe("token_cap");
    const m = msg(() => planResume(dir, "s", { isAlive: dead }));
    expect(m).toContain("1200");
    expect(m).toContain("1500");
    expect(planResume(dir, "s", { maxTotalTokens: 3000, isAlive: dead })).toMatchObject({ status: "interrupted", tokenCap: 3000 });
    expect(journal(dir, "s")).toBe(before);
  });

  it("cap not reached: accepted, no maxTotalTokens field in plan", async () => {
    const dir = tmp();
    await spent(dir, 5000, "keep");
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    expect(plan).toMatchObject({ spentTokens: 1500, tokenCap: 5000 });
    expect("maxTotalTokens" in plan).toBe(false);
  });

  it("session without cap: tokenCap null; requested cap accepted", async () => {
    const dir = tmp();
    await spent(dir, undefined, "keep");
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    expect(plan.tokenCap).toBeNull();
    expect("maxTotalTokens" in plan).toBe(false);
    expect(planResume(dir, "s", { rounds: 1, maxTotalTokens: 2000, isAlive: dead })).toMatchObject({ tokenCap: 2000, maxTotalTokens: 2000 });
  });

  it("bad_token_cap: 0, -1, 1.5, NaN", async () => {
    const dir = tmp();
    await spent(dir, 1200);
    const before = journal(dir, "s");
    for (const maxTotalTokens of [0, -1, 1.5, NaN]) {
      expect(reasonOf(() => planResume(dir, "s", { maxTotalTokens, isAlive: dead }))).toBe("bad_token_cap");
    }
    expect(msg(() => planResume(dir, "s", { maxTotalTokens: 0, isAlive: dead }))).toContain("не меньше 1");
    expect(journal(dir, "s")).toBe(before);
  });

  it("order of refusals: consensus before cap", async () => {
    const dir = tmp();
    await spent(dir, 1200, "keep");
    rewrite(dir, "s", (e) => (e.type === "session_finished" ? { ...e, status: "consensus", reason: undefined } : e));
    expect(reasonOf(() => planResume(dir, "s", { isAlive: dead }))).toBe("consensus");
  });
});

describe("continuation: owner wait", () => {
  const ask = [{ to: "owner", text: "Какой бюджет?" }];
  const q = (stance: string, solution: string | null, questions: object[] = []): Step =>
    ({ response: { stance, reasoning: "r", solution, answers: [], questions } });
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => boolean, ms = 5000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("не дождались условия");
      await pause(5);
    }
  };
  const evs = (dir: string, id: string) => readEvents(dir, id)?.events ?? [];
  const count = (dir: string, id: string, t: string) => evs(dir, id).filter((e) => e.type === t).length;
  const finishes = (dir: string, id: string) => evs(dir, id).filter((e) => e.type === "owner_wait_finished") as unknown as { reason: string; requestId?: string }[];

  // First segment: two turns, pause w1 (optionally with a question to the owner); journal cut right after owner_wait_started.
  async function waiting(dir: string, held = false) {
    const f1 = scenarioFile(dir, "a", [q("amend", "v1", held ? ask : []), agree()]);
    const f2 = scenarioFile(dir, "b", [object(), agree()]);
    const ac = new AbortController();
    const session = mk("s", { maxRounds: 2, models: [f1, f2], ownerWait: { pauseAfterRound: true, ...(held ? { waitForOwner: true } : {}) } });
    await prior(dir, session, [scripted(q("amend", "v1", held ? ask : [])), scripted(object())], {
      signal: ac.signal, onEvent: (e) => { if (e.type === "owner_wait_started") ac.abort(); },
    });
    cutAfter(dir, "s", (e) => e.type === "owner_wait_started", held ? 1 : 1);
    return evs(dir, "s").at(-1) as unknown as { waitId: string; reasons: string[]; questionIds: string[]; deadline: string };
  }
  const counted = (drivers: Record<string, ParticipantDriver>) => {
    const n = { v: 0 };
    const out = Object.fromEntries(Object.entries(drivers).map(([k, d]) => [k, { call: (r: TurnRequest) => { n.v++; return d.call(r); } } as ParticipantDriver]));
    return { drivers: out, n };
  };
  const runBg = async (dir: string, plan: ResumePlan, extra: Partial<Parameters<typeof runResumedSession>[0]> = {}) => {
    const { drivers } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
    const c = counted(drivers);
    const run = runResumedSession({ dataDir: dir, plan, drivers: c.drivers, isAlive: dead, waitPollMs: 10, stopPollMs: 20, ...extra });
    return { run, n: c.n };
  };
  const resumedAt = (dir: string) => until(() => count(dir, "s", "session_resumed") === 1);

  it("10. death during pause: interrupted, wait unchanged, journal untouched, release rejected", async () => {
    const dir = tmp();
    const w = await waiting(dir);
    const before = readFileSync(eventsPath(dir, "s"));
    const s = readSession(dir, "s", dead)!;
    expect(s.status).toBe("interrupted");
    expect(s.state.waiting).toMatchObject({ waitId: w.waitId, reasons: w.reasons, deadline: w.deadline });
    expect(readSession(dir, "s", alive)!.status).toBe("running");
    let reason = "";
    try { requestOwnerRelease(dir, "s", { isAlive: dead }); } catch (e) { reason = (e as OwnerReleaseRejectedError).reason; }
    expect(reason).toBe("interrupted");
    expect(existsSync(ownerMessagesDir(dir, "s"))).toBe(false);
    expect(readFileSync(eventsPath(dir, "s")).equals(before)).toBe(true);
  });

  it("11. continuation before deadline: same wait without new start; release, then turns", async () => {
    const dir = tmp();
    const w = await waiting(dir);
    const before = journal(dir, "s");
    const plan = planResume(dir, "s", { isAlive: dead });
    const { run, n } = await runBg(dir, plan);
    await resumedAt(dir);
    await pause(80);
    expect(n.v).toBe(0);
    expect(count(dir, "s", "owner_wait_started")).toBe(1);
    expect(evs(dir, "s").slice(plan.events.length).some((e) => e.type === "turn_started")).toBe(false);
    expect(readSession(dir, "s")!.state.waiting).toMatchObject({ waitId: "w1", deadline: w.deadline });
    const { requestId } = requestOwnerRelease(dir, "s");
    const r = await run;
    const ev = evs(dir, "s");
    const i = ev.findIndex((e) => e.type === "owner_wait_finished");
    expect(ev[i]).toMatchObject({ waitId: "w1", reason: "continued", requestId });
    expect(ev[i + 1]).toMatchObject({ type: "turn_started", turn: 3 });
    expect(count(dir, "s", "owner_wait_started")).toBe(1);
    expect(journal(dir, "s").startsWith(before)).toBe(true);
    expect(r.state.finish?.status).toBe("consensus");
  });

  it("12. continuation after deadline: unanswered and expired before first turn, no new deadline", async () => {
    const dir = tmp();
    await waiting(dir, true);
    const plan = planResume(dir, "s", { isAlive: dead });
    expect(plan.state.waiting).toMatchObject({ reasons: ["owner_question"], questionIds: ["q1"] });
    let k = 0;
    const late = () => new Date(Date.now() + 10_000_000 + 1_000_000 * k++); // each clock read is 1000 s later: new pauses also expire at once
    const run = await go(dir, plan, { now: late });
    const ev = evs(dir, "s").slice(plan.events.length);
    expect(ev.map((e) => e.type).slice(0, 4)).toEqual(["session_resumed", "question_closed", "owner_wait_finished", "turn_started"]);
    expect(ev[1]).toMatchObject({ questionId: "q1", reason: "unanswered" });
    expect(ev[2]).toMatchObject({ waitId: "w1", reason: "expired" });
    expect(ev.slice(0, ev.findIndex((e) => e.type === "turn_started")).some((e) => e.type === "owner_wait_started")).toBe(false);
    expect(run.state.finish?.status).toBe("consensus");
  });

  it("13. old requests: message returned, release deleted and does not cancel the transferred wait", async () => {
    const dir = tmp();
    await waiting(dir);
    const queue = ownerMessagesDir(dir, "s");
    mkdirSync(queue, { recursive: true });
    writeFileSync(join(queue, "000000000000001-msg.json"), JSON.stringify({ text: "потерянная" }));
    writeFileSync(join(queue, "000000000000002-rel.json"), JSON.stringify({ releaseWaitId: "w1" }));
    const plan = planResume(dir, "s", { isAlive: dead });
    const got: string[][] = [];
    const { run, n } = await runBg(dir, plan, { onAccepted: (i) => got.push(i.droppedOwnerRequests.map((r) => ("text" in r ? r.text : ""))) });
    await resumedAt(dir);
    await pause(80);
    expect(got).toEqual([["потерянная"]]);
    expect(existsSync(join(queue, "000000000000002-rel.json"))).toBe(false);
    expect(existsSync(join(queue, "000000000000001-msg.json"))).toBe(false);
    expect(finishes(dir, "s")).toHaveLength(0);
    expect(n.v).toBe(0);
    expect(readSession(dir, "s")!.state.waiting).toMatchObject({ waitId: "w1" });
    requestOwnerRelease(dir, "s");
    await run;
    expect(finishes(dir, "s")).toHaveLength(1);
  });

  it("14. retry after failure: file of an already applied release gives no second event", async () => {
    const dir = tmp();
    const f1 = scenarioFile(dir, "a", [amend("v1"), agree()]);
    const f2 = scenarioFile(dir, "b", [object(), agree()]);
    const live = prior(dir, mk("s", { maxRounds: 2, models: [f1, f2], ownerWait: { pauseAfterRound: true } }), [scripted(amend("v1"), agree()), scripted(object(), agree())], { waitPollMs: 10 });
    await until(() => count(dir, "s", "owner_wait_started") === 1);
    const { requestId } = requestOwnerRelease(dir, "s");
    await live;
    cutAfter(dir, "s", (e) => e.type === "owner_wait_finished");
    expect(finishes(dir, "s")).toMatchObject([{ reason: "continued", requestId }]);
    mkdirSync(ownerMessagesDir(dir, "s"), { recursive: true });
    writeFileSync(join(ownerMessagesDir(dir, "s"), `${requestId}.json`), JSON.stringify({ releaseWaitId: "w1" }));
    const run = await go(dir, planResume(dir, "s", { isAlive: dead }), { waitPollMs: 10 });
    expect(finishes(dir, "s")).toHaveLength(1);
    expect(run.state.finish?.status).toBe("consensus");
  });

  it("15. stop during transferred wait: stopped, participants not called", async () => {
    const dir = tmp();
    await waiting(dir);
    const plan = planResume(dir, "s", { isAlive: dead });
    const { run, n } = await runBg(dir, plan);
    await resumedAt(dir);
    requestStop(dir, "s");
    const r = await run;
    const ev = evs(dir, "s").slice(plan.events.length);
    expect(ev.map((e) => e.type)).toEqual(["session_resumed", "owner_wait_finished", "session_finished"]);
    expect(ev[1]).toMatchObject({ waitId: "w1", reason: "stopped" });
    expect(r.state.finish?.status).toBe("stopped");
    expect(n.v).toBe(0);
  });

  it("16. interrupted session with wait accepted, running one — running", async () => {
    const dir = tmp();
    const w = await waiting(dir, true);
    const plan = planResume(dir, "s", { isAlive: dead });
    expect(plan.status).toBe("interrupted");
    expect(plan.state.waiting).toMatchObject({ waitId: w.waitId, reasons: w.reasons, questionIds: w.questionIds, deadline: w.deadline });
    expect(reasonOf(() => planResume(dir, "s", { isAlive: alive }))).toBe("running");
  });

  it("17. old journal without wait events continues as before", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const run = await go(dir, planResume(dir, "s", { rounds: 1, isAlive: dead }));
    expect(run.state.finish?.status).toBe("consensus");
    expect(evs(dir, "s").some((e) => e.type.startsWith("owner_wait"))).toBe(false);
  });
});

describe("continuation with draft phase", () => {
  const dsession = (id: string, o: { rounds?: number; cap?: number } = {}) =>
    createSession(
      {
        topic: "Тема", framing: "", origin: "cli", drafts: { synthesizerId: "p2" },
        limits: { maxRounds: o.rounds ?? 3, turnTimeoutSec: 30, contextChars: 20000, ...(o.cap ? { maxTotalTokens: o.cap } : {}) } as Limits,
        participants: [1, 2, 3].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id },
    );
  interface Rec { id: string; prompt: string; phase: boolean }
  // Drivers by request: in the phase — draft "ЧЕРНОВИК-pN" with draftTokens usage, then a turn with stance turnStance.
  const fakes = (rec: Rec[], flag: { over: boolean }, o: { draftTokens?: number; turnStance?: string; badFirst?: string; text?: string } = {}) => {
    const bad = { v: o.badFirst !== undefined };
    return Object.fromEntries(["p1", "p2", "p3"].map((id) => [id, {
      call: async (req: TurnRequest) => {
        rec.push({ id, prompt: req.prompt, phase: !flag.over });
        if (!flag.over && bad.v && id === o.badFirst) { bad.v = false; return { text: "это не JSON", usage: { inputTokens: 1, outputTokens: 0, costUsd: 0 } }; }
        const stance = flag.over && id !== "p2" ? o.turnStance ?? "agree" : "amend";
        const solution = flag.over ? (stance === "agree" ? null : stance === "object" ? null : `ХОД-${id}`) : `${o.text ?? "ЧЕРНОВИК"}-${id}`;
        return { text: JSON.stringify({ stance, reasoning: "r", solution, answers: [], questions: [] }), usage: { inputTokens: flag.over ? 1 : o.draftTokens ?? 7, outputTokens: 0, costUsd: 0 } };
      },
    } as ParticipantDriver]));
  };
  const track = (flag: { over: boolean }) => (e: SessionEvent) => { if (e.type === "drafts_finished") flag.over = true; };
  const prefixOf = (dir: string) => Buffer.from(readFileSync(eventsPath(dir, "s")));
  const isStarted = (id: string) => (e: SessionEvent) => e.type === "draft_attempt_started" && e.participantId === id;
  const phaseCalls = (rec: Rec[], id: string) => rec.filter((r) => r.phase && r.id === id);

  /** A real run with a phase; journal cut right after draft_attempt_started p2: p1 accepted, p2 has an attempt without outcome, p3 has not started. */
  const interrupted = async (dir: string, o: { cap?: number; draftTokens?: number } = {}) => {
    const flag = { over: false };
    await runStoredSession({ session: dsession("s", o), drivers: fakes([], flag, { draftTokens: o.draftTokens }), dataDir: dir, onEvent: track(flag) });
    if (!o.cap) cutAfter(dir, "s", isStarted("p2"));
    rmSync(join(dir, "sessions", "s", "drafts", "d2.txt"), { force: true });
    rmSync(join(dir, "sessions", "s", "drafts", "d3.txt"), { force: true });
  };
  const resumeRun = (dir: string, plan: ResumePlan, rec: Rec[], flag: { over: boolean }, o: Parameters<typeof fakes>[2] = {}) =>
    runResumedSession({ dataDir: dir, plan, drivers: fakes(rec, flag, o), onEvent: track(flag), isAlive: dead });

  it("interruption: remainder of phase calls, cross-attempts, journal and d1.txt untouched", async () => {
    const dir = tmp();
    await interrupted(dir);
    const plan = planResume(dir, "s", { isAlive: dead });
    expect(plan.status).toBe("interrupted");
    expect(plan.draftCalls).toBe(2 + 3);
    expect(plan.maxCalls).toBe(plan.active.length * plan.addedRounds * 3 + plan.draftCalls);
    expect(plan.spentTokens).toBe(7);
    const before = prefixOf(dir);
    const d1 = readFileSync(join(dir, "sessions", "s", "drafts", "d1.txt"));
    const rec: Rec[] = [];
    const flag = { over: false };
    await resumeRun(dir, plan, rec, flag, { badFirst: "p2" });
    expect(phaseCalls(rec, "p1")).toHaveLength(0);
    expect(phaseCalls(rec, "p2").length).toBeLessThanOrEqual(2);
    const after = prefixOf(dir);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    const fresh = readEvents(dir, "s")!.events.slice(plan.events.length);
    expect(fresh.filter((e) => e.type === "draft_attempt_started" && e.participantId === "p2").map((e) => (e as { attempt: number }).attempt)).toEqual([2, 3]);
    expect(readFileSync(join(dir, "sessions", "s", "drafts", "d1.txt")).equals(d1)).toBe(true);
  });

  it("orphan snapshot d2 does not interfere and is replaced by accepted text", async () => {
    const dir = tmp();
    await interrupted(dir);
    const d2 = join(dir, "sessions", "s", "drafts", "d2.txt");
    writeFileSync(d2, "посторонний текст");
    const plan = planResume(dir, "s", { isAlive: dead });
    await resumeRun(dir, plan, [], { over: false });
    const done = readEvents(dir, "s")!.events.find((e) => e.type === "draft_completed" && e.draftId === "d2");
    expect(done).toBeDefined();
    const text = readFileSync(d2, "utf8");
    expect(text).toBe("ЧЕРНОВИК-p2");
    expect(done).toMatchObject({ chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex") });
  });

  it.each([["изменён", (p: string) => writeFileSync(p, "испорчено")], ["удалён", (p: string) => rmSync(p)]] as const)(
    "damage: d1 snapshot %s — draft refusal without changing the journal or calls", async (_n, damage) => {
      const dir = tmp();
      await interrupted(dir);
      damage(join(dir, "sessions", "s", "drafts", "d1.txt"));
      const before = prefixOf(dir);
      let err: unknown;
      try { planResume(dir, "s", { isAlive: dead }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ResumeRejectedError);
      expect((err as ResumeRejectedError).reason).toBe("draft");
      expect((err as Error).message).toMatch(/^Сессия s: снимок черновика d1 .+; продолжение невозможно\.$/);
      expect(prefixOf(dir).equals(before)).toBe(true);
      expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
    },
  );

  it("continuation after phase: drafts in each request, synthesizer goes first, draftCalls 0", async () => {
    const dir = tmp();
    const flag0 = { over: false };
    await runStoredSession({ session: dsession("s", { rounds: 1 }), drivers: fakes([], flag0, { turnStance: "object" }), dataDir: dir, onEvent: track(flag0) });
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    expect(plan.status).toBe("no_consensus");
    expect(plan.draftCalls).toBe(0);
    expect(plan.maxCalls).toBe(plan.active.length * 1 * 3);
    const rec: Rec[] = [];
    await resumeRun(dir, plan, rec, { over: true });
    expect(rec.length).toBeGreaterThan(0);
    expect(rec[0]!.id).toBe("p2");
    for (const r of rec) {
      expect(r.prompt).toContain("# Независимые черновики");
      for (const id of ["p1", "p2", "p3"]) expect(r.prompt).toContain(`ЧЕРНОВИК-${id}`);
    }
  });

  it("token cap exhausted in phase: without new cap refusal, with new one — phase from second slot", async () => {
    const dir = tmp();
    await interrupted(dir, { cap: 5, draftTokens: 7 });
    expect(reasonOf(() => planResume(dir, "s", { isAlive: dead }))).toBe("token_cap");
    const plan = planResume(dir, "s", { maxTotalTokens: 1000, isAlive: dead });
    expect(plan.status).toBe("stopped");
    expect(plan.spentTokens).toBe(7);
    expect(plan.draftCalls).toBe(6);
    const rec: Rec[] = [];
    await resumeRun(dir, plan, rec, { over: false });
    expect(phaseCalls(rec, "p1")).toHaveLength(0);
    expect(phaseCalls(rec, "p2").length).toBeGreaterThan(0);
  });

  // Drivers: p2 (synthesizer) answers non-JSON starting from call No. badFrom (counted from 1); the rest are as fakes.
  const withBadSynth = (flag: { over: boolean }, badFrom: number) => {
    const base = fakes([], flag, { turnStance: "object" });
    let calls = 0;
    return { ...base, p2: { call: async (req: TurnRequest) => (++calls >= badFrom ? { text: "это не JSON", usage: {} } : base.p2!.call(req)) } as ParticipantDriver };
  };

  it("interrupted after synthesizer dropped out: synthesizer refusal", async () => {
    const dir = tmp();
    const flag = { over: false };
    const run = await runStoredSession({ session: dsession("s"), drivers: withBadSynth(flag, 1), dataDir: dir, onEvent: track(flag) });
    expect(run.state.finish).toMatchObject({ status: "failed", reason: "synthesizer_unavailable" });
    cutAfter(dir, "s", (e) => e.type === "participant_dropped"); // process died before the result was written
    const before = prefixOf(dir);
    let err: unknown;
    try { planResume(dir, "s", { isAlive: dead }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ResumeRejectedError);
    expect((err as ResumeRejectedError).reason).toBe("synthesizer");
    expect((err as Error).message).toMatch(/синтезатор p2 «N2» выбыл, не создав версию 1/);
    expect(prefixOf(dir).equals(before)).toBe(true);
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
  });

  it("synthesizer dropped out after version 1: plan accepted", async () => {
    const dir = tmp();
    const flag = { over: false };
    // p2 calls: 1 — draft, 2 — turn 1 (version 1), from the 3rd — non-JSON: drops out in the second round
    const run = await runStoredSession({ session: dsession("s", { rounds: 2 }), drivers: withBadSynth(flag, 3), dataDir: dir, onEvent: track(flag) });
    expect(run.state.finish?.status).toBe("no_consensus");
    expect(run.state.versions[0]?.authorId).toBe("p2");
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    expect(plan.active.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(plan.maxCalls).toBe(2 * 1 * 3);
  });
});

describe("participant replacement on continuation", () => {
  const usageOf = (d: ParticipantDriver): ParticipantDriver => ({ call: async (r) => ({ ...(await d.call(r)), usage: { inputTokens: 10, outputTokens: 5 } }) });
  // p1 keeps going and stays alone: p2 and p3 drop out; failure with reasonCode. models: p1 — continuation scenario.
  async function insufficient(dir: string, id = "s", o: MkOpts = {}) {
    const f1 = scenarioFile(dir, `${id}-p1`, [amend("v1"), agree()]);
    await prior(dir, mk(id, { n: 3, models: [f1, "x", "y"], ...o }), [usageOf(scripted(amend("v1"))), scripted(fatal), scripted(fatal)], o.materials ? { materials: o.materials } : {});
    return f1;
  }
  const newFile = (dir: string, name = "new", steps: Step[] = [agree()]) => scenarioFile(dir, name, steps);
  const rep = (participantId: string, model: string, extra: Partial<{ providerId: string; name: string }> = {}) => ({ participantId, providerId: "scripted", model, ...extra });

  it("failure without reasonCode (even with same reason text) — failed; with reasonCode without map — too_few_active with name of dropped participant", async () => {
    const dir = tmp();
    await insufficient(dir);
    expect(readEvents(dir, "s")!.events.at(-1)).toMatchObject({ type: "session_finished", status: "failed", reasonCode: "insufficient_active_participants" });
    const m = msg(() => planResume(dir, "s", { isAlive: dead }));
    expect(reasonOf(() => planResume(dir, "s", { isAlive: dead }))).toBe("too_few_active");
    expect(m).toContain("активных участников меньше двух");
    expect(m).toContain("p2");
    expect(m).toContain("p3");
    stripReasonCode(dir, "s");
    const e = readEvents(dir, "s")!.events.at(-1) as { reason?: string };
    expect(e.reason).toBe("Активных участников осталось меньше двух.");
    expect(reasonOf(() => planResume(dir, "s", { replacements: [rep("p2", "x")], isAlive: dead }))).toBe("failed");
  });

  it("correct map: new id next free, role inherited, slot kept, state unchanged", async () => {
    const dir = tmp();
    await insufficient(dir);
    const before = journal(dir, "s");
    const f = newFile(dir);
    const plan = planResume(dir, "s", { replacements: [rep("p2", f)], isAlive: dead });
    expect(plan.status).toBe("failed");
    expect(plan.replacements).toHaveLength(1);
    expect(plan.replacements[0]).toMatchObject({ oldParticipantId: "p2", wasActive: false, participant: { id: "p4", name: "Участник 4", role: null, providerId: "scripted", model: f } });
    expect(plan.replacements[0]!.dropReason).toEqual(expect.any(String));
    expect(plan.active.map((p) => p.id)).toEqual(["p1", "p4"]);
    expect(plan.session.participants.map((p) => [p.id, p.replaces])).toEqual([["p1", undefined], ["p2", undefined], ["p3", undefined], ["p4", "p2"]]);
    expect(plan.state.session!.participants.map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
    expect(plan.maxCalls).toBe(2 * plan.addedRounds * 3);
    expect(journal(dir, "s")).toBe(before);
  });

  it("replaced participant's role passes to the new one", async () => {
    const dir = tmp();
    const f1 = scenarioFile(dir, "r1", [amend("v1"), agree()]);
    const session = mk("s", { n: 3, models: [f1, "x", "y"] });
    session.participants[1]!.role = "критик";
    await prior(dir, session, [scripted(amend("v1")), scripted(fatal), scripted(fatal)]);
    const plan = planResume(dir, "s", { replacements: [rep("p2", newFile(dir))], isAlive: dead });
    expect(plan.replacements[0]!.participant.role).toBe("критик");
  });

  it("map errors: replacement, journal unchanged", async () => {
    const dir = tmp();
    await insufficient(dir);
    const f = newFile(dir);
    const before = journal(dir, "s");
    const bad: [string, Parameters<typeof planResume>[2]][] = [
      ["дубль", { replacements: [rep("p2", f), rep("p2", f)] }],
      ["неизвестный", { replacements: [rep("p9", f)] }],
      ["пустой провайдер", { replacements: [rep("p2", f, { providerId: " " })] }],
      ["пустая модель", { replacements: [rep("p2", "  ")] }],
    ];
    for (const [, o] of bad) expect(reasonOf(() => planResume(dir, "s", { ...o, isAlive: dead }))).toBe("replacement");
    expect(msg(() => planResume(dir, "s", { replacements: [rep("p9", f)], isAlive: dead }))).toContain("p9");
    expect(journal(dir, "s")).toBe(before);
  });

  it("already replaced participant: message names the current occupant", async () => {
    const dir = tmp();
    const f1 = await insufficient(dir);
    const f = newFile(dir, "n1", [agree(), agree()]);
    const plan = planResume(dir, "s", { replacements: [rep("p2", f)], isAlive: dead });
    const { drivers } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
    await runResumedSession({ dataDir: dir, plan, drivers, isAlive: dead });
    // after the continuation the session reaches a result again; we attribute a second failure for the new attempt
    const evs = readEvents(dir, "s")!.events;
    const idx = evs.findIndex((e) => e.type === "session_resumed");
    writeFileSync(eventsPath(dir, "s"), evs.slice(0, idx + 1).map((e) => JSON.stringify(e)).join("\n") + "\n");
    const before = journal(dir, "s");
    const e = msg(() => planResume(dir, "s", { replacements: [rep("p2", f1)], isAlive: dead }));
    expect(reasonOf(() => planResume(dir, "s", { replacements: [rep("p2", f1)], isAlive: dead }))).toBe("replacement");
    expect(e).toContain("p2");
    expect(e).toContain("p4");
    expect(journal(dir, "s")).toBe(before);
  });

  it("two replacements in any input order give one plan", async () => {
    const dir = tmp();
    await insufficient(dir);
    const a = newFile(dir, "a"), b = newFile(dir, "b");
    const x = planResume(dir, "s", { replacements: [rep("p2", a), rep("p3", b)], isAlive: dead });
    const y = planResume(dir, "s", { replacements: [rep("p3", b), rep("p2", a)], isAlive: dead });
    expect(y.replacements).toEqual(x.replacements);
    expect(y.active).toEqual(x.active);
    expect(x.replacements.map((r) => [r.oldParticipantId, r.participant.id])).toEqual([["p2", "p4"], ["p3", "p5"]]);
    expect(x.active.map((p) => p.id)).toEqual(["p1", "p4", "p5"]);
  });

  it("name: default 'Participant N', explicit one trimmed", async () => {
    const dir = tmp();
    await insufficient(dir);
    const f = newFile(dir);
    const x = planResume(dir, "s", { replacements: [rep("p2", f), rep("p3", f, { name: "  Свой  " })], isAlive: dead });
    expect(x.replacements.map((r) => r.participant.name)).toEqual(["Участник 4", "Свой"]);
  });

  it("synthesizer dropped out without version 1: replacement does not inherit role — synthesizer", async () => {
    const dir = tmp();
    const dsession = createSession(
      {
        topic: "Тема", framing: "", origin: "cli", drafts: { synthesizerId: "p2" },
        limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000 } as Limits,
        participants: [1, 2, 3].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id: "s" },
    );
    const bad: ParticipantDriver = { call: async () => ({ text: "это не JSON", usage: {} }) };
    const ok = (id: string): ParticipantDriver => ({ call: async () => ({ text: JSON.stringify({ stance: "amend", reasoning: "r", solution: `ЧЕРНОВИК-${id}`, answers: [], questions: [] }), usage: {} }) });
    await runStoredSession({ session: dsession, drivers: { p1: ok("p1"), p2: bad, p3: ok("p3") }, dataDir: dir });
    cutAfter(dir, "s", (e) => e.type === "participant_dropped"); // process died before the result was written
    const f = newFile(dir);
    const before = journal(dir, "s");
    expect(reasonOf(() => planResume(dir, "s", { replacements: [rep("p2", f)], isAlive: dead }))).toBe("synthesizer");
    expect(journal(dir, "s")).toBe(before);
  });

  it("material snapshot missing: material, journal unchanged", async () => {
    const dir = tmp();
    await insufficient(dir, "s", { materials: [material("m1", "Файл", "текст")] });
    rmSync(materialPath(dir, "s", "m1"), { force: true });
    const before = journal(dir, "s");
    expect(reasonOf(() => planResume(dir, "s", { replacements: [rep("p2", newFile(dir))], isAlive: dead }))).toBe("material");
    expect(journal(dir, "s")).toBe(before);
  });

  it("drafts: replaced slot has a started attempt — new one has 2 calls left", async () => {
    const dir = tmp();
    const dsession = createSession(
      {
        topic: "Тема", framing: "", origin: "cli", drafts: { synthesizerId: "p1" },
        limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000 } as Limits,
        participants: [1, 2, 3].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id: "s" },
    );
    const mkDraft = (id: string): ParticipantDriver => ({ call: async () => ({ text: JSON.stringify({ stance: "amend", reasoning: "r", solution: `Ч-${id}`, answers: [], questions: [] }), usage: {} }) });
    await runStoredSession({ session: dsession, drivers: { p1: mkDraft("p1"), p2: mkDraft("p2"), p3: mkDraft("p3") }, dataDir: dir });
    cutAfter(dir, "s", (e) => e.type === "draft_attempt_started" && e.participantId === "p2");
    const plan = planResume(dir, "s", { isAlive: dead });
    expect(plan.draftCalls).toBe(2 + 3);
    // p2 drops out, its slot d2 has one started attempt; the new participant gets the remaining calls of the slot (2), not 3
    const evs = readEvents(dir, "s")!.events;
    writeFileSync(eventsPath(dir, "s"), [...evs, { type: "participant_dropped", seq: 999, ts: new Date().toISOString(), participantId: "p2", reason: "ушёл" }, ...[]].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const dropped = planResume(dir, "s", { replacements: [rep("p2", newFile(dir))], isAlive: dead });
    expect(dropped.draftCalls).toBe(2 + 3);
    expect(dropped.active.map((p) => p.id)).toEqual(["p1", "p4", "p3"]);
  });

  it("without map plan matches the old form plus replacements: []", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 2, isAlive: dead });
    expect(plan.replacements).toEqual([]);
    expect(plan.session).toEqual(plan.state.session);
    expect(plan.active).toEqual(plan.state.session!.participants);
    expect(plan.maxCalls).toBe(12);
  });

  describe("resumeDrivers", () => {
    // p1 and p2 are active; p2 drops out not because of the journal but because the scenario file is unavailable
    async function unavailableP2(dir: string) {
      const f1 = scenarioFile(dir, "u1", [amend("v1"), agree()]);
      await prior(dir, mk("s", { maxRounds: 1, models: [f1, join(dir, "нет.json")] }), [scripted(amend("v1")), scripted(object())]);
      return f1;
    }

    it("available active cannot be replaced", async () => {
      const dir = tmp();
      await noConsensus(dir);
      const plan = planResume(dir, "s", { rounds: 1, replacements: [rep("p2", newFile(dir))], isAlive: dead });
      const e = await rejects(resumeDrivers(plan, { registry: registry(), env, dataDir: dir }));
      expect(e.reason).toBe("replacement");
      expect(e.message).toContain("p2");
      expect(e.message).toContain("доступен");
    });

    it("unavailable active: reason in unavailable, stub for old, new from step 0", async () => {
      const dir = tmp();
      await unavailableP2(dir);
      const f = newFile(dir, "n", [object(), agree()]);
      const plan = planResume(dir, "s", { rounds: 1, replacements: [rep("p2", f)], isAlive: dead });
      expect(plan.replacements[0]).toMatchObject({ wasActive: true, dropReason: null });
      const { drivers, unavailable } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
      expect(Object.keys(unavailable)).toEqual(["p2"]);
      expect(unavailable.p2).toEqual(expect.any(String));
      expect(unavailable.p2!.length).toBeGreaterThan(0);
      expect(Object.keys(drivers)).toEqual(["p1", "p2", "p3"]);
      const err = await drivers.p2!.call({} as TurnRequest).catch((e) => e);
      expect(err).toBeInstanceOf(ParticipantCallError);
      const first = await drivers.p3!.call({ prompt: "x", signal: new AbortController().signal, onChunk: () => {} } as unknown as TurnRequest);
      expect(JSON.parse(first.text).stance).toBe("object");
    });

    it("new: no scenario file, unknown provider, model without explicit value and with colon", async () => {
      const dir = tmp();
      await insufficient(dir);
      const check = async (r: ReturnType<typeof rep>, reg: Registry = registry()) => {
        const plan = planResume(dir, "s", { replacements: [r], isAlive: dead });
        const e = await rejects(resumeDrivers(plan, { registry: reg, env, dataDir: dir }));
        expect(e.reason).toBe("replacement");
        expect(e.message).toContain("p2");
        expect(e.message).toContain("p4");
        return e.message;
      };
      await check(rep("p2", join(dir, "нет.json")));
      await check({ participantId: "p2", providerId: "gone", model: "m" }, registry([web]));
      await check({ participantId: "p2", providerId: "web", model: "default" }, registry([web]));
      await check({ participantId: "p2", providerId: "cli1", model: "a:b" }, registry([{ id: "cli1", kind: "cli", label: "C", models: [] }]));
    });

    it("registry.defaults.maxParticipants limit below future number of active", async () => {
      const dir = tmp();
      await insufficient(dir);
      const plan = planResume(dir, "s", { replacements: [rep("p2", newFile(dir)), rep("p3", newFile(dir, "b"))], isAlive: dead });
      const reg = { providers: [], defaults: { maxParticipants: 2 } } as unknown as Registry;
      const e = await rejects(resumeDrivers(plan, { registry: reg, env, dataDir: dir }));
      expect(e.reason).toBe("replacement");
      expect(e.message).toContain("3");
      expect(e.message).toContain("2");
    });

    it("without replacements an unavailable active is still participant", async () => {
      const dir = tmp();
      await unavailableP2(dir);
      const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
      expect((await rejects(resumeDrivers(plan, { registry: registry(), env, dataDir: dir }))).reason).toBe("participant");
    });
  });

  describe("runResumedSession", () => {
    it("one session_resumed with replacements, prefix unchanged, old not called, new called, spend of earlier turns kept", async () => {
      const dir = tmp();
      await insufficient(dir);
      const before = Buffer.from(readFileSync(eventsPath(dir, "s")));
      const f = newFile(dir, "n", [agree()]);
      const plan = planResume(dir, "s", { replacements: [rep("p2", f)], isAlive: dead });
      const { drivers } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
      let oldCalled = false, newCalled = false;
      const old = drivers.p2!, fresh = drivers.p4!;
      drivers.p2 = { call: async (r) => { oldCalled = true; return old.call(r); } };
      drivers.p4 = { call: async (r) => { newCalled = true; return fresh.call(r); } };
      const run = await runResumedSession({ dataDir: dir, plan, drivers, isAlive: dead });
      expect(oldCalled).toBe(false);
      expect(newCalled).toBe(true);
      const after = Buffer.from(readFileSync(eventsPath(dir, "s")));
      expect(after.subarray(0, before.length).equals(before)).toBe(true);
      const resumed = readEvents(dir, "s")!.events.filter((e) => e.type === "session_resumed");
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ replacements: [{ oldParticipantId: "p2", participant: { id: "p4" } }] });
      expect(run.state.finish?.status).toBe("consensus");
      expect(tokenUsage(run.state).total).toBeGreaterThanOrEqual(15);
    });

    it("revalidate throws: no events, stop and message requests in place, no lock", async () => {
      const dir = tmp();
      await insufficient(dir);
      const plan = planResume(dir, "s", { replacements: [rep("p2", newFile(dir))], isAlive: dead });
      const { drivers } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
      writeFileSync(stopRequestPath(dir, "s"), "");
      const q = ownerMessagesDir(dir, "s");
      mkdirSync(q, { recursive: true });
      writeFileSync(join(q, "000000000000001-a.json"), JSON.stringify({ text: "потерянная" }));
      const before = journal(dir, "s");
      const boom = new Error("не прошло");
      const err = await runResumedSession({ dataDir: dir, plan, drivers, isAlive: dead, revalidate: async () => { throw boom; } }).catch((e) => e);
      expect(err).toBe(boom);
      expect(journal(dir, "s")).toBe(before);
      expect(existsSync(stopRequestPath(dir, "s"))).toBe(true);
      expect(readdirSync(q)).toEqual(["000000000000001-a.json"]);
      expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
    });

    it("two starts with different maps: one runs, second busy, session_resumed one", async () => {
      const dir = tmp();
      await insufficient(dir);
      const a = planResume(dir, "s", { replacements: [rep("p2", newFile(dir, "a"))], isAlive: dead });
      const b = planResume(dir, "s", { replacements: [rep("p3", newFile(dir, "b"))], isAlive: dead });
      const da = (await resumeDrivers(a, { registry: registry(), env, dataDir: dir })).drivers;
      const db = (await resumeDrivers(b, { registry: registry(), env, dataDir: dir })).drivers;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let started!: () => void;
      const hasStarted = new Promise<void>((r) => { started = r; });
      const slow = da.p1!;
      da.p1 = { call: async (r) => { started(); await gate; return slow.call(r); } };
      const first = runResumedSession({ dataDir: dir, plan: a, drivers: da });
      await hasStarted;
      expect((await rejects(runResumedSession({ dataDir: dir, plan: b, drivers: db }))).reason).toBe("busy");
      release();
      await first;
      expect(types(readEvents(dir, "s")!.events).filter((t) => t === "session_resumed")).toHaveLength(1);
    });
  });
});

describe("planResume: failed-segment spend", () => {
  // Journal F1: turn 2 reported 250 tokens in an invalid answer, its repeat was cut off by a stop.
  // The continuation repeats turn 2 at 10/10 (objection, no agreement) and reaches the cap of 270.
  async function journalF1(dir: string, id: string, cap: number) {
    const ac = new AbortController();
    let n = 0;
    const p2First: ParticipantDriver = {
      call: () => {
        if (n++ === 0) return Promise.resolve({ text: "это не JSON", usage: { inputTokens: 150, outputTokens: 100 } });
        ac.abort();
        return never();
      },
    };
    const session = mk(id, { maxRounds: 2 });
    await prior(dir, { ...session, limits: { ...session.limits, maxTotalTokens: cap } }, [scripted(amend("v1")), p2First], { signal: ac.signal });
    const plan = planResume(dir, id, { isAlive: dead });
    const valid = JSON.stringify({ stance: "object", reasoning: "r", solution: null, answers: [], questions: [] });
    await runResumedSession({
      dataDir: dir, plan, isAlive: dead,
      drivers: { p1: scripted(agree()), p2: { call: async () => ({ text: valid, usage: { inputTokens: 10, outputTokens: 10 } }) } },
    });
  }

  it("Accumulated session figures: turn 2 failure before continuation counts in usage and in cap 270", async () => {
    const dir = tmp();
    await journalF1(dir, "s", 270);
    expect(readSession(dir, "s", dead)?.state.finish).toMatchObject({ status: "stopped", reason: "token_cap" });
    expect(reasonOf(() => planResume(dir, "s", { maxTotalTokens: 270, isAlive: dead }))).toBe("token_cap");
    expect(msg(() => planResume(dir, "s", { maxTotalTokens: 270, isAlive: dead }))).toContain("270");
    expect(planResume(dir, "s", { maxTotalTokens: 300, isAlive: dead })).toMatchObject({ spentTokens: 270, tokenCap: 300 });
  });
});

describe("Interrupted session: continuation executor crashed in a live process", () => {
  it("write after session_resumed failed: interrupted, continuation accepted, stop rejected", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    const root = process.getuid?.() === 0;
    let broke = false;
    await expect(go(dir, plan, {
      onEvent: (e) => {
        if (e.type !== "session_resumed" || broke) return;
        broke = true;
        if (root) { rmSync(eventsPath(dir, "s")); mkdirSync(eventsPath(dir, "s")); } else chmodSync(eventsPath(dir, "s"), 0o444);
      },
      isAlive: undefined,
    })).rejects.toThrow();
    if (root) return;
    const before = journal(dir, "s");
    expect(readSession(dir, "s")!.status).toBe("interrupted");
    expect(listSessions(dir).find((x) => x.id === "s")!.status).toBe("interrupted");
    expect(reasonOf(() => planResume(dir, "s", { rounds: 1 }))).not.toBe("running");
    let err: unknown;
    try { requestStop(dir, "s"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StopRejectedError);
    expect((err as StopRejectedError).reason).toBe("interrupted");
    expect(existsSync(stopRequestPath(dir, "s"))).toBe(false);
    expect(journal(dir, "s")).toBe(before);
  });
});

// Session id with two scripted participants: round 1 → consensus (p1 amend, p2 agree); both keep agreeing.
async function consensus(dir: string, id = "c") {
  const f1 = scenarioFile(dir, `${id}-p1`, [amend("v1"), agree(), agree()]);
  const f2 = scenarioFile(dir, `${id}-p2`, [agree(), agree(), agree()]);
  const session = mk(id, { maxRounds: 3, models: [f1, f2] });
  await prior(dir, session, [scripted(amend("v1")), scripted(agree())]);
  return session;
}
const after = (events: readonly SessionEvent[], type: SessionEvent["type"]) => events[events.findIndex((e) => e.type === type) + 1];

describe("Owner message on resume", () => {
  it("consensus without a message or with a whitespace message refused, journal unchanged", async () => {
    const dir = tmp();
    await consensus(dir);
    const before = journal(dir, "c");
    expect(reasonOf(() => planResume(dir, "c", { isAlive: dead }))).toBe("consensus");
    expect(reasonOf(() => planResume(dir, "c", { isAlive: dead, message: "   \n\t" }))).toBe("consensus");
    expect(reasonOf(() => planResume(dir, "c", { isAlive: dead, message: "" }))).toBe("consensus");
    expect(msg(() => planResume(dir, "c", { isAlive: dead }))).toContain("согласие достигнуто: продолжить можно только с репликой владельца");
    expect(journal(dir, "c")).toBe(before);
  });

  it("consensus with a message accepted: owner_message right after session_resumed, agreement reset, consensus again after both spoke", async () => {
    const dir = tmp();
    await consensus(dir);
    const plan = planResume(dir, "c", { rounds: 1, isAlive: dead, message: "Учтите ещё бюджет" });
    expect(plan.message).toBe("Учтите ещё бюджет");
    const run = await go(dir, plan);
    const evs = run.events;
    expect(evs[0]).toMatchObject({ type: "session_resumed" });
    expect(evs[1]).toMatchObject({ type: "owner_message", id: "o1", text: "Учтите ещё бюджет", afterTurn: 2 });
    const reset = readEvents(dir, "c")!.events;
    expect(foldEvents(reset.slice(0, reset.indexOf(reset.find((e) => e.type === "owner_message")!) + 1)).agreed).toEqual([]);
    expect((evs[1] as { requestId: string }).requestId).toMatch(/^resume-/);
    expect(types(evs.slice(2))).toEqual(["turn_started", "turn_completed", "turn_started", "turn_completed", "session_finished"]);
    expect(evs[2]).toMatchObject({ turn: 3, round: 2, participantId: "p1" });
    expect(run.state.finish?.status).toBe("consensus");
    expect(run.state.finish?.version).toBe(1);
    expect(run.state.versions.map((v) => v.number)).toEqual([1]);
    expect(run.state.resumes.at(-1)).toMatchObject({ beforeTurn: 3, ownerMessagesBefore: 0 });
    const folded = readSession(dir, "c", dead)!.state;
    expect(folded.ownerMessages.map((o) => o.id)).toEqual(["o1"]);
  });

  it("the message reaches the next turn's context", async () => {
    const dir = tmp();
    await consensus(dir);
    const plan = planResume(dir, "c", { rounds: 1, isAlive: dead, message: "Учтите ещё бюджет" });
    const seen: string[] = [];
    const spy = (d: ParticipantDriver): ParticipantDriver => ({ call: (r: TurnRequest) => { seen.push(JSON.stringify(r)); return d.call(r); } });
    await runResumedSession({ dataDir: dir, plan, drivers: { p1: spy(scripted(agree())), p2: spy(scripted(agree())) }, isAlive: dead });
    expect(seen.length).toBe(2);
    expect(seen.every((s) => s.includes("Учтите ещё бюджет"))).toBe(true);
  });

  it("numbering continues after earlier messages; mark keeps their count", async () => {
    const dir = tmp();
    await consensus(dir);
    const plan1 = planResume(dir, "c", { rounds: 1, isAlive: dead, message: "раз" });
    await go(dir, plan1);
    const plan2 = planResume(dir, "c", { rounds: 1, isAlive: dead, message: "два" });
    const run = await go(dir, plan2);
    expect(run.events[1]).toMatchObject({ type: "owner_message", id: "o2", text: "два", afterTurn: 4 });
    expect(run.state.resumes.map((r) => r.ownerMessagesBefore)).toEqual([0, 1]);
    expect(new Set(run.state.ownerMessages.map((o) => o.requestId)).size).toBe(2);
  });

  it("no_consensus accepts a message and works without one", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const with_ = await go(dir, planResume(dir, "s", { rounds: 1, isAlive: dead, message: "ещё" }));
    expect(with_.events[1]).toMatchObject({ type: "owner_message", id: "o1", afterTurn: 2 });
    const d2 = tmp();
    await noConsensus(d2);
    const without = await go(d2, planResume(d2, "s", { rounds: 1, isAlive: dead }));
    expect(types(without.events)).not.toContain("owner_message");
  });

  it("unfinished turn repeated: message afterTurn = beforeTurn − 1, same turn repeated after it", async () => {
    const dir = tmp();
    const ac = new AbortController();
    const f1 = scenarioFile(dir, "p1", [amend("v1"), agree()]);
    const f2 = scenarioFile(dir, "p2", [agree(), agree()]);
    const stopper: ParticipantDriver = { call: () => (ac.abort(), never()) };
    await prior(dir, mk("s", { models: [f1, f2] }), [scripted(amend("v1")), stopper], { signal: ac.signal });
    const plan = planResume(dir, "s", { isAlive: dead, message: "подождите" });
    expect(plan.point).toMatchObject({ turn: 2, redo: true });
    const run = await go(dir, plan);
    expect(run.events[1]).toMatchObject({ type: "owner_message", afterTurn: 1 });
    expect(run.events[2]).toMatchObject({ type: "turn_started", turn: 2, participantId: "p2" });
  });

  it("consensus fixed by a turn without session_finished: with a message a new turn runs before the result; without one the result is written at once", async () => {
    const dir = tmp();
    await consensus(dir);
    cutAfter(dir, "c", (e) => e.type === "turn_completed", 2);
    expect(readSession(dir, "c", dead)?.status).toBe("interrupted");
    const run = await go(dir, planResume(dir, "c", { rounds: 1, isAlive: dead, message: "ещё" }));
    expect(types(run.events).slice(0, 3)).toEqual(["session_resumed", "owner_message", "turn_started"]);
    expect(run.state.finish?.status).toBe("consensus");
    const d2 = tmp();
    await consensus(d2);
    cutAfter(d2, "c", (e) => e.type === "turn_completed", 2);
    const plain = await go(d2, planResume(d2, "c", { rounds: 1, isAlive: dead }));
    expect(types(plain.events)).toEqual(["session_resumed", "session_finished"]);
  });
});
