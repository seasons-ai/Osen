import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession } from "../engine.ts";
import type { ParticipantDriver } from "../participants/driver.ts";
import { createScriptedDriver } from "../participants/scripted.ts";
import type { Scenario } from "../participants/scripted.ts";
import type { Limits, Session, SessionEvent } from "../protocol/schema.ts";
import type { Registry } from "../registry/config.ts";
import { eventsPath, readEvents, resumeLockPath } from "./journal.ts";
import { OWNER_NOTE_MAX, OwnerSelectionRejectedError, selectOwnerVersion } from "./owner-selection.ts";
import type { OwnerSelectionRejection } from "./owner-selection.ts";
import { planResume, resumeDrivers, runResumedSession, ResumeRejectedError } from "./resume.ts";
import type { ResumePlan } from "./resume.ts";
import { runStoredSession } from "./run.ts";
import { readSession } from "./sessions.ts";

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
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "owner-sel-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const scripted = (...steps: Step[]) => createScriptedDriver({ steps }, env);
const dead = () => false;
const alive = () => true;
const registry = () => ({ providers: [], defaults: {} }) as unknown as Registry;

const mk = (id: string, models: string[] = []): Session =>
  createSession(
    {
      topic: "Тема", framing: "", origin: "cli",
      limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 20000 } as Limits,
      participants: [0, 1].map((i) => ({ name: `N${i + 1}`, providerId: "scripted", model: models[i] ?? "m", role: null })),
    },
    { maxParticipants: 8, id },
  );
const prior = (dir: string, session: Session, ds: ParticipantDriver[]) =>
  runStoredSession({ session, drivers: Object.fromEntries(ds.map((d, i) => [`p${i + 1}`, d])), dataDir: dir });
const journal = (dir: string, id: string) => readFileSync(eventsPath(dir, id), "utf8");
const events = (dir: string, id: string) => readEvents(dir, id)!.events;
const scenarioFile = (dir: string, name: string, steps: Step[]) => {
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
};

// no_consensus: p1 amends v1, p2 objects; on continuation both agree.
async function noConsensus(dir: string, id = "s") {
  const f1 = scenarioFile(dir, `${id}-p1`, [amend("v1"), agree()]);
  const f2 = scenarioFile(dir, `${id}-p2`, [object(), agree()]);
  await prior(dir, mk(id, [f1, f2]), [scripted(amend("v1")), scripted(object())]);
}
// Session with a finished result, version 1 exists.
async function finished(dir: string, id: string, steps: [Step[], Step[]]) {
  await prior(dir, mk(id), [scripted(...steps[0]), scripted(...steps[1])]);
}

const reasonOf = (fn: () => unknown): OwnerSelectionRejection | undefined => {
  try { fn(); } catch (e) { if (e instanceof OwnerSelectionRejectedError) return e.reason; throw e; }
  return undefined;
};
const msgOf = (fn: () => unknown): string => { try { fn(); } catch (e) { return (e as Error).message; } return ""; };
const sel = (dir: string, version: number, note?: string | null, id = "s") =>
  selectOwnerVersion(dir, id, { version, note }, { isAlive: dead });
const selEvents = (dir: string, id = "s") => events(dir, id).filter((e) => e.type === "owner_selected_version");

describe("selectOwnerVersion: success", () => {
  it("with note: one event, journal prefix, status unchanged, no lock", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const before = journal(dir, "s");
    const last = events(dir, "s").at(-1)!;
    const res = selectOwnerVersion(dir, "s", { version: 1, note: "  беру v1  " }, { isAlive: dead, now: () => new Date("2026-05-05T10:00:00Z") });
    expect(res).toEqual({ version: 1, statusAtSelection: "no_consensus", note: "беру v1", ts: "2026-05-05T10:00:00.000Z" });
    const after = journal(dir, "s");
    expect(after.startsWith(before)).toBe(true);
    expect(events(dir, "s").at(-1)).toMatchObject({ type: "owner_selected_version", seq: last.seq + 1, statusAtSelection: "no_consensus", note: "беру v1", version: 1 });
    expect(after.slice(before.length).trim().split("\n")).toHaveLength(1);
    const s = readSession(dir, "s", dead)!;
    expect(s.status).toBe("no_consensus");
    expect(s.state.ownerSelection).toEqual(res);
    expect(events(dir, "s").filter((e) => e.type === "turn_started")).toHaveLength(2);
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
  });

  it("without note and with spaces: no note key, note: null", async () => {
    const dir = tmp();
    await noConsensus(dir);
    expect(sel(dir, 1).note).toBeNull();
    expect(sel(dir, 1, "   ", "s").note).toBeNull();
    expect(sel(dir, 1, null).note).toBeNull();
    const evs = selEvents(dir);
    expect(evs).toHaveLength(1);
    expect("note" in evs[0]!).toBe(false);
  });

  it("outcomes consensus, stopped, failed with an existing version", async () => {
    const dir = tmp();
    await finished(dir, "c", [[amend("v1"), agree()], [agree(), agree()]]);
    expect(sel(dir, 1, undefined, "c").statusAtSelection).toBe("consensus");

    const ac = new AbortController();
    const stopper: ParticipantDriver = { call: () => (ac.abort(), new Promise<never>(() => {})) };
    await runStoredSession({ session: mk("st"), drivers: { p1: scripted(amend("v1")), p2: stopper }, dataDir: dir, signal: ac.signal });
    expect(readSession(dir, "st", dead)!.status).toBe("stopped");
    expect(sel(dir, 1, undefined, "st").statusAtSelection).toBe("stopped");

    await finished(dir, "f", [[amend("v1"), amend("v2")], [fatal, fatal]]);
    const fs = readSession(dir, "f", dead)!;
    expect(fs.status).toBe("failed");
    expect(fs.state.versions.length).toBeGreaterThan(0);
    expect(sel(dir, 1, undefined, "f").statusAtSelection).toBe("failed");
  });
});

describe("selectOwnerVersion: refusals", () => {
  const unchanged = (dir: string, fn: () => unknown, reason: OwnerSelectionRejection, id = "s") => {
    const before = journal(dir, id);
    expect(reasonOf(fn)).toBe(reason);
    expect(journal(dir, id)).toBe(before);
    expect(existsSync(resumeLockPath(dir, id))).toBe(false);
  };

  it("not_found, unknown_version, bad_note, corrupted", async () => {
    const dir = tmp();
    await noConsensus(dir);
    expect(reasonOf(() => sel(dir, 1, undefined, "nope"))).toBe("not_found");
    expect(reasonOf(() => sel(dir, 1, undefined, "../x"))).toBe("not_found");
    unchanged(dir, () => sel(dir, 9), "unknown_version");
    unchanged(dir, () => sel(dir, 0), "unknown_version");
    unchanged(dir, () => sel(dir, 1.5), "unknown_version");
    expect(msgOf(() => sel(dir, 9))).toBe("В сессии s нет версии 9.");
    unchanged(dir, () => sel(dir, 1, "x".repeat(OWNER_NOTE_MAX + 1)), "bad_note");
    expect(sel(dir, 1, "x".repeat(OWNER_NOTE_MAX)).note).toHaveLength(OWNER_NOTE_MAX);
    appendFileSync(eventsPath(dir, "s"), '{"seq":');
    unchanged(dir, () => sel(dir, 1), "corrupted");
    expect(msgOf(() => sel(dir, 1))).toContain("выбор версии невозможен.");
  });

  it("whole journal accepted, incomplete tail gives corrupted (no seam for growth between read and check)", async () => {
    const dir = tmp();
    await noConsensus(dir);
    expect(sel(dir, 1).version).toBe(1);
    appendFileSync(eventsPath(dir, "s"), '{"seq":');
    expect(reasonOf(() => sel(dir, 1))).toBe("corrupted");
  });

  it("newer_version: code, text without words about damage, no journal, no lock, no selection events", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const n = events(dir, "s").length;
    appendFileSync(eventsPath(dir, "s"), JSON.stringify({ seq: n + 1, ts: "2026-01-01T00:00:00.000Z", type: "future_event" }) + "\n");
    unchanged(dir, () => sel(dir, 1), "newer_version");
    expect(msgOf(() => sel(dir, 1)))
      .toBe(`Сессия s: журнал записан более новой версией, прочитан до события №${n}; выбор версии невозможен. Обновите приложение.`);
    expect(selEvents(dir)).toEqual([]);
  });

  it("running and interrupted", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const evs = events(dir, "s");
    const cut = evs.findIndex((e) => e.type === "turn_completed");
    writeFileSync(eventsPath(dir, "s"), evs.slice(0, cut + 1).map((e, i) => (i === 0 ? { ...e, pid: 1 } : e)).map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(readSession(dir, "s", dead)?.status).toBe("interrupted");
    unchanged(dir, () => selectOwnerVersion(dir, "s", { version: 1 }, { isAlive: alive }), "running");
    unchanged(dir, () => selectOwnerVersion(dir, "s", { version: 1 }, { isAlive: dead }), "interrupted");
  });

  it("failure without versions: unknown_version about the absence of versions", async () => {
    const dir = tmp();
    await finished(dir, "f", [[fatal], [fatal]]);
    const s = readSession(dir, "f", dead)!;
    expect(s.status).toBe("failed");
    expect(s.state.versions).toEqual([]);
    unchanged(dir, () => sel(dir, 1, undefined, "f"), "unknown_version", "f");
    expect(msgOf(() => sel(dir, 1, undefined, "f"))).toBe("В сессии f нет ни одной версии решения: выбирать нечего.");
  });
});

describe("selectOwnerVersion: repeats", () => {
  it("same selection is idempotent, another adds an event", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const first = sel(dir, 1, "а");
    const bytes = journal(dir, "s");
    expect(sel(dir, 1, " а ")).toEqual(first);
    expect(journal(dir, "s")).toBe(bytes);
    expect(sel(dir, 1, "б").note).toBe("б");
    expect(sel(dir, 1).note).toBeNull();
    expect(selEvents(dir)).toHaveLength(3);
    expect(readSession(dir, "s", dead)!.state.ownerSelection).toMatchObject({ version: 1, note: null });
  });
});

describe("selectOwnerVersion: lock", () => {
  it("live foreign lock: busy, journal and lock in place; stale one is removed", async () => {
    const dir = tmp();
    await noConsensus(dir);
    writeFileSync(resumeLockPath(dir, "s"), "4242");
    const before = journal(dir, "s");
    expect(reasonOf(() => selectOwnerVersion(dir, "s", { version: 1 }, { isAlive: alive }))).toBe("busy");
    expect(journal(dir, "s")).toBe(before);
    expect(readFileSync(resumeLockPath(dir, "s"), "utf8")).toBe("4242");
    expect(msgOf(() => selectOwnerVersion(dir, "s", { version: 1 }, { isAlive: alive }))).toBe("Сессию s сейчас продолжает другой процесс: выбор не записан.");

    rmSync(resumeLockPath(dir, "s"));
    writeFileSync(resumeLockPath(dir, "s"), "999999");
    expect(sel(dir, 1).version).toBe(1);
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
  });
});

describe("selection and continuation", () => {
  const go = async (dir: string, plan: ResumePlan) => {
    const { drivers } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
    const calls: string[] = [];
    const wrapped = Object.fromEntries(Object.entries(drivers).map(([k, d]) => [k, { call: (r: Parameters<ParticipantDriver["call"]>[0]) => (calls.push(k), d.call(r)) }])) as typeof drivers;
    const run = await runResumedSession({ dataDir: dir, plan, drivers: wrapped, isAlive: dead });
    return { run, calls };
  };

  it("selection, then continuation: prefix, selection kept, only continuation calls models", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const res = sel(dir, 1, "до продолжения");
    const upToSelection = journal(dir, "s");
    const { calls } = await go(dir, planResume(dir, "s", { rounds: 1, isAlive: dead }));
    expect(journal(dir, "s").startsWith(upToSelection)).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    const after = events(dir, "s");
    expect(after.filter((e) => e.type === "turn_started")).toHaveLength(2 + calls.length);
    const s = readSession(dir, "s", dead)!;
    expect(s.status).toBe("consensus");
    expect(s.state.ownerSelection).toEqual(res);
  });

  it("plan before selection, after selection — rejected busy", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    sel(dir, 1);
    const before = journal(dir, "s");
    const { drivers } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
    await expect(runResumedSession({ dataDir: dir, plan, drivers, isAlive: dead })).rejects.toSatisfy(
      (e) => e instanceof ResumeRejectedError && e.reason === "busy",
    );
    expect(journal(dir, "s")).toBe(before);
  });

  it("while continuation is running, selection is refused", async () => {
    const dir = tmp();
    await noConsensus(dir);
    const plan = planResume(dir, "s", { rounds: 1, isAlive: dead });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });
    const slow: ParticipantDriver = { call: async (r) => { started(); await gate; return scripted(agree()).call(r); } };
    const running = runResumedSession({ dataDir: dir, plan, drivers: { p1: slow, p2: scripted(agree()) } });
    await hasStarted;
    const before = journal(dir, "s");
    expect(reasonOf(() => selectOwnerVersion(dir, "s", { version: 1 }))).toBe("running");
    expect(journal(dir, "s")).toBe(before);
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(true);
    release();
    await running;
    expect(selEvents(dir)).toHaveLength(0);
  });
});
