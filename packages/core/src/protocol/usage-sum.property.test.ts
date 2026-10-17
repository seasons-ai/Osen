import { describe, expect, it } from "vitest";
import { createSession, runSession } from "../engine.ts";
import { sha256Of } from "../materials.ts";
import { ParticipantCallError } from "../participants/driver.ts";
import type { ParticipantDriver, TurnRequest, TurnResult } from "../participants/driver.ts";
import { foldEvents } from "./fold.ts";
import type { SessionEvent, Usage } from "./schema.ts";
import { tokenUsage } from "./state.ts";
import { sessionUsage } from "./usage.ts";

// The real engine with random participants: the reference is the usage of each returned call, counted exactly once.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WS = [{ name: "proj/a.txt", text: "содержимое" }];
const answer = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ stance: "amend", reasoning: "r", solution: "S", answers: [], questions: [], ...extra });
const tokensOf = (u: Usage) => (u.inputTokens ?? 0) + (u.outputTokens ?? 0);

interface Run { events: SessionEvent[]; truth: number; cuts: number }

async function play(seed: number): Promise<Run> {
  const rnd = mulberry32(seed), int = (k: number) => Math.floor(rnd() * k);
  const n = 2 + int(3);
  const drafts = rnd() < 0.5;
  const session = createSession(
    {
      topic: "Тема", framing: "", origin: "cli", workspace: WS,
      limits: { maxRounds: 1 + int(2), turnTimeoutSec: 30, contextChars: 20000 },
      ...(drafts ? { drafts: { synthesizerId: "p1" } } : {}),
      participants: Array.from({ length: n }, (_, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id: "s1", now: () => new Date("2026-01-01T00:00:00Z") },
  );
  let truth = 0, cuts = 0, stop = new AbortController();
  const usage = (): Usage => {
    const x = rnd();
    if (x < 0.15) return {};
    if (x < 0.25) return { inputTokens: int(100) };
    return { inputTokens: int(100), outputTokens: int(100) };
  };
  const driver: ParticipantDriver = {
    call: (req: TurnRequest): Promise<TurnResult> => {
      const x = rnd();
      // stop during a call: outcome unknown, usage not reported
      if (x < 0.08 && cuts < 3) {
        cuts++;
        const p = new Promise<TurnResult>((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("abort")), { once: true }));
        queueMicrotask(() => stop.abort());
        return p;
      }
      if (x < 0.2) return Promise.reject(new ParticipantCallError("call_error", "сбой", true));
      const u = usage();
      truth += tokensOf(u);
      const text = x < 0.45 ? answer({ files: ["proj/a.txt"] }) : x < 0.65 ? "не JSON" : answer();
      return Promise.resolve({ text, usage: u });
    },
  };
  const drivers = Object.fromEntries(session.participants.map((p) => [p.id, driver]));
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1) + (tick += 10));
  const texts = new Map<string, string>(); // draft texts survive the continuation
  const draftStore = {
    save: (id: string, text: string) => (texts.set(id, text), { chars: text.length, sha256: sha256Of(text) }),
    load: ({ draftId }: { draftId: string }) => texts.get(draftId)!,
  };
  const events: SessionEvent[] = [];
  for (let seg = 0; seg < 5; seg++) {
    const run = await runSession({
      session, drivers, now, workspace: WS, signal: stop.signal, draftStore,
      ...(events.length ? { resume: { events: [...events], maxRounds: session.limits.maxRounds } } : {}),
    });
    events.push(...run.events);
    if (!stop.signal.aborted) break;
    stop = new AbortController();
  }
  return { events, truth, cuts };
}

describe("Requirement: Total session usage (property)", () => {
  it("300 random sessions of the real engine: tokenUsage = sum of sessionUsage entries = usage of all returned calls", async () => {
    const seen = { prevSegFailure: 0, draftServedAcross: 0, turnServedLost: 0, three: 0, noUsage: 0, cut: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const { events, truth, cuts } = await play(seed);
      const ctx = `seed ${seed}`;
      const u = tokenUsage(foldEvents(events));
      const su = sessionUsage(events);
      expect(u.total, ctx).toBe(su.records.reduce((a, r) => a + tokensOf(r.usage), 0));
      expect(u.incomplete, ctx).toBe(su.open.length > 0 || su.records.some((r) => r.usage.inputTokens === undefined && r.usage.outputTokens === undefined));
      expect(u.total, ctx).toBe(truth);
      if (cuts > 0) expect(u.incomplete, `${ctx}: оборванный вызов`).toBe(true);

      // bounds the generator reached
      if (cuts > 0) seen.cut++;
      let seg = 0;
      const failSeg = new Map<number, number>(), servedSeg = new Map<string, number>();
      for (const e of events) {
        if (e.type === "session_resumed") seg++;
        else if (e.type === "turn_failed" && e.usage) failSeg.set(e.turn, seg);
        else if (e.type === "draft_files_served") servedSeg.set(e.draftId, seg);
        else if (e.type === "turn_completed") {
          if ((failSeg.get(e.turn) ?? seg) < seg) seen.prevSegFailure++;
          if (e.attempts === 3) seen.three++;
          if (e.usage.inputTokens === undefined && e.usage.outputTokens === undefined) seen.noUsage++;
        } else if (e.type === "draft_completed" && (servedSeg.get(e.draftId) ?? seg) < seg) seen.draftServedAcross++;
      }
      // file request in a turn not completed after it
      for (const e of events) if (e.type === "turn_files_served" && !events.some((d) => d.type === "turn_completed" && d.turn === e.turn && d.seq > e.seq)) seen.turnServedLost++;
    }
    for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(0);
  });
});
