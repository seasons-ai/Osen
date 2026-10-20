import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSession } from "../engine.ts";
import { createScriptedDriver } from "../participants/scripted.ts";
import type { Scenario } from "../participants/scripted.ts";
import { INSUFFICIENT_ACTIVE_REASON_CODE } from "../protocol/schema.ts";
import type { Limits, SessionEvent } from "../protocol/schema.ts";
import { eventsPath } from "./journal.ts";
import { planResume, ResumeRejectedError, runResumedSession } from "./resume.ts";
import type { ReplacementInput } from "./resume.ts";

// Requirement "Owner message on resume" × "Resume admissibility": an invariant over every status and every kind of message.

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATUSES = ["running", "interrupted", "consensus", "no_consensus", "stopped", "failed_code", "failed_plain", "agreed_unfinished"] as const;
type Status = (typeof STATUSES)[number];
const MESSAGES = [undefined, "", "   \n\t", "Учтите ещё бюджет"] as const;

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const usage = { inputTokens: 1, outputTokens: 1 };
const turn = (n: number, participantId: string, stance: "amend" | "agree" | "object"): Body[] => [
  { type: "turn_started", turn: n, round: 1, participantId },
  {
    type: "turn_completed", turn: n, round: 1, participantId, stance, normalized: false, reasoning: "r",
    solution: stance === "amend" ? "v1" : null, version: 1, questions: [], answers: [], attempts: 1, usage, durationMs: 1,
  },
];

function journal(status: Status, prior: number): Body[] {
  const session = createSession(
    {
      topic: "Тема", framing: "", origin: "cli",
      limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000 } as Limits,
      participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id: "s" },
  );
  const out: Body[] = [{ type: "session_created", session, pid: 1 }];
  // Earlier owner messages go before the first turn: they do not reset the agreement the turns build.
  for (let i = 1; i <= prior; i++) out.push({ type: "owner_message", id: `o${i}`, text: `реплика ${i}`, afterTurn: 0, requestId: `r${i}` });
  out.push(...turn(1, "p1", "amend"));
  const finish = (s: "consensus" | "no_consensus" | "stopped" | "failed", extra: Partial<Extract<Body, { type: "session_finished" }>> = {}): Body =>
    ({ type: "session_finished", status: s, version: 1, agreed: s === "consensus" ? ["p1", "p2"] : ["p1"], objectors: [], ...extra });
  switch (status) {
    case "running":
    case "interrupted":
      return out;
    case "consensus":
      return [...out, ...turn(2, "p2", "agree"), finish("consensus")];
    case "agreed_unfinished":
      return [...out, ...turn(2, "p2", "agree")];
    case "no_consensus":
      return [...out, ...turn(2, "p2", "object"), finish("no_consensus")];
    case "stopped":
      return [...out, ...turn(2, "p2", "object"), finish("stopped")];
    case "failed_code":
      return [...out, { type: "participant_dropped", participantId: "p2", reason: "x" }, finish("failed", { reasonCode: INSUFFICIENT_ACTIVE_REASON_CODE, reason: "x" })];
    case "failed_plain":
      return [...out, { type: "participant_dropped", participantId: "p2", reason: "x" }, finish("failed", { reason: "x" })];
  }
}

const admissible = (status: Status, message: string | undefined) =>
  status === "consensus" ? message !== undefined && message.trim() !== "" : status !== "running" && status !== "failed_plain";

describe("property: owner message on resume", () => {
  it("accepted ⇔ status admissible and consensus has a non-blank message; refusal leaves the bytes; owner_message o(k+1) follows session_resumed", async () => {
    const rnd = mulberry32(170);
    const cases: [Status, (typeof MESSAGES)[number], number][] = [];
    // Every combination once, then random repeats.
    for (const s of STATUSES) for (const m of MESSAGES) for (let k = 0; k <= 3; k++) cases.push([s, m, k]);
    for (let i = 0; i < 40; i++) cases.push([STATUSES[Math.floor(rnd() * STATUSES.length)]!, MESSAGES[Math.floor(rnd() * MESSAGES.length)], Math.floor(rnd() * 4)]);
    for (const [status, message, prior] of cases) {
      const label = `${status} / ${JSON.stringify(message)} / ${prior}`;
      const dir = mkdtempSync(join(tmpdir(), "resume-prop-"));
      dirs.push(dir);
      const path = eventsPath(dir, "s");
      mkdirSync(dirname(path), { recursive: true });
      const bodies = journal(status, prior);
      writeFileSync(path, bodies.map((b, i) => JSON.stringify({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" })).join("\n") + "\n");
      const before = readFileSync(path);
      const isAlive = () => status === "running";
      const replacements: ReplacementInput[] = status.startsWith("failed") ? [{ participantId: "p2", providerId: "scripted", model: "m" }] : [];
      let plan;
      try {
        plan = planResume(dir, "s", { isAlive, rounds: 1, ...(message !== undefined ? { message } : {}), ...(replacements.length ? { replacements } : {}) });
      } catch (e) {
        if (!(e instanceof ResumeRejectedError)) throw e;
        expect(admissible(status, message), `${label}: refused (${e.reason})`).toBe(false);
        expect(readFileSync(path).equals(before), `${label}: journal bytes changed`).toBe(true);
        continue;
      }
      expect(admissible(status, message), `${label}: accepted`).toBe(true);
      const agree: Scenario["steps"][number] = { response: { stance: "agree", reasoning: "r", solution: null, answers: [], questions: [] } };
      const driver = () => createScriptedDriver({ steps: [agree, agree, agree] }, { COUNCIL_DEV: "1" });
      const run = await runResumedSession({ dataDir: dir, plan, drivers: { p1: driver(), p2: driver(), p3: driver() }, isAlive: () => false });
      const i = run.events.findIndex((e) => e.type === "session_resumed");
      const next = run.events[i + 1];
      if (message !== undefined && message.trim() !== "") {
        expect(next, label).toMatchObject({ type: "owner_message", id: `o${prior + 1}`, text: message });
        expect(run.state.resumes.at(-1)?.ownerMessagesBefore, label).toBe(prior);
      } else {
        expect(run.events.filter((e) => e.type === "owner_message"), label).toHaveLength(0);
      }
    }
  });
});
