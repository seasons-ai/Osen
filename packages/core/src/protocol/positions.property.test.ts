import { describe, it, expect } from "vitest";
import { foldEvents } from "./fold.ts";
import { SessionEventSchema } from "./schema.ts";
import type { SessionEvent } from "./schema.ts";
import { activeParticipantIds, currentVersion } from "./state.ts";
import { buildTurnPrompt, OBJECTION_MAX_CHARS } from "./context.ts";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;

const mk = (bodies: Body[]): SessionEvent[] =>
  bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Journal made only of existing events: amend/agree/object turns in any order, questions to participants and to the owner,
// the owner's answers and closing of its questions (consent reset), dropouts, long objections.
function generate(seed: number): Body[] {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const n = 2 + int(7);
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const active = new Set(ids);
  const session = {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli" as const, topic: "t", templateId: null, framing: "",
    participants: ids.map((id) => ({ id, name: `имя ${id}`, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 9, turnTimeoutSec: 60, contextChars: 1 },
  };
  const bodies: Body[] = [{ type: "session_created", session, pid: 1 }];
  let turnNo = 0, ver = 0, qNo = 0, oNo = 0;
  const ownerOpen: string[] = [];
  const steps = 1 + int(20);
  for (let s = 0; s < steps; s++) {
    const order = [...active];
    const id = order[s % order.length]!;
    const stance = ver === 0 ? "amend" : (["amend", "agree", "object", "object"] as const)[int(4)]!;
    turnNo++;
    if (stance === "amend") ver++;
    const long = rnd() < 0.2;
    const reasoning = `R${turnNo}-${id} ${long ? "д".repeat(OBJECTION_MAX_CHARS + int(800)) : "довод"}`;
    const others = order.filter((x) => x !== id);
    const questions = rnd() < 0.3 ? [{ id: `q${++qNo}`, to: rnd() < 0.4 || others.length === 0 ? "owner" : others[int(others.length)]!, text: `вопрос ${qNo}` }] : [];
    for (const q of questions) if (q.to === "owner") ownerOpen.push(q.id);
    bodies.push({ type: "turn_started", turn: turnNo, round: 1 + Math.floor(s / order.length), participantId: id });
    bodies.push({
      type: "turn_completed", turn: turnNo, round: 1 + Math.floor(s / order.length), participantId: id, stance, normalized: false, reasoning,
      solution: stance === "amend" ? `текст v${ver}` : null, version: ver, questions, answers: [], attempts: 1, usage: {}, durationMs: 1,
    });
    const r = rnd();
    if (r < 0.1) {
      const answers = ownerOpen.length > 0 && rnd() < 0.5 ? [{ questionId: ownerOpen.shift()!, text: "ответ владельца" }] : undefined;
      bodies.push({ type: "owner_message", id: `o${++oNo}`, text: "реплика", afterTurn: turnNo, requestId: `r${oNo}`, ...(answers ? { answers } : {}) });
      if (answers) bodies.push({ type: "question_closed", questionId: answers[0]!.questionId, reason: "answered" });
    } else if (r < 0.15 && ownerOpen.length > 0) {
      bodies.push({ type: "question_closed", questionId: ownerOpen.shift()!, reason: "unanswered" });
    } else if (r < 0.22 && active.size > 2) {
      const out = order[int(order.length)]!;
      active.delete(out);
      bodies.push({ type: "participant_dropped", participantId: out, reason: "сбой" });
    }
  }
  return bodies;
}

const SECTION = "# Позиции по текущей версии\n";
const section = (p: string) => p.split(SECTION)[1]?.split("\n\n# ")[0];

describe("Positions on the current version — property", () => {
  it("Positions on the current version: for any journal and any contextChars ≥ 0, every active participant's objection is in every other participant's request, and the list of agreeing participants equals state.agreed", () => {
    const seen = { objections: 0, long: 0, ownerReset: 0, dropped: 0, wide: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const bodies = generate(seed);
      const events = mk(bodies);
      for (const e of events) expect(SessionEventSchema.safeParse(e).success, `seed ${seed}: ${e.type}`).toBe(true);
      const base = foldEvents(events);
      const v = currentVersion(base)!;
      const active = activeParticipantIds(base);
      if (bodies.some((b) => b.type === "owner_message" || b.type === "question_closed")) seen.ownerReset++;
      if (bodies.some((b) => b.type === "participant_dropped")) seen.dropped++;
      if (active.length >= 6) seen.wide++;
      const objections = new Map<string, string>();
      for (const id of active) {
        if (base.agreed.includes(id)) continue;
        const last = base.turns.findLast((t) => t.participantId === id && t.version === v.number);
        if (last?.stance === "object") objections.set(id, last.reasoning);
      }
      seen.objections += objections.size;
      seen.long += [...objections.values()].filter((t) => t.length > OBJECTION_MAX_CHARS).length;
      // Length of the first journal entry: at this limit no more than one entry remains in the journal.
      const withLimit = (c: number) => ({ ...base, session: { ...base.session!, limits: { ...base.session!.limits, contextChars: c } } });
      const firstEntry = buildTurnPrompt(withLimit(10_000_000), active[0]!).split("# Журнал ходов\n")[1]!.split("\n\n## Ход ")[0]!.length;
      for (const contextChars of [0, 1, firstEntry, 1 + (seed * 997) % 20000]) {
        const state = withLimit(contextChars);
        for (const reader of active) {
          const p = buildTurnPrompt(state, reader);
          const sec = section(p);
          const msg = `seed ${seed}, contextChars ${contextChars}, читатель ${reader}`;
          expect(sec, msg).toBeDefined();
          expect(sec!.split("\n").filter((l) => l.startsWith("- p")).map((l) => l.slice(2).split(" ")[0]), `${msg}: строка на каждого действующего`).toEqual(active);
          for (const [id, text] of objections) {
            if (id === reader) continue;
            expect(sec, `${msg}: возражение ${id}`).toContain(text.slice(0, OBJECTION_MAX_CHARS));
            if (text.length > OBJECTION_MAX_CHARS) expect(sec, `${msg}: 2001-й знак ${id}`).not.toContain(text.slice(0, OBJECTION_MAX_CHARS + 1));
          }
          const agreed = sec!.split("\n").filter((l) => l.endsWith(": согласен")).map((l) => l.slice(2).split(" ")[0]);
          expect(agreed, `${msg}: согласные`).toEqual(base.agreed.filter((id) => active.includes(id)));
        }
      }
    }
    expect(seen.objections).toBeGreaterThan(50);
    expect(seen.long).toBeGreaterThan(0);
    expect(seen.ownerReset).toBeGreaterThan(0);
    expect(seen.dropped).toBeGreaterThan(0);
    expect(seen.wide).toBeGreaterThan(0);
  });
});
