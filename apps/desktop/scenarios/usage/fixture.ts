// Fixture journals of the usage summary and the expectations table (the numbers are written by hand, not computed from the journals).
import { appendEvent, createSessionJournal, eventsPath, SessionEventSchema, sessionsDir } from "../../../../packages/core/src/index.ts";
import type { Session, SessionEvent, Usage } from "../../../../packages/core/src/index.ts";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
type At = Body & { at: string };

const created = (id: string, providers: Record<string, string>, createdAt: string, drafts?: string): At => ({
  at: createdAt, type: "session_created", pid: 1,
  session: {
    id, createdAt, origin: "cli", topic: `Тема ${id}`, templateId: null, framing: "",
    participants: Object.entries(providers).map(([pid, providerId]) => ({ id: pid, name: pid, providerId, model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    ...(drafts ? { drafts: { enabled: true as const, synthesizerId: drafts } } : {}),
  } satisfies Session,
});
export const started = (at: string, turn: number, participantId: string): At => ({ at, type: "turn_started", turn, round: 1, participantId });
export const done = (at: string, turn: number, usage: Usage, participantId: string, attempts = 1): At => ({
  at, type: "turn_completed", turn, round: 1, participantId, stance: "agree", normalized: false, reasoning: "r", solution: null,
  version: 1, questions: [], answers: [], attempts, usage, durationMs: 1,
});
const failed = (at: string, turn: number, participantId: string, attempt: number, usage?: Usage): At => ({
  at, type: "turn_failed", turn, round: 1, participantId, attempt, kind: "invalid_response", message: "m", ...(usage ? { usage } : {}),
});
const dropped = (at: string, participantId: string): At => ({ at, type: "participant_dropped", participantId, reason: "x" });
const dStart = (at: string, draftId: string, participantId: string, attempt: number): At => ({ at, type: "draft_attempt_started", draftId, participantId, attempt });
const dFail = (at: string, draftId: string, participantId: string, attempt: number, usage: Usage): At => ({
  at, type: "draft_attempt_failed", draftId, participantId, attempt, kind: "timeout", message: "m", usage,
});
const dDone = (at: string, draftId: string, participantId: string, usage: Usage, attempts: number): At => ({
  at, type: "draft_completed", draftId, participantId, attempts, durationMs: 1, usage, chars: 1, sha256: "0".repeat(64), reasoning: "r",
});
const finish = (at: string): At => ({ at, type: "session_finished", status: "consensus", version: 1, agreed: [], objectors: [] });

export const IDS = { A: "usage-a", B: "usage-b", C: "usage-c", D: "usage-d", E: "usage-e", F: "usage-f", G: "usage-g", H: "usage-h" } as const;
export const LISTED = [IDS.A, IDS.B, IDS.C, IDS.D, IDS.F, IDS.G, IDS.H];

const JOURNALS: Record<string, At[]> = {
  [IDS.A]: [
    created(IDS.A, { p1: "alpha", p2: "beta" }, "2026-10-08T20:00:00Z"),
    started("2026-10-08T20:50:00Z", 1, "p1"),
    done("2026-10-08T20:59:59Z", 1, { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, "p1"),
    started("2026-10-08T20:59:00Z", 2, "p2"),
    failed("2026-10-08T20:59:59Z", 2, "p2", 1, { inputTokens: 6, outputTokens: 4 }),
    done("2026-10-08T21:00:00Z", 2, { inputTokens: 20, outputTokens: 10, costUsd: 0 }, "p2", 2),
    finish("2026-10-08T21:00:30Z"),
  ],
  [IDS.B]: [
    created(IDS.B, { p1: "alpha", p2: "gone-llm" }, "2026-10-09T08:00:00Z", "p1"),
    dStart("2026-10-09T08:00:05Z", "d1", "p1", 1),
    dFail("2026-10-09T08:00:10Z", "d1", "p1", 1, { inputTokens: 4, outputTokens: 3 }),
    dStart("2026-10-09T08:00:20Z", "d1", "p1", 2),
    dDone("2026-10-09T08:00:30Z", "d1", "p1", { inputTokens: 16, outputTokens: 12, costUsd: 0.02 }, 2),
    dStart("2026-10-09T08:00:40Z", "d2", "p2", 1),
  ],
  [IDS.C]: [
    created(IDS.C, { p1: "beta", p2: "gone-llm" }, "2026-10-09T08:55:00Z"),
    started("2026-10-09T08:56:00Z", 1, "p1"),
    done("2026-10-09T09:00:00Z", 1, { inputTokens: 40 }, "p1"),
    started("2026-10-09T09:00:30Z", 2, "p2"),
    failed("2026-10-09T09:01:00Z", 2, "p2", 1, { inputTokens: 5, outputTokens: 5 }),
    failed("2026-10-09T09:02:00Z", 2, "p2", 2),
    dropped("2026-10-09T09:02:30Z", "p2"),
    started("2026-10-09T09:03:00Z", 3, "p1"),
  ],
  [IDS.D]: [
    created(IDS.D, { p1: "alpha", p2: "beta" }, "2026-10-09T09:59:00Z", "p1"),
    dStart("2026-10-09T09:59:30Z", "d1", "p1", 1),
    dFail("2026-10-09T10:00:00Z", "d1", "p1", 1, { inputTokens: 3, outputTokens: 2 }),
    dStart("2026-10-09T10:00:30Z", "d1", "p2", 2),
    dDone("2026-10-09T10:01:00Z", "d1", "p2", { inputTokens: 10, outputTokens: 8 }, 2),
  ],
  [IDS.F]: [
    created(IDS.F, { p1: "alpha", p2: "alpha" }, "2026-10-09T10:55:00Z"),
    started("2026-10-09T10:56:00Z", 1, "p1"),
    done("2026-10-09T11:00:00Z", 1, { inputTokens: 1, outputTokens: 1, costUsd: 0 }, "p1"),
  ],
  [IDS.H]: [ // the turn has no attempt 1: the successful files-request call is not recorded as an event
    created(IDS.H, { p1: "alpha", p2: "alpha" }, "2026-10-09T11:59:00Z"),
    started("2026-10-09T12:00:00Z", 1, "p1"),
    failed("2026-10-09T12:00:20Z", 1, "p1", 2, { inputTokens: 2, outputTokens: 1 }),
    failed("2026-10-09T12:00:40Z", 1, "p1", 3, { inputTokens: 3, outputTokens: 1 }),
    dropped("2026-10-09T12:00:50Z", "p1"),
  ],
  [IDS.G]: [
    created(IDS.G, { p1: "alpha", p2: "alpha" }, "2026-09-30T20:00:00Z"),
    started("2026-09-30T20:50:00Z", 1, "p1"),
    done("2026-09-30T20:59:59Z", 1, { inputTokens: 1000, outputTokens: 1000, costUsd: 1 }, "p1"),
    started("2026-09-30T20:59:59Z", 2, "p2"),
    done("2026-09-30T21:00:00Z", 2, { inputTokens: 7, outputTokens: 7, costUsd: 0.07 }, "p2"),
    finish("2026-09-30T21:00:30Z"),
  ],
};

/** Turn a body into a journal event: consecutive seq, ts from at, schema validation. */
export function toEvent(b: At, seq: number): SessionEvent {
  const { at, ...rest } = b;
  return SessionEventSchema.parse({ ...rest, seq, ts: at });
}

export function seedFixtures(dir: string): void {
  for (const [id, bodies] of Object.entries(JOURNALS)) {
    createSessionJournal(dir, id);
    bodies.forEach((b, i) => appendEvent(dir, id, toEvent(b, i + 1)));
  }
  appendFileSync(eventsPath(dir, IDS.F), "{это не событие\n"); // F: the journal is read only partway
  mkdirSync(join(sessionsDir(dir), IDS.E), { recursive: true });
  writeFileSync(join(sessionsDir(dir), IDS.E, "events.jsonl"), "это не JSON\n"); // E: unreadable journal
}

type T = { inputTokens: number | null; outputTokens: number | null; costUsd: number | null; records: number; missing: { inputTokens: number; outputTokens: number; costUsd: number }; openCalls: number; estimate: null };
type Group = T & { providerId: string | null };
export interface Expected { from: string; to: string; groups: Group[]; total: T }

const g = (providerId: string | null, inputTokens: number | null, outputTokens: number | null, costUsd: number | null, records: number, mi: number, mo: number, mc: number, openCalls: number): Group =>
  ({ providerId, inputTokens, outputTokens, costUsd, records, missing: { inputTokens: mi, outputTokens: mo, costUsd: mc }, openCalls, estimate: null });
const total = ({ providerId: _, ...t }: Group): T => t;
const gone = g("gone-llm", 5, 5, null, 2, 1, 1, 2, 1);
const beta = g("beta", 60, 10, 0, 2, 0, 1, 1, 1);
const nul = g(null, 10, 8, null, 1, 0, 0, 1, 0);

// The expectations table, computed by hand by the summary rules (the event day in Moscow time, UTC+3).
export const EXPECTED: Record<"p1" | "p2" | "p3", Expected> = {
  p1: { from: "2026-10-09", to: "2026-10-09", groups: [g("alpha", 22, 15, 0.02, 4, 0, 0, 2, 1), beta, gone, nul], total: total(g("", 97, 38, 0.02, 9, 1, 2, 6, 3)) },
  p2: { from: "2026-10-08", to: "2026-10-09", groups: [g("alpha", 122, 65, 0.03, 5, 0, 0, 2, 1), beta, gone, nul], total: total(g("", 197, 88, 0.03, 10, 1, 2, 6, 3)) },
  p3: { from: "2026-10-01", to: "2026-10-31", groups: [g("alpha", 129, 72, 0.1, 6, 0, 0, 2, 1), beta, gone, nul], total: total(g("", 204, 95, 0.1, 11, 1, 2, 6, 3)) },
};
