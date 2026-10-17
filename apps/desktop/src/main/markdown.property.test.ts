import { describe, expect, it } from "vitest";
import { foldEvents, objectors } from "@model-council/core/protocol";
import type { SessionEvent } from "@model-council/core/protocol";
import type { StoredStatus } from "@model-council/core";
import { objectingParticipants, timeline } from "../shared/timeline.ts";
import type { TimelineItem } from "../shared/timeline.ts";
import { sessionMarkdown } from "./markdown.ts";

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

const SHA = "b".repeat(64);
const STATUSES: StoredStatus[] = ["interrupted", "running", "no_consensus"];
const fold = (bodies: Body[]) => foldEvents(bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent));

interface Case { bodies: Body[]; status: StoredStatus; hasPhase: boolean }

function generate(seed: number): Case {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const n = 2 + int(3);
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const hasPhase = rnd() < 0.65;
  const synth = ids[int(n)]!;
  const bodies: Body[] = [{
    type: "session_created", pid: 1,
    session: {
      id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Т", templateId: null, framing: "",
      participants: ids.map((id, i) => ({ id, name: `Имя${i + 1}`, providerId: "scripted", model: "m", role: null })),
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
      ...(hasPhase ? { drafts: { enabled: true as const, synthesizerId: synth } } : {}),
    },
  }];
  const dropped = new Set<string>();
  let phaseOpen = false; // the phase was cut mid-slot or the synthesizer dropped out
  if (hasPhase) {
    const empty = rnd() < 0.15;
    if (!empty) ids.forEach((id, i) => {
      const d = `d${i + 1}`;
      const mode = int(4); // 0 accepted, 1 accepted after failures, 2 dropped without a draft, 3 no slot
      if (mode === 3) return;
      const fails = mode === 0 ? 0 : 1 + int(2); // the slot attempt limit is 3
      for (let a = 1; a <= fails; a++) bodies.push({ type: "draft_attempt_started", draftId: d, participantId: id, attempt: a }, { type: "draft_attempt_failed", draftId: d, participantId: id, attempt: a, kind: (["timeout", "call_error", "invalid_response"] as const)[int(3)]!, message: `сбой ${a}.` });
      if (mode === 2) { bodies.push({ type: "participant_dropped", participantId: id, reason: "таймаут" }); dropped.add(id); return; }
      bodies.push({ type: "draft_attempt_started", draftId: d, participantId: id, attempt: fails + 1 },
        { type: "draft_completed", draftId: d, participantId: id, attempts: fails + 1, durationMs: 1, usage: {}, chars: 3, sha256: SHA, reasoning: `арг ${d}` });
    });
    const r = rnd();
    if (r < 0.15) { bodies.push({ type: "draft_attempt_started", draftId: `d${n}`, participantId: ids[n - 1]!, attempt: 1 }); phaseOpen = true; } // cut off
    else if (r < 0.3) { // the synthesizer dropped out: the discussion has not started
      if (!dropped.has(synth)) bodies.push({ type: "participant_dropped", participantId: synth, reason: "недоступен" });
      dropped.add(synth); phaseOpen = true;
      bodies.push({ type: "session_finished", status: "failed", version: null, agreed: [], objectors: [], reason: "synthesizer_unavailable" });
    } else bodies.push({ type: "drafts_finished" });
  }
  const finished = bodies.some((b) => b.type === "session_finished");
  if (!phaseOpen && !finished) {
    const active = ids.filter((id) => !dropped.has(id));
    let version = 0;
    const turns = int(6);
    for (let t = 1; t <= turns && active.length; t++) {
      const id = active[int(active.length)]!;
      bodies.push({ type: "turn_started", turn: t, round: 1, participantId: id });
      if (rnd() < 0.25) bodies.push({ type: "turn_failed", turn: t, round: 1, participantId: id, attempt: 1, kind: "invalid_response", message: "мусор" });
      const stance = version === 0 || rnd() < 0.4 ? "amend" : rnd() < 0.5 ? "agree" : "object";
      if (stance === "amend") version++;
      bodies.push({
        type: "turn_completed", turn: t, round: 1, participantId: id, stance, normalized: false, reasoning: `аргумент ${t}`,
        solution: stance === "amend" ? `текст v${version}` : null, version, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
      });
    }
    if (rnd() < 0.2 && active.length > 1) { // failures up to the limit and dropping out
      const id = active[int(active.length)]!;
      const t = turns + 1;
      bodies.push({ type: "turn_started", turn: t, round: 1, participantId: id });
      for (let a = 1; a <= 2; a++) bodies.push({ type: "turn_failed", turn: t, round: 1, participantId: id, attempt: a, kind: "timeout", message: "долго" });
      bodies.push({ type: "participant_dropped", participantId: id, reason: "таймаут" });
    }
    if (rnd() < 0.4) {
      const st = fold(bodies);
      bodies.push({
        type: "session_finished", status: (["consensus", "no_consensus", "stopped"] as const)[int(3)]!,
        version: st.versions.at(-1)?.number ?? null, agreed: [...st.agreed], objectors: objectors(st),
      });
    }
  }
  return { bodies, status: STATUSES[int(3)]!, hasPhase };
}

// The line a timeline element starts with in the ru export.
function marker(it: TimelineItem, name: (id: string) => string): string {
  switch (it.kind) {
    case "turn": return `### Ход ${it.turn.turn} · круг `;
    case "failure": return `- Сбой: ход ${it.failure.turn} · ${name(it.failure.participantId)} · попытка ${it.failure.attempt} — `;
    case "dropped": case "draft-dropped": return `- ${name(it.participantId)} выбыл: ${it.reason}`;
    case "draft-phase": return "### Независимые черновики — ";
    case "draft-failure": return `- Сбой: черновик ${it.draftId} · ${name(it.failure.participantId)} · попытка ${it.failure.attempt} — `;
    case "draft": return `### Черновик ${Number(it.draftId.slice(1))} · ${name(it.done.participantId)}`;
    case "discussion-start": return "**Обсуждение начато · синтезатор ";
    default: throw new Error(`элемент ${it.kind} в этом тесте не порождается`);
  }
}

describe("Markdown export: the course of the discussion in timeline order", () => {
  it("elements go in the order of timeline(state); a session with a phase has a non-empty section; objections equal objectingParticipants", () => {
    const CASES = 1500;
    let phases = 0, withObjections = 0, withDraft = 0, withStart = 0, withDropped = 0, finished = 0;
    for (let seed = 1; seed <= CASES; seed++) {
      const { bodies, status, hasPhase } = generate(seed);
      const state = fold(bodies);
      const md = sessionMarkdown(state, status);
      const name = (id: string) => state.session!.participants.find((p) => p.id === id)!.name;
      const items = timeline(state);
      const head = md.indexOf("## Ход обсуждения");
      expect(head, `seed ${seed}`).toBeGreaterThan(-1);

      let at = head;
      for (const it of items) {
        const m = marker(it, name);
        const i = md.indexOf(m, at + 1);
        expect(i, `seed ${seed}: «${m}» после позиции ${at}`).toBeGreaterThan(at);
        at = i;
      }
      expect(md.includes("Ходов нет."), `seed ${seed}: «Ходов нет.»`).toBe(items.length === 0);
      if (hasPhase) expect(md, `seed ${seed}`).not.toContain("Ходов нет.");

      const sec = /## Возражения\n\n([\s\S]*?)(?=\n\n## |$)/.exec(md.slice(0, head));
      const listed = sec ? sec[1]!.trim().split("\n").map((l) => /^- (Имя\d+): /.exec(l)![1]!) : [];
      expect(listed, `seed ${seed}: возражения`).toEqual(objectingParticipants(state, status).map((o) => name(o.participantId)));

      if (hasPhase) phases++;
      if (listed.length) withObjections++;
      if (items.some((x) => x.kind === "draft")) withDraft++;
      if (items.some((x) => x.kind === "discussion-start")) withStart++;
      if (items.some((x) => x.kind === "dropped" || x.kind === "draft-dropped")) withDropped++;
      if (state.finish) finished++;
    }
    // the generator really reaches every kind of element
    for (const [what, v] of Object.entries({ phases, withObjections, withDraft, withStart, withDropped, finished })) expect(v, what).toBeGreaterThan(CASES / 50);
  });
});
