import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createSessionJournal, eventsPath } from "./journal.ts";
import { listSessions, markRunningHere, readSession, unmarkRunningHere } from "./sessions.ts";
import type { Session, SessionEvent } from "../protocol/schema.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ts = "2026-01-01T00:00:00Z";
const session = (id: string): Session => ({
  id, createdAt: ts, origin: "cli", topic: "t", templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
});
const turn = (n: number, seq: number): SessionEvent[] => [
  { seq, ts, type: "turn_started", turn: n, round: 1, participantId: `p${(n % 2) + 1}` },
  {
    seq: seq + 1, ts, type: "turn_completed", turn: n, round: 1, participantId: `p${(n % 2) + 1}`, stance: "agree", normalized: false,
    reasoning: "ok", solution: null, version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
  },
];
const finished = (seq: number): SessionEvent => ({ seq, ts, type: "session_finished", status: "no_consensus", version: 1, agreed: [], objectors: [] });

interface Case {
  events: SessionEvent[]; lastPid: number; finishedAfterLastStart: boolean;
  alive: boolean; ops: Array<["mark" | "unmark", "self" | "other"]>;
}
const SELF = process.pid;

function generate(seed: number, id: string): Case {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pidOf = () => (rnd() < 0.5 ? SELF : [1, 4242, 999999][int(3)]!);
  let pid = pidOf();
  const events: SessionEvent[] = [{ seq: 1, ts, type: "session_created", session: session(id), pid }];
  const turns = int(4); // 0 — journal of a single session_created
  for (let i = 1; i <= turns; i++) events.push(...turn(i, events.length + 1).map((e, k) => ({ ...e, seq: events.length + 1 + k }) as SessionEvent));
  let fin = false;
  if (rnd() < 0.5) { events.push(finished(events.length + 1)); fin = true; }
  if (rnd() < 0.4) { // continuation: new pid, the previous run's result no longer counts
    pid = pidOf();
    events.push({ seq: events.length + 1, ts, type: "session_resumed", pid, maxRounds: 3 });
    fin = false;
    if (rnd() < 0.3) { events.push(finished(events.length + 1)); fin = true; }
  }
  const ops: Case["ops"] = Array.from({ length: int(8) }, () => [rnd() < 0.5 ? "mark" : "unmark", rnd() < 0.7 ? "self" : "other"]);
  // a live executor of this process is alive by definition; a foreign one — by the substituted isAlive
  const alive = pid === SELF ? true : rnd() < 0.5;
  return { events, lastPid: pid, finishedAfterLastStart: fin, alive, ops };
}

const dirs: string[] = [];
afterEach(() => { unmarkRunningHere("other"); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("Interrupted session: status invariant for any registries and pid", () => {
  it("interrupted ⇔ no result after the last start AND (own pid without registry OR foreign pid not alive)", () => {
    const dir = mkdtempSync(join(tmpdir(), "council-prop-"));
    dirs.push(dir);
    for (let seed = 1; seed <= 150; seed++) {
      const sid = `s${seed}`;
      const c = generate(seed, sid);
      createSessionJournal(dir, sid);
      for (const e of c.events) appendEvent(dir, sid, e);
      const inRegistry = new Set<string>();
      for (const [op, who] of c.ops) {
        const rid = who === "self" ? sid : "other";
        if (op === "mark") { markRunningHere(rid); inRegistry.add(rid); } else { unmarkRunningHere(rid); inRegistry.delete(rid); }
      }
      const isAlive = () => c.alive;
      const before = readFileSync(eventsPath(dir, sid), "utf8");
      const expectInterrupted = !c.finishedAfterLastStart &&
        ((c.lastPid === SELF && !inRegistry.has(sid)) || (c.lastPid !== SELF && !c.alive));
      const got = readSession(dir, sid, isAlive)!;
      const msg = `seed ${seed} pid ${c.lastPid} alive ${c.alive} registry ${inRegistry.has(sid)} finished ${c.finishedAfterLastStart}`;
      expect(got.status === "interrupted", msg).toBe(expectInterrupted);
      if (!c.finishedAfterLastStart && !expectInterrupted) expect(got.status, msg).toBe("running");
      if (c.finishedAfterLastStart) expect(got.status, msg).toBe("no_consensus");
      expect(listSessions(dir, isAlive).find((s) => s.id === sid)!.status, msg).toBe(got.status);
      expect(readFileSync(eventsPath(dir, sid), "utf8"), msg).toBe(before);
      unmarkRunningHere(sid);
      unmarkRunningHere("other");
    }
  }, 30000);

  it("repeat entry after exit: mark, unmark, mark again — running; after the last unmark — interrupted", () => {
    const dir = mkdtempSync(join(tmpdir(), "council-prop-"));
    dirs.push(dir);
    createSessionJournal(dir, "r");
    appendEvent(dir, "r", { seq: 1, ts, type: "session_created", session: session("r"), pid: SELF });
    const st = () => readSession(dir, "r")!.status;
    expect(st()).toBe("interrupted");
    markRunningHere("r"); expect(st()).toBe("running");
    unmarkRunningHere("r"); expect(st()).toBe("interrupted");
    markRunningHere("r"); expect(st()).toBe("running");
    unmarkRunningHere("r"); unmarkRunningHere("r"); expect(st()).toBe("interrupted");
  });
});
