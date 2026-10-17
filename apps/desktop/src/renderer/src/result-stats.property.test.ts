import { describe, expect, it } from "vitest";
import { foldEvents, sessionUsage, tokenUsage } from "@model-council/core/protocol";
import type { SessionEvent } from "@model-council/core/protocol";
import { resultStats } from "./Result.tsx";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Journal: failures with and without spending, departure after failures, segments up to session_resumed, a draft without draft_completed.
function generate(seed: number): SessionEvent[] {
  const rnd = mulberry32(seed), int = (n: number) => Math.floor(rnd() * n);
  const n = 2 + int(3), ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const mode = int(4); // 0 — anyone reports tokens, 1 — nobody, 2 — cost only for some, 3 — same as 0
  const usage = () => {
    const x = rnd();
    if (mode === 1 || x < 0.2) return {};
    const u: Record<string, number> = x < 0.4 ? { inputTokens: int(100) } : { inputTokens: int(100), outputTokens: int(100) };
    if (mode === 2 ? rnd() < 0.3 : rnd() < 0.5) u.costUsd = int(10) / 10;
    return u;
  };
  // aggregate of a completed slot includes the spending of its failed attempts (engine contract)
  const add = (a: Record<string, number>, u: Record<string, number>) => { for (const k of Object.keys(u)) a[k] = (a[k] ?? 0) + u[k]!; return a; };
  const b: Body[] = [{
    type: "session_created", pid: 1,
    session: {
      id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "t", templateId: null, framing: "",
      participants: ids.map((id) => ({ id, name: id, providerId: "scripted", model: "m", role: null })),
      limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 },
    },
  } as Body];
  let turn = 0;
  const alive = [...ids];
  for (let seg = 0, segs = 1 + int(3); seg < segs; seg++) {
    if (seg) b.push({ type: "session_resumed", pid: 2 + seg, maxRounds: 6 } as Body);
    if (rnd() < 0.4) {
      const draftId = `d${seg}`, who = ids[int(n)]!;
      b.push({ type: "draft_attempt_started", draftId, participantId: who, attempt: 1 } as Body);
      const fu = rnd() < 0.7 ? usage() : undefined, agg: Record<string, number> = { ...fu };
      b.push({ type: "draft_attempt_failed", draftId, participantId: who, attempt: 1, kind: "invalid_response", message: "x", ...(fu ? { usage: fu } : {}) } as Body);
      if (rnd() < 0.5) {
        b.push({ type: "draft_attempt_started", draftId, participantId: who, attempt: 2 } as Body);
        b.push({ type: "draft_completed", draftId, participantId: who, attempts: 2, durationMs: 5, usage: add(agg, usage()), chars: 5, sha256: "a".repeat(64), reasoning: "r" } as Body);
      }
    }
    for (let k = 0, ks = 1 + int(4); k < ks && alive.length > 1; k++) {
      const who = alive[int(alive.length)]!;
      turn++;
      b.push({ type: "turn_started", turn, round: 1, participantId: who });
      const agg: Record<string, number> = {};
      for (let a = 1, fails = int(3); a <= fails; a++) {
        const fu = rnd() < 0.8 ? usage() : undefined;
        if (fu) add(agg, fu);
        b.push({ type: "turn_failed", turn, round: 1, participantId: who, attempt: a, kind: "invalid_response", message: "x", ...(fu ? { usage: fu } : {}) } as Body);
      }
      if (rnd() < 0.3) { b.push({ type: "participant_dropped", participantId: who, reason: "сбои" }); alive.splice(alive.indexOf(who), 1); continue; }
      b.push({ type: "turn_completed", turn, round: 1, participantId: who, stance: "amend", normalized: false, reasoning: "r", solution: "S", version: turn, questions: [], answers: [], attempts: 1, usage: add(agg, usage()), durationMs: 5 } as Body);
    }
  }
  return b.map((x, i) => ({ ...x, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);
}

describe("Requirement: result statistics come from the core (property)", () => {
  it("Statistics: 300 random journals — tokens = tokenUsage, sources include participants of failed attempts", () => {
    const seen = { nobody: 0, failedSource: 0, resumed: 0, partial: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const events = generate(seed), s = foldEvents(events), ctx = `seed ${seed}`;
      const { records } = sessionUsage(events);
      const got = records.filter((r) => r.usage.inputTokens !== undefined || r.usage.outputTokens !== undefined);
      const r = resultStats(s), u = tokenUsage(s);
      expect(r.tokens, ctx).toBe(got.length ? u.total : null);
      if (r.tokens !== null) expect(r.tokensPartial, ctx).toBe(u.incomplete);
      // a participant of any event with tokens must be in the sources (spending of failed attempts is part of the turn aggregate)
      for (const e of events) {
        if ((e.type === "turn_failed" || e.type === "turn_files_served" || e.type === "draft_attempt_failed" || e.type === "draft_files_served") && (e.usage?.inputTokens !== undefined || e.usage?.outputTokens !== undefined)) {
          expect(r.tokensFrom, `${ctx}: ${e.type} ${e.participantId}`).toContain(e.participantId);
          seen.failedSource++;
        }
      }
      if (got.length === 0) seen.nobody++;
      if (events.some((e) => e.type === "session_resumed")) seen.resumed++;
      if (r.tokensPartial) seen.partial++;
    }
    for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(0);
  });
});
