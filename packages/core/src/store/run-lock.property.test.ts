import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession } from "../engine.ts";
import { createScriptedDriver, readScenario } from "../participants/scripted.ts";
import type { ParticipantDriver } from "../participants/driver.ts";
import { eventsPath, resumeLockPath, SessionExistsError, sessionDir } from "./journal.ts";
import { runStoredSession } from "./run.ts";
import { ResumeRejectedError, acquireResumeLock } from "./resume.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const scenarios = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scenarios", "consensus");
const DEAD = 999999; // the pid the isAlive stub considers dead
const isAlive = (pid: number) => pid !== DEAD;
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const mk = (id: string) =>
  createSession(
    {
      topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000 },
      participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id },
  );

interface Runner { run: Promise<unknown>; release: () => void; dead: boolean }
interface Model { runner?: Runner; holder: boolean }

async function gatedStart(dir: string, id: string): Promise<Runner> {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const hasStarted = new Promise<void>((r) => { started = r; });
  const env = { COUNCIL_DEV: "1" };
  const p1 = createScriptedDriver(await readScenario(join(scenarios, "p1.json")), env);
  const p2 = createScriptedDriver(await readScenario(join(scenarios, "p2.json")), env);
  const slow: ParticipantDriver = { call: async (r) => { started(); await gate; return p1.call(r); } };
  const run = runStoredSession({ session: mk(id), drivers: { p1: slow, p2 }, dataDir: dir, isAlive });
  await hasStarted;
  return { run, release, dead: false };
}

const bytes = (dir: string, id: string) => (existsSync(eventsPath(dir, id)) ? readFileSync(eventsPath(dir, id)) : null);
const lockText = (dir: string, id: string) => (existsSync(resumeLockPath(dir, id)) ? readFileSync(resumeLockPath(dir, id), "utf8").trim() : null);

async function scenario(seed: number): Promise<void> {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const dir = mkdtempSync(join(tmpdir(), "council-lock-"));
  dirs.push(dir);
  const ids = Array.from({ length: 1 + int(2) }, (_, i) => `s${i + 1}`);
  const model = new Map<string, Model>(ids.map((id) => [id, { holder: false }]));
  // boundary states: a folder with a stale lock, or with the lock of a live foreign pid (no executor of ours)
  const foreign = new Set<string>();
  for (const id of ids) {
    const mode = int(4);
    if (mode === 1 || mode === 2) {
      mkdirSync(sessionDir(dir, id), { recursive: true });
      writeFileSync(resumeLockPath(dir, id), mode === 1 ? String(DEAD) : "1");
      if (mode === 2) foreign.add(id);
    }
  }
  const believers = (id: string) => {
    const m = model.get(id)!;
    return (m.runner && !m.runner.dead ? 1 : 0) + (m.holder ? 1 : 0);
  };
  const finish = async (id: string) => {
    const m = model.get(id)!;
    if (!m.runner) return;
    m.runner.release();
    await m.runner.run;
    m.runner = undefined;
  };

  for (let step = 0; step < 30; step++) {
    const id = ids[int(ids.length)]!;
    const m = model.get(id)!;
    const before = bytes(dir, id);
    const op = int(5);
    if (op === 0) { // start
      if (existsSync(sessionDir(dir, id))) {
        const lock = lockText(dir, id);
        await expect(runStoredSession({ session: mk(id), drivers: {}, dataDir: dir, isAlive })).rejects.toBeInstanceOf(SessionExistsError);
        expect(bytes(dir, id)).toEqual(before);
        expect(lockText(dir, id)).toBe(lock);
      } else {
        m.runner = await gatedStart(dir, id);
        expect(lockText(dir, id)).toBe(String(process.pid));
      }
    } else if (op === 1 && existsSync(sessionDir(dir, id))) { // resume attempt (planning has already required the folder)
      const live = believers(id) > 0 || foreign.has(id);
      let err: unknown = null;
      try { acquireResumeLock(resumeLockPath(dir, id), isAlive); } catch (e) { err = e; }
      if (live) {
        expect(err).toBeInstanceOf(ResumeRejectedError);
        expect((err as ResumeRejectedError).reason).toBe("busy");
        expect(bytes(dir, id)).toEqual(before);
      } else {
        expect(err).toBeNull();
        m.holder = true;
      }
    } else if (op === 2) { // the resume holder ends
      if (m.holder) {
        if (lockText(dir, id) === String(process.pid)) rmSync(resumeLockPath(dir, id), { force: true });
        m.holder = false;
      }
    } else if (op === 3) { // the started executor ends (release stands for both stop and normal end)
      if (m.runner) {
        const dead = m.runner.dead;
        const foreignLock = lockText(dir, id);
        await finish(id);
        // a normal end removes its lock; after a forced end the foreign pid left there stays untouched
        if (!dead && !m.holder) expect(lockText(dir, id)).toBeNull();
        // a taker in this same process has our pid, so the dead executor legitimately removes that lock (model limit: one pid)
        if (dead && foreignLock === String(process.pid)) m.holder = false;
        else if (dead) expect(lockText(dir, id)).toBe(foreignLock);
      }
    } else if (m.runner && !m.runner.dead && !m.holder) { // forced end: the executor "died", its lock holds a dead pid
      writeFileSync(resumeLockPath(dir, id), String(DEAD));
      m.runner.dead = true;
    }
    for (const x of ids) expect(believers(x), `Executor lock at session start: seed ${seed} step ${step}`).toBeLessThanOrEqual(1);
  }
  for (const id of ids) await finish(id);
}

describe("Executor lock at session start (property)", () => {
  it("at most one live executor per session over random start, resume, end and forced-end sequences", async () => {
    for (let seed = 1; seed <= 60; seed++) await scenario(seed);
  }, 30000);
});
