import { describe, it, expect } from "vitest";
import { foldEvents } from "./fold.ts";
import { SessionEventSchema, INSUFFICIENT_ACTIVE_REASON_CODE } from "./schema.ts";
import type { SessionEvent } from "./schema.ts";

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

type Variant = "ru" | "en" | "random" | "mixed";
const VARIANTS: Variant[] = ["ru", "en", "random", "mixed"];
const SHA = "a".repeat(64);
const usage = { inputTokens: 3, outputTokens: 4 };

// Journal structure depends only on the seed; texts depend on the variant.
function journal(seed: number, variant: Variant): { bodies: Body[]; edge: string } {
  const rnd = mulberry32(seed);
  const trnd = mulberry32(seed * 7919 + 13);
  const int = (n: number) => Math.floor(rnd() * n);
  let k = 0;
  const text = (): string => {
    const i = k++;
    const v = variant === "mixed" ? (i % 2 === 0 ? "ru" : "en") : variant;
    if (v === "ru") return `Исчерпаны попытки ${i}`;
    if (v === "en") return `Attempts exhausted ${i}`;
    return Array.from({ length: 1 + Math.floor(trnd() * 25) }, () => String.fromCharCode(32 + Math.floor(trnd() * 0x4e0))).join("");
  };
  const edge = ["dropBeforeV1", "allButOne", "failThenOk", "resume", "draftFail"][seed % 5]!;
  const n = 3 + int(3);
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const person = (id: string, name: string) => ({ id, name, providerId: "scripted", model: "m", role: null });
  const session = {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli" as const, topic: "t", templateId: null, framing: "",
    participants: ids.map((id) => person(id, `n${id}`)),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    ...(edge === "draftFail" ? { drafts: { enabled: true as const, synthesizerId: ids[0]! } } : {}),
  };
  const b: Body[] = [{ type: "session_created", session, pid: 1 }];
  let turnNo = 0, ver = 0;
  const active = new Set(ids);
  const turn = (id: string, stance: "amend" | "agree") => {
    turnNo++;
    if (stance === "amend") ver++;
    b.push({ type: "turn_started", turn: turnNo, round: 1, participantId: id });
    b.push({
      type: "turn_completed", turn: turnNo, round: 1, participantId: id, stance, normalized: false, reasoning: "r",
      solution: stance === "amend" ? "v" : null, version: ver, questions: [], answers: [], attempts: 1, usage, durationMs: 4,
    });
  };
  const drop = (id: string) => { active.delete(id); b.push({ type: "participant_dropped", participantId: id, reason: text() }); };

  if (edge === "draftFail") {
    ids.forEach((id, i) => {
      const d = `d${i + 1}`;
      b.push({ type: "draft_attempt_started", draftId: d, participantId: id, attempt: 1 });
      if (i === 1) {
        b.push({ type: "draft_attempt_failed", draftId: d, participantId: id, attempt: 1, kind: "timeout", message: text(), usage });
        b.push({ type: "draft_attempt_started", draftId: d, participantId: id, attempt: 2 });
      }
      b.push({ type: "draft_completed", draftId: d, participantId: id, attempts: i === 1 ? 2 : 1, durationMs: 3, usage, chars: 3, sha256: SHA, reasoning: "r" });
    });
    b.push({ type: "drafts_finished" });
  }
  if (edge === "dropBeforeV1") drop(ids[int(n)]!);
  if (edge === "failThenOk") {
    turnNo++;
    b.push({ type: "turn_started", turn: turnNo, round: 1, participantId: ids[0]! });
    b.push({ type: "turn_failed", turn: turnNo, round: 1, participantId: ids[0]!, attempt: 1, kind: "timeout", message: text(), usage });
    turnNo--; // repeat of the same turn: success after a failure
    turn(ids[0]!, "amend");
  } else {
    turn(ids[0]!, "amend");
  }
  if (rnd() < 0.5) turn(ids[1]!, "agree");
  if (edge === "allButOne") {
    for (const id of ids.slice(1).filter((x) => active.has(x))) drop(id);
    b.push({ type: "session_finished", status: "no_consensus", version: ver, agreed: [], objectors: [], reason: text(), reasonCode: INSUFFICIENT_ACTIVE_REASON_CODE });
  } else {
    b.push({ type: "session_finished", status: "no_consensus", version: ver, agreed: [], objectors: [], reason: text() });
  }
  if (edge === "resume" || edge === "allButOne") {
    const old = edge === "resume" ? ids[2]! : ids[1]!;
    b.push({ type: "session_resumed", pid: 2, maxRounds: 6, replacements: [{ oldParticipantId: old, participant: person(`p${n + 1}`, text()) }] });
  }
  return { bodies: b, edge };
}

// Replaces all free texts with a stub; everything else is compared in full.
const TEXT_KEYS = new Set(["dropReason", "message", "reason", "name", "raw"]);
function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, TEXT_KEYS.has(k) && typeof x === "string" ? "<text>" : normalize(x)]));
  }
  return v;
}

describe("Failure codes and identifiers do not depend on language: texts written to the journal are not translated", () => {
  it("350 journals in four text variants: schema, fold and state do not depend on the texts", () => {
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= 350; seed++) {
      const states = VARIANTS.map((variant) => {
        const { bodies, edge } = journal(seed, variant);
        seen.set(edge, (seen.get(edge) ?? 0) + 1);
        const events = mk(bodies);
        for (const e of events) expect(SessionEventSchema.safeParse(e).success, `seed ${seed} ${variant}: ${e.type}`).toBe(true);
        let state: ReturnType<typeof foldEvents> | undefined;
        expect(() => { state = foldEvents(events); }, `seed ${seed} ${variant}: свёртка`).not.toThrow();
        return normalize(state);
      });
      for (let i = 1; i < states.length; i++) expect(states[i], `seed ${seed}: вариант ${VARIANTS[i]} против ru`).toEqual(states[0]);
    }
    for (const edge of ["dropBeforeV1", "allButOne", "failThenOk", "resume", "draftFail"]) expect(seen.get(edge), edge).toBeGreaterThan(0);
  });
});
