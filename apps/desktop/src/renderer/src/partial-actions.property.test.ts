import { describe, expect, it } from "vitest";
import type { StoredStatus } from "@model-council/core";
import { sessionActions } from "./partial-actions.ts";
import type { ActionInput } from "./partial-actions.ts";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES: StoredStatus[] = ["running", "consensus", "no_consensus", "stopped", "failed", "interrupted"];
const WHOLE_SESSION_EVENTS = 100000; // boundary: N equals the number of events of the whole session

function generate(seed: number): { input: ActionInput; n: number } {
  const rnd = mulberry32(seed);
  const int = (k: number) => Math.floor(rnd() * k);
  const n = seed % 7 === 0 ? 0 : seed % 7 === 1 ? WHOLE_SESSION_EVENTS : int(WHOLE_SESSION_EVENTS + 1);
  return {
    n,
    input: {
      status: STATUSES[seed % STATUSES.length]!, // each status is guaranteed to occur
      partial: { reason: int(2) === 0 ? "newer_version" : "corrupted", lastEvent: n },
      waiting: rnd() < 0.5, hasVersion: rnd() < 0.5, finished: rnd() < 0.5, insufficientActive: rnd() < 0.5,
    },
  };
}

describe("session with a journal read only partially: mutating actions are unavailable, stop is available", () => {
  it("for 600 seeds: reply, answer, continueWait, resume, select are closed; the reason names N; stop as without partial", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 600; seed++) {
      const { input, n } = generate(seed);
      seen.add(`${input.status}/${input.partial!.reason}`);
      const a = sessionActions(input);
      const label = `seed ${seed} ${JSON.stringify(input)}`;
      expect([a.reply, a.answer, a.continueWait, a.resume, a.select], label).toEqual([false, false, false, false, false]);
      expect(a.reason, label).toContain(String(n));
      expect(a.stop, label).toBe(sessionActions({ ...input, partial: null }).stop);
      for (const language of ["ru", "en"] as const) expect(sessionActions(input, language).reason).toContain(String(n));
    }
    expect(seen.size).toBe(STATUSES.length * 2);
  });
  it("without partial the old rules apply, no reason", () => {
    const base: ActionInput = { status: "running", partial: null, waiting: true, hasVersion: true, finished: false, insufficientActive: false };
    expect(sessionActions(base)).toEqual({ reply: true, answer: true, continueWait: true, resume: false, select: false, stop: true, reason: null });
    expect(sessionActions({ ...base, status: "stopped", finished: true })).toMatchObject({ resume: true, select: true, stop: false, reason: null });
    expect(sessionActions({ ...base, status: "failed", insufficientActive: true }).resume).toBe(true);
    expect(sessionActions({ ...base, status: "failed" }).resume).toBe(false);
  });
});
