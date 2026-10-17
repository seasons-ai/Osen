import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScriptedDriver, createSession, eventsPath, getProcessLanguage, listSessions, readEvents, runStoredSession, setProcessLanguage } from "@model-council/core";
import type { Scenario } from "@model-council/core";
import { ToolError } from "./context.ts";
import type { ToolContext } from "./context.ts";
import { TOOLS } from "./server.ts";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const env = { COUNCIL_DEV: "1" };
const root = realpathSync(mkdtempSync(join(tmpdir(), "council-lang-")));
const dir = join(root, "data");
const scn = join(root, "scn");
const deadOwner = spawnSync(process.execPath, ["-e", ""]).pid!;
const ctx = (): ToolContext => ({
  dataDir: dir, env, pollMs: 20, shutdown: new AbortController().signal,
  logger: { info: () => {}, error: () => {} }, builtinTemplatesDir: join(import.meta.dirname, "../../../templates"), scenariosDir: scn,
  inspectDeps: { locate: async (agent) => ({ agent, found: false, searchPath: "", reason: "нет" }) },
});

const step = (stance: string, solution: string | null) =>
  ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } }) as Scenario["steps"][number];

async function prepare(id: string, second: "agree" | "object", cutAfterTurn = false) {
  const steps = [step("amend", "v1"), step(second, null)];
  const models = [0, 1].map((i) => { const f = `${id}-p${i + 1}.json`; writeFileSync(join(scn, f), JSON.stringify({ steps: [steps[i], step("agree", null)] })); return f; });
  const session = createSession({
    topic: "Как назвать кота", framing: "", origin: "mcp",
    limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 20000 },
    participants: models.map((model, i) => ({ name: `N${i + 1}`, providerId: "scripted", model, role: null })),
  }, { maxParticipants: 8, id });
  const drivers = Object.fromEntries([0, 1].map((i) => [`p${i + 1}`, createScriptedDriver({ steps: [steps[i]!] }, env)]));
  await runStoredSession({ session, drivers, dataDir: dir, waitPollMs: 20 });
  if (cutAfterTurn) { // session interrupted: the journal is truncated, the executor is dead
    const all = readEvents(dir, id)!.events as unknown as { type: string; pid?: number }[];
    const keep = all.slice(0, all.findIndex((e) => e.type === "turn_completed") + 1);
    keep[0]!.pid = deadOwner;
    writeFileSync(eventsPath(dir, id), keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
}

beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  mkdirSync(scn, { recursive: true });
  await prepare("s-consensus", "agree");
  await prepare("s-noconsensus", "object");
  await prepare("s-interrupted", "object", true);
}, 60000);
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

// The values of these fields are not text for the owner: they are compared, not just checked for presence.
const CODE_KEYS = new Set(["status", "reasonCode", "sessionId", "mode", "source", "planToken", "id", "providerId", "model", "billing", "state", "lastStance", "stance", "participantId", "authorId", "templateId", "kind"]);

// Key tree (arrays — by the first element) plus the values of code fields, numbers and booleans.
function shape(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0], key)];
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, k)]));
  if (typeof v === "string") return CODE_KEYS.has(key) ? v : "<text>";
  return v;
}
// Failure code — a prefix like `stale_plan: ...`.
const errCode = (m: string) => /^([a-z_]+): /.exec(m)?.[1] ?? null;

interface Call { tool: string; input: Record<string, unknown>; klass: string }
const unknownId = "20200101-000000-nope";
const known = ["s-consensus", "s-noconsensus", "s-interrupted"];

function gen(seed: number): Call {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(a: readonly T[]) => a[int(a.length)]!;
  const sid = () => pick([unknownId, ...known]);
  const name = pick(TOOLS.map((t) => t.name));
  switch (name) {
    case "council_options": return { tool: name, input: {}, klass: "options" };
    case "council_start": {
      const c = pick([
        { klass: "empty-topic", input: { topic: pick(["", "   "]) } },
        { klass: "bad-provider", input: { topic: "Тема", participants: [{ providerId: "nope" }, { providerId: "nope2" }] } },
        { klass: "lineup+participants", input: { topic: "Тема", lineupId: "x", participants: [{ providerId: "scripted", model: "a.json" }] } },
        { klass: "bad-lineup", input: { topic: "Тема", lineupId: "no-such-lineup" } },
        { klass: "bad-rounds", input: { topic: "Тема", maxRounds: pick([0, 99, 1.5]) } },
        { klass: "bad-template", input: { topic: "Тема", templateId: "no-such-template" } },
        { klass: "bad-wait", input: { topic: "Тема", ownerWaitSec: pick([-5, Number.NaN]) } },
      ]);
      return { tool: name, ...c };
    }
    case "council_status": {
      const id = sid();
      return { tool: name, input: { sessionId: id, ...(rnd() < 0.5 ? { waitSec: pick([0, -1, Number.NaN]) } : {}) }, klass: id === unknownId ? "status-unknown" : "status-known" };
    }
    case "council_stop": { const id = pick([unknownId, "s-consensus"]); return { tool: name, input: { sessionId: id }, klass: id === unknownId ? "stop-unknown" : "stop-finished" }; }
    case "council_say": return { tool: name, input: { sessionId: unknownId, text: pick(["", "привет"]) }, klass: "say-unknown" };
    case "council_continue": { const id = pick([unknownId, "s-consensus"]); return { tool: name, input: { sessionId: id, waitId: "w1" }, klass: id === unknownId ? "continue-unknown" : "continue-finished" }; }
    default: {
      const id = rnd() < 0.7 ? "s-noconsensus" : pick([...known, unknownId]); // resumable session more often than the others
      const c = pick([
        { klass: "resume-plan", input: { sessionId: id, ...(rnd() < 0.8 ? { rounds: 1 + int(3) } : {}) } },
        { klass: "stale_plan", input: { sessionId: id, rounds: 2, execute: true, planToken: "0".repeat(64) } },
        { klass: "plan_required", input: { sessionId: id, execute: true } },
        { klass: "bad_rounds", input: { sessionId: id, rounds: pick([0, 99, 1.5]) } },
        { klass: "replacement", input: { sessionId: id, replacements: [{ participantId: "p9", providerId: "scripted", model: "s-noconsensus-p1.json" }] } },
      ]);
      return { tool: name, ...c };
    }
  }
}

type Out = { failed: false; value: unknown } | { failed: true; code: string | null; text: string };
async function run(c: Call, lang: "en" | "ru"): Promise<Out> {
  setProcessLanguage(lang);
  const tool = TOOLS.find((t) => t.name === c.tool)!;
  try {
    return { failed: false, value: await (tool.run as (x: ToolContext, i: unknown) => Promise<unknown>)(ctx(), c.input) };
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    return { failed: true, code: errCode(e.message), text: e.message };
  }
}

describe("Invariance of names, codes and structure of MCP server responses", () => {
  it("200 random calls: en and ru give the same structure, the same codes and values", async () => {
    const before = listSessions(dir).length;
    const counts = { stale: 0, replacement: 0, statusDone: 0, options: 0, unknownId: 0, emptyTopic: 0 };
    try {
      for (let seed = 1; seed <= 200; seed++) {
        const c = gen(seed);
        const en = await run(c, "en");
        const ru = await run(c, "ru");
        const msg = `seed ${seed} ${c.tool} ${c.klass} ${JSON.stringify(c.input)}`;
        expect(en.failed, msg).toBe(ru.failed);
        if (en.failed && ru.failed) {
          expect(en.code, msg).toBe(ru.code);
          expect(en.text.length > 0 && ru.text.length > 0, msg).toBe(true);
          if (en.code === "stale_plan") counts.stale++;
          if (c.klass === "empty-topic") counts.emptyTopic++;
          if (c.klass.endsWith("unknown")) counts.unknownId++;
        } else if (!en.failed && !ru.failed) {
          expect(shape(en.value), msg).toEqual(shape(ru.value));
          if (c.tool === "council_status" && (en.value as { status?: string }).status === "consensus") counts.statusDone++;
          if (c.tool === "council_options") counts.options++;
        }
        if (c.klass === "replacement") counts.replacement++;
      }
    } finally { setProcessLanguage("ru"); }
    expect(getProcessLanguage()).toBe("ru");
    expect(listSessions(dir).length).toBe(before); // the calls started nothing
    for (const [k, v] of Object.entries(counts)) expect(v, k).toBeGreaterThan(0);
  }, 60000);
});
