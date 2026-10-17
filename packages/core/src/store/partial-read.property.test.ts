import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldEvents } from "../protocol/fold.ts";
import { SessionEventSchema } from "../protocol/schema.ts";
import type { SessionEvent } from "../protocol/schema.ts";
import { eventsPath, readEvents } from "./journal.ts";
import { readSession } from "./sessions.ts";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const TS = "2026-01-01T00:00:00Z";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Journal from one session_created up to (optionally) session_finished; turns, questions, owner message, owner wait, dropping out.
function generate(seed: number): SessionEvent[] {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const n = 2 + int(3);
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const active = [...ids];
  const bodies: Body[] = [{
    type: "session_created", pid: 1,
    session: {
      id: "s", createdAt: TS, origin: "cli", topic: "t", templateId: null, framing: "",
      participants: ids.map((id) => ({ id, name: `n${id}`, providerId: "scripted", model: "m", role: null })),
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    },
  }];
  let turn = 0, ver = 0, q = 0, o = 0, w = 0, openOwnerQ: string[] = [], openWait: string | null = null;
  const steps = seed % 7 === 0 ? 0 : int(14); // every seventh journal — just one session_created
  for (let s = 0; s < steps; s++) {
    const r = rnd();
    if (r < 0.55) {
      const id = active[turn % active.length]!;
      turn++;
      const stance = ver === 0 ? "amend" : (["amend", "agree", "object"] as const)[int(3)]!;
      if (stance === "amend") ver++;
      const questions = rnd() < 0.35 ? [{ id: `q${++q}`, to: rnd() < 0.4 ? "owner" : active[int(active.length)]!, text: "вопрос" }] : [];
      for (const x of questions) if (x.to === "owner") openOwnerQ.push(x.id);
      bodies.push({ type: "turn_started", turn, round: 1 + Math.floor(turn / n), participantId: id });
      bodies.push({
        type: "turn_completed", turn, round: 1 + Math.floor(turn / n), participantId: id, stance, normalized: false, reasoning: "r",
        solution: stance === "amend" ? `текст v${ver}` : null, version: ver, questions,
        answers: [], attempts: 1, usage: { inputTokens: 1 + int(40), outputTokens: 1 + int(40) }, durationMs: 3,
      });
    } else if (r < 0.7) {
      const answers = openOwnerQ.length > 0 && rnd() < 0.6 ? [{ questionId: openOwnerQ.shift()!, text: "ответ" }] : undefined;
      bodies.push({ type: "owner_message", id: `o${++o}`, text: "реплика", afterTurn: turn, requestId: `r${o}`, ...(answers ? { answers } : {}) });
    } else if (r < 0.85) {
      if (openWait === null) {
        openWait = `w${++w}`;
        bodies.push({ type: "owner_wait_started", waitId: openWait, reasons: [rnd() < 0.5 ? "owner_question" : "round_boundary"], questionIds: [...openOwnerQ], afterTurn: turn, deadline: "2026-01-02T00:00:00Z" });
      } else {
        bodies.push({ type: "owner_wait_finished", waitId: openWait, reason: (["continued", "answered", "expired", "stopped"] as const)[int(4)]! });
        openWait = null;
      }
    } else if (active.length > 2) {
      bodies.push({ type: "participant_dropped", participantId: active.splice(int(active.length), 1)[0]!, reason: "сбой" });
    }
  }
  if (steps > 0 && rnd() < 0.5) {
    const status = (["consensus", "no_consensus", "stopped", "failed"] as const)[int(4)]!;
    bodies.push({ type: "session_finished", status, version: ver || null, agreed: status === "consensus" ? [...active] : [], objectors: [], ...(status === "consensus" ? {} : { reason: "лимит" }) });
  }
  return bodies.map((b, i) => ({ ...b, seq: i + 1, ts: TS }) as SessionEvent);
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("Partial-read flag of journal: any position of an unknown line", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "council-partial-"));
  mkdirSync(join(dataDir, "sessions", "s"), { recursive: true });
  const path = eventsPath(dataDir, "s");
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  it("200 journals, insert at each position 1..length: newer_version, lastEvent, state, bytes; non-JSON and cut tail — corrupted", () => {
    const seen = { single: 0, afterCreated: 0, afterFinished: 0, ownerQuestion: 0, ownerWait: 0, ownerMessage: 0, dropped: 0, cases: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const all = generate(seed);
      for (const e of all) expect(SessionEventSchema.safeParse(e).success, `seed ${seed}: ${e.type} не проходит схему`).toBe(true);
      const lines = all.map((e) => JSON.stringify(e) + "\n");
      if (all.length === 1) seen.single++;
      if (all.some((e) => e.type === "turn_completed" && e.questions.some((x) => x.to === "owner"))) seen.ownerQuestion++;
      if (all.some((e) => e.type === "owner_wait_finished")) seen.ownerWait++;
      if (all.some((e) => e.type === "owner_message")) seen.ownerMessage++;
      if (all.some((e) => e.type === "participant_dropped")) seen.dropped++;

      for (let k = 1; k <= all.length; k++) {
        const expected = foldEvents(all.slice(0, k));
        const rnd = mulberry32(seed * 1000 + k);
        const extra = rnd() < 0.5 ? { payload: { x: Math.floor(rnd() * 100) }, note: "n" } : {};
        const unknown = JSON.stringify({ seq: k + 1, ts: TS, type: `future_event_${Math.floor(rnd() * 1e6)}`, ...extra }) + "\n";
        const variants: [string, string, "newer_version" | "corrupted"][] = [
          ["неизвестная строка", lines.slice(0, k).join("") + unknown + lines.slice(k).join(""), "newer_version"],
          ["не-JSON строка", lines.slice(0, k).join("") + "это не json\n" + lines.slice(k).join(""), "corrupted"],
          ["обрезанный хвост", lines.slice(0, k).join("") + (k < all.length ? lines[k]!.slice(0, 10) : '{"seq":'), "corrupted"],
        ];
        for (const [name, text, reason] of variants) {
          writeFileSync(path, text);
          const before = sha(path);
          const msg = `seed ${seed}, длина ${all.length}, позиция ${k}, ${name}`;
          const s = readSession(dataDir, "s", () => true)!;
          expect(s.partial, msg).toEqual({ reason, lastEvent: k });
          expect(s.state, msg).toEqual(expected);
          expect(readEvents(dataDir, "s")!.events.length, msg).toBe(k);
          expect(sha(path), `${msg}: байты журнала изменены`).toBe(before);
          seen.cases++;
        }
        if (k === 1) seen.afterCreated++;
        if (k === all.length && all[k - 1]!.type === "session_finished") {
          seen.afterFinished++;
          expect(readSession(dataDir, "s", () => true)!.status, `seed ${seed}: итог после вставки`).toBe((all[k - 1] as Extract<SessionEvent, { type: "session_finished" }>).status);
        }
      }
    }
    for (const [k, v] of Object.entries(seen)) expect(v, `граница ${k} не порождена`).toBeGreaterThan(0);
    console.log("partial-read: случаев", seen.cases, seen);
  });
});
