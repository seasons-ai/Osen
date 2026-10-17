import { describe, it, expect } from "vitest";
import { applyEvent, foldEvents } from "./fold.ts";
import { SessionEventSchema } from "./schema.ts";
import type { SessionEvent } from "./schema.ts";
import { activeParticipantIds, resumePoint, slotRoster, tokenUsage, turnOrder } from "./state.ts";
import type { SessionState } from "./state.ts";

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

const person = (n: number) => ({ id: `p${n}`, name: `n${n}`, providerId: "scripted", model: "m", role: null });
const SHA = "a".repeat(64);

interface Case { bodies: Body[]; resumeAt: number[]; target: string; mode: number }

// Journal: creation, drafts, random turns, boundary state by mode, then one or two continuations with replacements.
function generate(seed: number): Case {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const n = 2 + int(4);
  const mode = int(5); // 0 — all agree, 1 — open question to the replaced one, 2 — interrupted turn, 3 — unfinished draft, 4 — no special state
  const drafts = mode === 3 || rnd() < 0.35;
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const active = new Set(ids);
  const target = ids[int(n)]!;
  const synth = ids[int(n)]!;
  const session = {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli" as const, topic: "t", templateId: null, framing: "",
    participants: ids.map((id) => person(Number(id.slice(1)))),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    ...(drafts ? { drafts: { enabled: true as const, synthesizerId: synth } } : {}),
  };
  const bodies: Body[] = [{ type: "session_created", session, pid: 1 }];
  let turnNo = 0, ver = 0, qNo = 0, round = 1;
  const usage = () => ({ inputTokens: 1 + int(50), outputTokens: 1 + int(50) });
  const openQs: string[] = [];

  const draftSlot = (i: number, finish: boolean) => {
    const d = `d${i + 1}`, id = ids[i]!;
    bodies.push({ type: "draft_attempt_started", draftId: d, participantId: id, attempt: 1 });
    if (!finish) {
      if (rnd() < 0.5) bodies.push({ type: "draft_attempt_failed", draftId: d, participantId: id, attempt: 1, kind: "timeout", message: "m", usage: usage() });
      return;
    }
    bodies.push({ type: "draft_completed", draftId: d, participantId: id, attempts: 1, durationMs: 3, usage: usage(), chars: 3, sha256: SHA, reasoning: "r" });
  };
  if (drafts) {
    const tIdx = ids.indexOf(target);
    for (let i = 0; i < n; i++) {
      if (mode === 3 && i === tIdx) { draftSlot(i, false); break; }
      draftSlot(i, true);
    }
    if (mode !== 3) bodies.push({ type: "drafts_finished" });
  }

  const turn = (id: string, stance: "amend" | "agree" | "object", questions: { id: string; to: string; text: string }[] = []) => {
    turnNo++;
    if (stance === "amend") ver++;
    bodies.push({ type: "turn_started", turn: turnNo, round, participantId: id });
    bodies.push({
      type: "turn_completed", turn: turnNo, round, participantId: id, stance, normalized: false, reasoning: "r",
      solution: stance === "amend" ? `текст v${ver}` : null, version: ver, questions, answers: [], attempts: 1, usage: usage(), durationMs: 4,
    });
    for (const x of questions) openQs.push(x.id);
  };
  const ask = (to: string) => ({ id: `q${++qNo}`, to, text: `вопрос к ${to}` });
  const others = (id: string) => [...active].filter((x) => x !== id);

  if (mode !== 3) {
    const steps = int(9);
    let k = 0;
    for (let s = 0; s < steps; s++) {
      const order = [...active];
      const id = order[k++ % order.length]!;
      if (k % order.length === 0) round++;
      const stance = ver === 0 ? "amend" : (["amend", "agree", "agree", "object"] as const)[int(4)]!;
      const qs = rnd() < 0.3 ? [ask(rnd() < 0.15 ? "owner" : others(id)[int(others(id).length)] ?? "owner")] : [];
      turn(id, stance, qs);
      if (rnd() < 0.1 && active.size > 2) {
        const out = [...active][int(active.size)]!;
        active.delete(out);
        bodies.push({ type: "participant_dropped", participantId: out, reason: "сбой" });
      }
      if (rnd() < 0.1 && openQs.length > 0) bodies.push({ type: "question_closed", questionId: openQs.splice(int(openQs.length), 1)[0]!, reason: "unanswered" });
    }
    if (!active.has(target) && mode !== 4) active.add(target); // boundary modes require a live replaced participant
    if (mode === 0) {
      turn([...active][0]!, "amend");
      for (const id of [...active].slice(1)) turn(id, "agree");
    } else if (mode === 1) {
      const asker = others(target)[0];
      if (asker) turn(asker, ver === 0 ? "amend" : "object", [ask(target)]);
    } else if (mode === 2) {
      turnNo++;
      bodies.push({ type: "turn_started", turn: turnNo, round, participantId: target });
      if (rnd() < 0.5) bodies.push({ type: "participant_dropped", participantId: target, reason: "сбой" });
    }
  }
  if (rnd() < 0.5) bodies.push({ type: "session_finished", status: "no_consensus", version: ver || null, agreed: [], objectors: [], reason: "лимит" });

  const resumeAt: number[] = [];
  const resume = (needTarget: boolean) => {
    const state = foldEvents(mk(bodies));
    const roster = slotRoster(state.session!).map((p) => p.id);
    const picked = new Set<string>(needTarget ? [target] : []);
    const want = 1 + int(roster.length);
    while (picked.size < want) picked.add(roster[int(roster.length)]!);
    let next = state.session!.participants.length;
    const replacements = [...picked].map((oldParticipantId) => ({ oldParticipantId, participant: person(++next) }));
    resumeAt.push(bodies.length);
    bodies.push({ type: "session_resumed", pid: 2 + resumeAt.length, maxRounds: 6, replacements });
  };
  resume(true);
  if (rnd() < 0.3) {
    const state = foldEvents(mk(bodies));
    const fresh = slotRoster(state.session!).find((p) => p.replaces !== undefined);
    if (fresh) {
      round++;
      turn(fresh.id, "amend");
      bodies.push({ type: "session_finished", status: "no_consensus", version: ver, agreed: [], objectors: [], reason: "лимит" });
      const roster = slotRoster(state.session!).map((p) => p.id);
      const picked = new Set<string>([fresh.id, roster[int(roster.length)]!]);
      let next = state.session!.participants.length;
      const replacements = [...picked].map((oldParticipantId) => ({ oldParticipantId, participant: person(++next) }));
      resumeAt.push(bodies.length);
      bodies.push({ type: "session_resumed", pid: 9, maxRounds: 8, replacements });
    }
  }
  return { bodies, resumeAt, target, mode };
}

describe("Replacement fold and refusal reasons — property", () => {
  it("200 random journals: replacement does not touch history, usage and closed questions", () => {
    const seen = { allAgree: 0, openToReplaced: 0, unfinishedTurn: 0, unfinishedDraft: 0, chain: 0 };
    for (let seed = 1; seed <= 250; seed++) {
      const c = generate(seed);
      const all = mk(c.bodies);
      for (const e of all) expect(SessionEventSchema.safeParse(e).success, `seed ${seed}: ${e.type}`).toBe(true);
      if (c.resumeAt.length > 1) seen.chain++;
      for (const at of c.resumeAt) {
        const before: SessionState = foldEvents(all.slice(0, at));
        const resumeEvent = all[at]! as Extract<SessionEvent, { type: "session_resumed" }>;
        const after = applyEvent(before, resumeEvent);
        const olds = new Set(resumeEvent.replacements!.map((r) => r.oldParticipantId));
        const msg = (p: string) => `seed ${seed}, resume@${at}: ${p}`;

        const active = activeParticipantIds(before);
        if (before.agreed.length > 0 && active.length >= 2 && active.every((id) => before.agreed.includes(id))) seen.allAgree++;
        if (before.questions.some((x) => x.status === "open" && olds.has(x.to))) seen.openToReplaced++;
        if (before.lastStarted && !before.turns.some((t) => t.turn === before.lastStarted!.turn) && olds.has(before.lastStarted.participantId)) seen.unfinishedTurn++;
        if (before.drafts.some((d) => d.done === null && olds.has(d.participantId))) seen.unfinishedDraft++;

        expect(after.turns, msg("ходы")).toEqual(before.turns);
        expect(after.versions, msg("версии")).toEqual(before.versions);
        expect(after.agreed, msg("согласие сброшено")).toEqual([]);
        expect(after.questions.filter((x) => x.status === "open" && olds.has(x.to)), msg("открытые вопросы к заменённым")).toEqual([]);
        for (const was of before.questions.filter((x) => x.status !== "open")) {
          expect(after.questions.find((x) => x.id === was.id), msg(`закрытый вопрос ${was.id}`)).toEqual(was);
        }
        expect(after.questions.map((x) => x.id), msg("перечень вопросов")).toEqual(before.questions.map((x) => x.id));
        expect(tokenUsage(after), msg("расход")).toEqual(tokenUsage(before));
        expect(after.drafts, msg("черновики")).toEqual(before.drafts);

        const replacedAll = new Set(after.participants.filter((p) => p.replacedBy !== undefined).map((p) => p.id));
        const order = turnOrder(after.session!).map((p) => p.id);
        for (const id of replacedAll) {
          expect(order, msg(`${id} в очереди`)).not.toContain(id);
          expect(activeParticipantIds(after), msg(`${id} активен`)).not.toContain(id);
        }
        const point = resumePoint(after);
        expect(replacedAll.has(order[point.index]!), msg("точка продолжения на заменённом")).toBe(false);

        const idsAll = after.session!.participants.map((p) => p.id);
        expect(new Set(idsAll).size, msg("уникальность идентификаторов")).toBe(idsAll.length);
        expect(order.length, msg("число слотов")).toBe((c.bodies[0] as Extract<Body, { type: "session_created" }>).session.participants.length);
      }

      // continuation without replacements changes nothing in participants, questions and consent
      const at = c.resumeAt[0]!;
      const before = foldEvents(all.slice(0, at));
      const plain = applyEvent(before, { ...(all[at] as Extract<SessionEvent, { type: "session_resumed" }>), replacements: undefined });
      for (const k of ["agreed", "questions", "participants"] as const) expect(plain[k], `seed ${seed}: ${k} без замен`).toEqual(before[k]);
      expect(plain.session!.participants, `seed ${seed}: session.participants без замен`).toEqual(before.session!.participants);
    }
    expect(seen.allAgree).toBeGreaterThan(0);
    expect(seen.openToReplaced).toBeGreaterThan(0);
    expect(seen.unfinishedTurn).toBeGreaterThan(0);
    expect(seen.unfinishedDraft).toBeGreaterThan(0);
    expect(seen.chain).toBeGreaterThan(0);
  });
});
