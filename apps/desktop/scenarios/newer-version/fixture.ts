// Fixture journals of the "newer version" and "corrupted journal" sessions; the expected N are written by hand.
import { createSessionJournal, eventsPath, SessionEventSchema } from "../../../../packages/core/src/index.ts";
import type { Session, SessionEvent } from "../../../../packages/core/src/index.ts";
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export const IDS = { A: "newer-a", B: "corrupt-b", C: "newer-live", D: "newer-finish" } as const;
/** How many events are read before the problematic line: A — up to the line of an unknown type, B — up to the broken line. */
export const N = { A: 5, B: 3, C: 3, D: 3 } as const;
// A and B: the executor is dead (pid of an exited process) — core status "interrupted"; C: the core considers pid 1 alive (EPERM) — the executor of a running session for the window
const DEAD_PID = spawnSync(process.execPath, ["-e", ""]).pid!;
const LIVE_PID = 1;

const session = (id: string): Session => ({
  id, createdAt: "2026-10-09T08:00:00Z", origin: "cli", topic: `Тема ${id}`, templateId: null, framing: "",
  participants: ["p1", "p2"].map((p) => ({ id: p, name: p, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
});
type Raw = Record<string, unknown>;
const ev = (seq: number, body: Raw): string => JSON.stringify(SessionEventSchema.parse({ ...body, seq, ts: `2026-10-09T08:00:${String(seq).padStart(2, "0")}Z` }) as SessionEvent);
const created = (id: string, pid: number): Raw => ({ type: "session_created", pid, session: session(id) });
const started = (turn: number, participantId: string): Raw => ({ type: "turn_started", turn, round: 1, participantId });
const done = (turn: number, participantId: string, stance: "amend" | "agree"): Raw => ({
  type: "turn_completed", turn, round: 1, participantId, stance, normalized: false, reasoning: "r", solution: stance === "amend" ? "Решение v1" : null,
  version: 1, questions: [], answers: [], attempts: 1, usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1,
});

export function seedFixtures(dir: string): void {
  for (const id of [IDS.A, IDS.B, IDS.C]) createSessionJournal(dir, id);
  const a = [created(IDS.A, DEAD_PID), started(1, "p1"), done(1, "p1", "amend"), started(2, "p2"), done(2, "p2", "agree")].map((b, i) => ev(i + 1, b));
  a.push(JSON.stringify({ seq: 6, ts: "2026-10-09T08:00:06Z", type: "owner_future_event", payload: "x" })); // event of a newer version
  a.push(ev(7, { type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [] }));
  appendFileSync(eventsPath(dir, IDS.A), a.join("\n") + "\n");
  const b = [created(IDS.B, DEAD_PID), started(1, "p1"), done(1, "p1", "amend")].map((x, i) => ev(i + 1, x));
  b.push('{"seq": 5, "ty'); // truncated record
  b.push(ev(5, started(2, "p2")), ev(6, done(2, "p2", "agree")));
  const c = [created(IDS.C, LIVE_PID), started(1, "p1"), done(1, "p1", "amend")].map((x, i) => ev(i + 1, x));
  c.push(JSON.stringify({ seq: 4, ts: "2026-10-09T08:00:04Z", type: "owner_future_event", payload: "x" })); // end of the journal: event of a newer version
  appendFileSync(eventsPath(dir, IDS.C), c.join("\n") + "\n");
  appendFileSync(eventsPath(dir, IDS.B), b.join("\n") + "\n");
}

// D: a running session of a newer version with the pid of a process that the stand or the owner will terminate (completion notification)
export function seedLive(dir: string, pid: number): void {
  createSessionJournal(dir, IDS.D);
  const d = [created(IDS.D, pid), started(1, "p1"), done(1, "p1", "amend")].map((x, i) => ev(i + 1, x));
  d.push(JSON.stringify({ seq: 4, ts: "2026-10-09T08:00:04Z", type: "owner_future_event", payload: "x" }));
  appendFileSync(eventsPath(dir, IDS.D), d.join("\n") + "\n");
}
