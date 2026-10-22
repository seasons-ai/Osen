import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage, createScriptedDriver, createSession, draftPath, eventsPath, launchAcceptedPath, materialPath, ownerMessagesDir, readEvents, readSession, requestOwnerMessage, requestStop, resumeLockPath, runStoredSession, launchFilePath } from "@model-council/core";
import type { CliLocation, Scenario, SessionEvent } from "@model-council/core";
import { main } from "../../core/src/cli.ts";
import { resumeScenarioPath, ToolError } from "./context.ts";
import type { ToolContext } from "./context.ts";
import { councilContinue } from "./owner.ts";
import { mcpMessages } from "./messages.ts";
import { councilResume } from "./resume.ts";
import type { ResumeView } from "./resume.ts";
import { councilStatus } from "./status.ts";

const env = { COUNCIL_DEV: "1" };
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), "council-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const notFound = async (agent: "claude" | "codex"): Promise<CliLocation> => ({ agent, found: false, searchPath: "", reason: `Команда ${agent} не найдена` });
const aborts: AbortController[] = [];
afterEach(() => { for (const a of aborts.splice(0)) a.abort(); });

interface Ctx extends ToolContext { logs: string[] }
// scn is a separate scenarios folder: the path key stores the session's model as a file name from the list
function ctxOf(dataDir: string, scn: string | null, over: Partial<ToolContext> = {}): Ctx {
  const logs: string[] = [];
  const ctrl = new AbortController();
  aborts.push(ctrl);
  const ctx: Ctx = {
    dataDir, env, councilLaunch: { command: process.execPath, args: [], env: {} }, pollMs: 20, shutdown: ctrl.signal, builtinTemplatesDir: "", scenariosDir: scn, inspectDeps: { locate: notFound },
    logger: { info: (m: string) => { logs.push(m); }, error: (m: string) => { logs.push(m); } } as ToolContext["logger"], logs, ...over,
  };
  // the detached `council run-prepared` runs in this process: the stubs in inspectDeps cannot be handed to another one
  ctx.spawnExecutor ??= (file, errPath) => main(["run-prepared", file], { stdout: () => {}, stderr: (t) => appendFileSync(errPath, t + "\n"), env: { ...env, COUNCIL_HOME: dataDir }, ...(ctx.inspectDeps ? { inspectDeps: ctx.inspectDeps } : {}) });
  return ctx;
}

type Step = Scenario["steps"][number];
const resp = (stance: string, solution: string | null, usage: { inputTokens?: number } = {}): Step =>
  ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] }, ...usage }) as Step;
const amend = (t: string, u?: { inputTokens?: number }) => resp("amend", t, u);
const agree = (delayMs?: number) => ({ ...resp("agree", null), ...(delayMs ? { delayMs } : {}) }) as Step;
const object = (u?: { inputTokens?: number }) => resp("object", null, u);
const fatal: Step = { error: "fatal", retryable: false };

const until = async <T>(f: () => T | false | undefined | null, ms = 10000): Promise<T> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    let r: T | false | undefined | null;
    try { r = f(); } catch { r = undefined; }
    if (r) return r;
  }
  throw new Error("не дождались");
};
type Ev = Record<string, any> & { type: string; seq: number };
const evs = (dir: string, id: string) => readEvents(dir, id)!.events as unknown as Ev[];
const types = (dir: string, id: string) => evs(dir, id).map((e) => e.type);
const count = (dir: string, id: string, type: string) => types(dir, id).filter((t) => t === type).length;
const bytes = (dir: string, id: string) => readFileSync(eventsPath(dir, id));
const finished = (dir: string, id: string) => until(() => { const s = readSession(dir, id, () => false); return s?.state.finish ? s : null; });
const rejected = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error; } throw new Error("не отклонено"); };
const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;

interface Mk {
  id: string; maxRounds?: number; providers?: string[]; ownerWait?: { pauseAfterRound?: boolean; timeoutSec?: number };
  maxTotalTokens?: number; resumeSteps?: [Step[], Step[]]; first?: [Step, Step]; materials?: { id: string; name: string; text: string }[];
}
// A session that went through one round (p1 amend, p2 object → no_consensus); scenario files contain both past and future steps.
async function prior(dir: string, scn: string, o: Mk, signal?: AbortSignal) {
  mkdirSync(scn, { recursive: true });
  const first = o.first ?? [amend("v1"), object()];
  const rest = o.resumeSteps ?? [[agree()], [agree()]];
  const models = [0, 1].map((i) => { const f = `${o.id}-p${i + 1}.json`; writeFileSync(join(scn, f), JSON.stringify({ steps: [first[i], ...rest[i]!] })); return f; });
  const materials = o.materials?.map((m) => ({ ...m, chars: m.text.length, sha256: createHash("sha256").update(m.text, "utf8").digest("hex") }));
  const session = createSession({
    topic: "Как назвать кота", framing: "", origin: "mcp", ...(o.ownerWait ? { ownerWait: o.ownerWait } : {}), ...(materials ? { materials } : {}),
    limits: { maxRounds: o.maxRounds ?? 1, turnTimeoutSec: 30, contextChars: 20000, ...(o.maxTotalTokens ? { maxTotalTokens: o.maxTotalTokens } : {}), ...(materials ? { materialsChars: 10000 } : {}) },
    participants: models.map((model, i) => ({ name: `N${i + 1}`, providerId: o.providers?.[i] ?? "scripted", model, role: i === 0 ? "критик" : null })),
  }, { maxParticipants: 8, id: o.id });
  const drivers = Object.fromEntries([0, 1].map((i) => [`p${i + 1}`, createScriptedDriver({ steps: [first[i]!] }, env)]));
  await runStoredSession({ session, drivers, dataDir: dir, ...(materials ? { materials: materials.map((m) => ({ ...m })) } : {}), ...(signal ? { signal } : {}), waitPollMs: 20 });
  return session;
}
// the journal is truncated after an event and belongs to a dead executor (alive — the executor is "alive")
function cut(dir: string, id: string, pred: (e: Ev) => boolean, alive = false) {
  const all = evs(dir, id);
  const keep = all.slice(0, all.findIndex(pred) + 1);
  keep[0]!.pid = alive ? 1 : deadPid;
  writeFileSync(eventsPath(dir, id), keep.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
const stripReasonCode = (dir: string, id: string) => {
  const all = evs(dir, id).map((e) => { if (e.type !== "session_finished") return e; const { reasonCode: _drop, ...rest } = e; return rest; });
  writeFileSync(eventsPath(dir, id), all.map((e) => JSON.stringify(e)).join("\n") + "\n");
};
const resume = (ctx: ToolContext, input: Parameters<typeof councilResume.run>[1]) => councilResume.run(ctx, input) as Promise<ResumeView>;
const go = (ctx: ToolContext, id: string, extra: Record<string, unknown> = {}) => resume(ctx, { sessionId: id, ...extra });
const exec = async (ctx: ToolContext, id: string, extra: Record<string, unknown> = {}) => {
  const p = await go(ctx, id, extra);
  return resume(ctx, { sessionId: id, ...extra, execute: true, planToken: p.planToken });
};

/** Refusal: ToolError with the expected text, the journal byte-for-byte unchanged, no lock. */
async function refused(dir: string, id: string, f: () => Promise<unknown>, re: RegExp) {
  const before = bytes(dir, id);
  const e = await rejected(f());
  expect(e).toBeInstanceOf(ToolError);
  expect(e.message).toMatch(re);
  expect(bytes(dir, id).equals(before)).toBe(true);
  expect(existsSync(resumeLockPath(dir, id))).toBe(false);
}

describe("council_resume: plan", () => {
  it("the plan writes nothing, the token is stable, participants are preserved", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    const ctx = ctxOf(dir, scn);
    const before = bytes(dir, "s");
    const a = await go(ctx, "s", { rounds: 2 });
    expect(a).toMatchObject({ sessionId: "s", mode: "plan", accepted: false, status: "no_consensus", source: "mcp", addedRounds: 2, maxRounds: 3, maxCalls: 12, requiresConsent: false, waiting: null });
    expect(a.planToken).toMatch(/^[0-9a-f]{64}$/);
    expect(a.participants).toMatchObject([{ id: "p1", model: "s-p1.json", role: "критик", billing: "free" }, { id: "p2", model: "s-p2.json", role: null, billing: "free" }]);
    expect("droppedOwnerRequests" in a).toBe(false);
    expect(bytes(dir, "s").equals(before)).toBe(true);
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
    expect((await go(ctx, "s", { rounds: 2 })).planToken).toBe(a.planToken);
    expect((await go(ctx, "s", { rounds: 3 })).planToken).not.toBe(a.planToken);
    expect(ctx.logs.join("\n")).toContain("Resume plan of session s from MCP: 2 more rounds, call bound 12");
  });
});

describe("council_resume: owner message on a consensus session", () => {
  const consensus = async (id: string) => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id, first: [amend("v1"), agree()] });
    return { dir, ctx: ctxOf(dir, scn) };
  };

  it("without a message or with a blank one: consensus refusal, journal unchanged", async () => {
    const { dir, ctx } = await consensus("c");
    await refused(dir, "c", () => go(ctx, "c", { rounds: 1 }), /^consensus:/);
    await refused(dir, "c", () => go(ctx, "c", { rounds: 1, message: "   " }), /^consensus:/);
    // the refusal carries the hint that names message and the owner's own words, in both languages
    for (const [lang, hint] of [["en", /only with message.*owner's own words/], ["ru", /только с message.*словами владельца/]] as const) {
      setProcessLanguage(lang);
      try {
        const e = await rejected(go(ctx, "c", { rounds: 1 }));
        expect(e.message).toMatch(/^consensus:/);
        expect(e.message).toMatch(hint);
      } finally { setProcessLanguage("ru"); }
    }
  });

  it("plan with a message: agreementReset, status consensus, journal unchanged; the log never holds the text", async () => {
    const { dir, ctx } = await consensus("c");
    const before = bytes(dir, "c");
    const v = await go(ctx, "c", { rounds: 1, message: "Consider the budget too" });
    expect(v).toMatchObject({ mode: "plan", status: "consensus", agreementReset: true });
    expect(bytes(dir, "c").equals(before)).toBe(true);
    expect(ctx.logs.join("\n")).not.toContain("budget");
  });

  it("a different message at execute: stale_plan, no new events", async () => {
    const { dir, ctx } = await consensus("c");
    const p = await go(ctx, "c", { rounds: 1, message: "A" });
    await refused(dir, "c", () => resume(ctx, { sessionId: "c", rounds: 1, message: "B", execute: true, planToken: p.planToken }), /^stale_plan:/);
  });

  it("the same message at execute: owner_message right after session_resumed, council_status shows afterTurn", async () => {
    const { dir, ctx } = await consensus("c");
    const lastTurn = evs(dir, "c").filter((e) => e.type === "turn_completed").length;
    const v = await exec(ctx, "c", { rounds: 1, message: "Consider the budget too" });
    expect(v).toMatchObject({ accepted: true, agreementReset: true });
    const all = evs(dir, "c");
    const i = all.findIndex((e) => e.type === "session_resumed");
    expect(all[i + 1]).toMatchObject({ type: "owner_message", text: "Consider the budget too" });
    await finished(dir, "c");
    const st = (await councilStatus.run(ctx, { sessionId: "c" })) as any;
    expect(st.ownerMessages.at(-1).afterTurn).toBe(lastTurn);
    expect(ctx.logs.join("\n")).not.toContain("budget");
  });

  it("no_consensus: a message resets agreements, without it nothing changes", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "n" });
    const ctx = ctxOf(dir, scn);
    expect((await go(ctx, "n", { rounds: 1, message: "Hi" })).agreementReset).toBe(true);
    expect((await go(ctx, "n", { rounds: 1 })).agreementReset).toBe(false);
  });
});

describe("council_resume: launch", () => {
  it("answer before the result, one session_resumed, journal prefix unchanged, result in council_status", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s", resumeSteps: [[agree()], [agree(300)]] });
    const ctx = ctxOf(dir, scn);
    const before = bytes(dir, "s");
    const v = await exec(ctx, "s", { rounds: 1 });
    expect(v).toMatchObject({ sessionId: "s", mode: "execute", accepted: true, source: "mcp", droppedOwnerRequests: [] });
    expect(types(dir, "s").at(-1)).not.toBe("session_finished");
    expect(count(dir, "s", "session_finished")).toBe(1);
    expect(count(dir, "s", "session_resumed")).toBe(1);
    const after = bytes(dir, "s");
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    await until(() => count(dir, "s", "session_finished") === 2);
    const st = (await councilStatus.run(ctx, { sessionId: "s" })) as any;
    expect(st.status).toBe("consensus");
    expect(count(dir, "s", "session_resumed")).toBe(1);
    expect(ctx.logs.join("\n")).toContain("Resume of session s from MCP accepted: 1 more rounds, call bound 6, unapplied messages removed 0");
  });

  it("stale_plan: plan for rounds 2, launch with rounds 3", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    const ctx = ctxOf(dir, scn);
    const p = await go(ctx, "s", { rounds: 2 });
    await refused(dir, "s", () => resume(ctx, { sessionId: "s", rounds: 3, execute: true, planToken: p.planToken }), /^stale_plan:/);
    await refused(dir, "s", () => resume(ctx, { sessionId: "s", rounds: 2, execute: true, planToken: "чужой" }), /^stale_plan:/);
  });

  it("stale_plan: the journal changed after the plan", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s", resumeSteps: [[object(), agree()], [agree()]] });
    const ctx = ctxOf(dir, scn);
    const a = await go(ctx, "s", { rounds: 1 });
    await exec(ctx, "s", { rounds: 1 });
    await until(() => count(dir, "s", "session_finished") === 2);
    expect((await finished(dir, "s")).state.finish?.status).toBe("no_consensus");
    await refused(dir, "s", () => resume(ctx, { sessionId: "s", rounds: 1, execute: true, planToken: a.planToken }), /^stale_plan:/);
    expect(count(dir, "s", "session_resumed")).toBe(1);
    const b = await go(ctx, "s", { rounds: 1 });
    expect(b.planToken).not.toBe(a.planToken);
    expect((await resume(ctx, { sessionId: "s", rounds: 1, execute: true, planToken: b.planToken })).accepted).toBe(true);
  });

  it("plan_required: execute without planToken", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    const ctx = ctxOf(dir, scn);
    await refused(dir, "s", () => resume(ctx, { sessionId: "s", rounds: 1, execute: true }), /^plan_required:/);
    await refused(dir, "s", () => resume(ctx, { sessionId: "s", rounds: 1, execute: true, planToken: "" }), /^plan_required:/);
  });

  it("simultaneous launch: one is accepted, the second is busy or running", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s", resumeSteps: [[agree(400)], [agree(400)]] });
    const ctx = ctxOf(dir, scn);
    const p = await go(ctx, "s", { rounds: 1 });
    const call = () => resume(ctx, { sessionId: "s", rounds: 1, execute: true, planToken: p.planToken });
    const r = await Promise.allSettled([call(), call()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const bad = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(bad.reason).toBeInstanceOf(ToolError);
    expect(bad.reason.message).toMatch(/^(busy|running):/);
    expect(count(dir, "s", "session_resumed")).toBe(1);
    await finished(dir, "s");
  });
});

describe("council_resume: journal of a newer version", () => {
  it("council_resume (plan and launch) and council_continue: error with code newer_version, the journal does not change", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "nv" });
    appendFileSync(eventsPath(dir, "nv"), JSON.stringify({ seq: evs(dir, "nv").length + 1, ts: "2026-01-01T00:00:00.000Z", type: "future_event" }) + "\n");
    const n = evs(dir, "nv").length;
    const ctx = ctxOf(dir, scn);
    const re = new RegExp(`^newer_version: Сессия nv: журнал записан более новой версией, прочитан до события №${n}; продолжение невозможно\\. Обновите приложение\\.$`);
    await refused(dir, "nv", () => go(ctx, "nv", { rounds: 1 }), re);
    await refused(dir, "nv", () => exec(ctx, "nv", { rounds: 1 }), re);
    await refused(dir, "nv", () => resume(ctx, { sessionId: "nv", rounds: 1, execute: true, planToken: "x" }), re);
    await refused(dir, "nv", () => councilContinue.run(ctx, { sessionId: "nv", waitId: "w1" }), /^newer_version: .*более новой версией.*Обновите приложение/);
    const e = await rejected(go(ctx, "nv", { rounds: 1 }));
    expect(e.message).not.toMatch(/повреждён/);
  });
});

describe("council_resume: checks before calls", () => {
  it("bounds of rounds and the cap", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    const ctx = ctxOf(dir, scn);
    for (const rounds of [0, 21, 1.5]) await refused(dir, "s", () => go(ctx, "s", { rounds }), /^bad_rounds:/);
    await refused(dir, "s", () => go(ctx, "s"), /^no_rounds_left:.*rounds/);
    await refused(dir, "s", () => go(ctx, "s", { rounds: 1, maxTotalTokens: 0 }), /^bad_token_cap:/);
  });

  it("unknown id, running, consensus, failed, corrupted, material", async () => {
    const dir = tmp(), scn = tmp();
    const ctx = ctxOf(dir, scn);
    expect((await rejected(go(ctx, "20200101-000000-nope", { rounds: 1 }))).message).toMatch(/не найдена/);
    expect((await rejected(go(ctx, "../x", { rounds: 1 }))).message).toMatch(/не найдена/);

    await prior(dir, scn, { id: "run" });
    cut(dir, "run", (e) => e.type === "turn_completed", true);
    await refused(dir, "run", () => go(ctx, "run", { rounds: 1 }), /^running:/);

    await prior(dir, scn, { id: "cons", first: [amend("v1"), agree()] });
    await refused(dir, "cons", () => go(ctx, "cons", { rounds: 1 }), /^consensus:/);

    await prior(dir, scn, { id: "fail", first: [amend("v1"), fatal] });
    stripReasonCode(dir, "fail"); // failure without reasonCode is fixed neither by resuming nor by replacement
    await refused(dir, "fail", () => go(ctx, "fail", { rounds: 1 }), /^failed:/);

    await prior(dir, scn, { id: "bad" });
    appendFileSync(eventsPath(dir, "bad"), '{"seq":99,"ts":"x","ty');
    await refused(dir, "bad", () => go(ctx, "bad", { rounds: 1 }), /^corrupted:/);
    await refused(dir, "bad", () => exec(ctx, "bad", { rounds: 1 }), /^corrupted:/);

    await prior(dir, scn, { id: "mat", materials: [{ id: "m1", name: "a.txt", text: "Текст А" }] });
    writeFileSync(materialPath(dir, "mat", "m1"), "Другой текст");
    await refused(dir, "mat", () => go(ctx, "mat", { rounds: 1 }), /^material:.*a\.txt/);
  });

  it("unavailable participant: no provider in the registry, no scenario; by default nobody is substituted", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "g", providers: ["scripted", "ghost"] });
    const ctx = ctxOf(dir, scn);
    const e = await rejected(go(ctx, "g", { rounds: 1 }));
    expect(e.message).toMatch(/^participant:.*p2.*ghost.*отсутствует в реестре/);
    await refused(dir, "g", () => exec(ctx, "g", { rounds: 1 }), /^participant:/);
    await prior(dir, scn, { id: "n" });
    await refused(dir, "n", () => go(ctxOf(dir, null), "n", { rounds: 1 }), /^participant:.*недоступен/);
    await refused(dir, "n", () => exec(ctxOf(dir, null), "n", { rounds: 1 }), /^participant:/);
    expect(count(dir, "n", "session_created")).toBe(1);
  });
});

describe("council_resume: token cap", () => {
  it("token_cap, then null removes the cap", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "t", maxRounds: 3, maxTotalTokens: 150, first: [amend("v1", { inputTokens: 100 }), object({ inputTokens: 100 })] });
    const s = readSession(dir, "t", () => false)!;
    expect(s.status).toBe("stopped");
    const ctx = ctxOf(dir, scn);
    await refused(dir, "t", () => go(ctx, "t", { rounds: 1 }), /^token_cap:.*maxTotalTokens/);
    const v = await exec(ctx, "t", { rounds: 1, maxTotalTokens: null });
    expect(v).toMatchObject({ accepted: true, status: "stopped", maxTotalTokens: null });
    await finished(dir, "t");
    expect(((await councilStatus.run(ctx, { sessionId: "t" })) as any).maxTotalTokens).toBeNull();
  });
});

describe("council_resume: waiting for the owner", () => {
  // the executor is cut off in the pause after a round: the journal ends with owner_wait_started
  async function waited(dir: string, scn: string, timeoutSec: number) {
    const ctl = new AbortController();
    const p = prior(dir, scn, { id: "w", maxRounds: 3, ownerWait: { pauseAfterRound: true, timeoutSec } }, ctl.signal);
    await until(() => types(dir, "w").includes("owner_wait_started"));
    ctl.abort();
    await p;
    cut(dir, "w", (e) => e.type === "owner_wait_started");
  }

  it("deadline not reached: no turns until the wait is cleared", async () => {
    const dir = tmp(), scn = tmp();
    await waited(dir, scn, 60);
    const ctx = ctxOf(dir, scn);
    const v = await exec(ctx, "w", { rounds: 2 });
    expect(v.status).toBe("interrupted");
    expect(v.waiting).toMatchObject({ expired: false });
    const turns = () => count(dir, "w", "turn_started");
    const n = turns();
    await new Promise((r) => setTimeout(r, 300));
    expect(turns()).toBe(n);
    await councilContinue.run(ctx, { sessionId: "w", waitId: v.waiting!.waitId });
    expect((await finished(dir, "w")).state.finish?.status).toBe("consensus");
    expect(turns()).toBeGreaterThan(n);
  });

  it("deadline passed: the end of the wait is recorded before the first new turn", async () => {
    const dir = tmp(), scn = tmp();
    await waited(dir, scn, 1);
    await new Promise((r) => setTimeout(r, 1200));
    const v = await exec(ctxOf(dir, scn), "w", { rounds: 2 });
    expect(v.waiting).toMatchObject({ expired: true });
    await finished(dir, "w");
    const all = evs(dir, "w");
    const resumed = all.findIndex((e) => e.type === "session_resumed");
    const done = all.findIndex((e, i) => i > resumed && e.type === "owner_wait_finished");
    const turn = all.findIndex((e, i) => i > resumed && e.type === "turn_started");
    expect(all[done]).toMatchObject({ reason: "expired" });
    expect(done).toBeLessThan(turn);
  });
});

describe("council_resume: server shutdown and log journal", () => {
  it("aborting ctx.shutdown does not stop a resumed session: it lives in the executor; a stop request ends it", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s", resumeSteps: [[agree()], [agree(1500)]] });
    const ctrl = new AbortController();
    const ctx = ctxOf(dir, scn, { shutdown: ctrl.signal });
    await exec(ctx, "s", { rounds: 1 });
    const done = () => count(dir, "s", "turn_completed");
    await until(() => done() === 3);
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 200));
    expect(readSession(dir, "s", () => false)!.state.finish?.status).not.toBe("stopped");
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(true);
    await until(() => count(dir, "s", "session_finished") === 2);
    expect(readSession(dir, "s", () => false)!.status).toBe("consensus");
  });

  it("a stop request ends a resumed session as stopped, completed turns are preserved", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s", resumeSteps: [[agree()], [agree(5000)]] });
    const ctx = ctxOf(dir, scn);
    await exec(ctx, "s", { rounds: 1 });
    const done = () => count(dir, "s", "turn_completed");
    await until(() => done() === 3);
    const kept = done();
    requestStop(dir, "s");
    await until(() => !existsSync(resumeLockPath(dir, "s")));
    const s = readSession(dir, "s", () => false)!;
    expect(s.status).toBe("stopped");
    expect(s.state.turns).toHaveLength(kept);
  });

  it("an unapplied owner message is returned in the response but does not get into the log; planToken too", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s", maxRounds: 3 });
    cut(dir, "s", (e) => e.type === "turn_completed");
    const secret = "СЕКРЕТНАЯ-РЕПЛИКА-77";
    mkdirSync(ownerMessagesDir(dir, "s"), { recursive: true });
    const { requestId } = requestOwnerMessage(dir, "s", secret, { isAlive: () => true });
    expect(readdirSync(ownerMessagesDir(dir, "s"))).toHaveLength(1);
    const ctx = ctxOf(dir, scn);
    const p = await go(ctx, "s", { rounds: 2 });
    const v = await resume(ctx, { sessionId: "s", rounds: 2, execute: true, planToken: p.planToken });
    expect(v.droppedOwnerRequests).toEqual([{ requestId, text: secret, questionId: null }]);
    expect(v.next).toContain("отправить заново");
    await finished(dir, "s");
    const log = ctx.logs.join("\n");
    expect(log).not.toContain(secret);
    expect(log).not.toContain(p.planToken);
    expect(log).toContain("unapplied messages removed 1");
  });
});

describe("resumeScenarioPath", () => {
  it("name from the list, absolute path, relative path, nonexistent, no folder", () => {
    const scn = tmp(), other = tmp();
    writeFileSync(join(scn, "a.json"), "{}");
    writeFileSync(join(other, "b.json"), "{}");
    expect(resumeScenarioPath(scn, "a.json")).toBe(join(scn, "a.json"));
    expect(resumeScenarioPath(scn, join(other, "b.json"))).toBe(join(other, "b.json"));
    expect(resumeScenarioPath(scn, "b.json")).toBeNull();
    expect(resumeScenarioPath(scn, "../b.json")).toBeNull();
    expect(resumeScenarioPath(scn, join(other, "нет.json"))).toBeNull();
    expect(resumeScenarioPath(null, "a.json")).toBeNull();
    expect(resumeScenarioPath(null, join(other, "b.json"))).toBeNull();
  });
});

describe("council_resume: independent drafts", () => {
  // three participants with a phase; the journal is truncated when p1 is accepted and p2 has an attempt started without an outcome
  async function drafted(dir: string, scn: string, id: string) {
    mkdirSync(scn, { recursive: true });
    const steps: Step[][] = [[amend("Ч1"), amend("v1"), agree(), agree()], [amend("Ч2"), amend("Ч2"), object(), agree()], [amend("Ч3"), object(), agree(), agree()]];
    const models = steps.map((st, i) => { const f = `${id}-p${i + 1}.json`; writeFileSync(join(scn, f), JSON.stringify({ steps: st })); return f; });
    const session = createSession({
      topic: "Т", framing: "", origin: "mcp", drafts: {}, limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 20000 },
      participants: models.map((model, i) => ({ name: `N${i + 1}`, providerId: "scripted", model, role: null })),
    }, { maxParticipants: 8, id });
    const drivers = Object.fromEntries(steps.map((st, i) => [`p${i + 1}`, createScriptedDriver({ steps: st }, env)]));
    await runStoredSession({ session, drivers, dataDir: dir, waitPollMs: 20 });
    cut(dir, id, (e) => e.type === "draft_attempt_started" && e.participantId === "p2");
  }

  it("plan: draftCalls 5, maxCalls includes the remainder; execute with the token is accepted; another rounds — stale_plan", async () => {
    const dir = tmp(), scn = tmp();
    await drafted(dir, scn, "dr");
    const ctx = ctxOf(dir, scn);
    const a = await go(ctx, "dr", { rounds: 2 });
    expect(a).toMatchObject({ status: "interrupted", draftCalls: 5, maxCalls: 3 * 2 * 3 + 5 });
    expect(a.next).toContain("5");
    await refused(dir, "dr", () => resume(ctx, { sessionId: "dr", rounds: 3, execute: true, planToken: a.planToken }), /^stale_plan:/);
    const r = await resume(ctx, { sessionId: "dr", rounds: 2, execute: true, planToken: a.planToken });
    expect(r).toMatchObject({ accepted: true, draftCalls: 5 });
  });

  it("corrupted snapshot of an accepted draft: draft refusal, the journal is unchanged", async () => {
    const dir = tmp(), scn = tmp();
    await drafted(dir, scn, "db");
    writeFileSync(draftPath(dir, "db", "d1"), "испорчено");
    await refused(dir, "db", () => go(ctxOf(dir, scn), "db", { rounds: 1 }), /^draft:/);
  });

  it("session without drafts: draftCalls 0, maxCalls as before", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    expect(await go(ctxOf(dir, scn), "s", { rounds: 2 })).toMatchObject({ draftCalls: 0, maxCalls: 12 });
  });
});

describe("council_resume: participant replacements", () => {
  const newScn = (scn: string, name = "new.json", steps: Step[] = [agree()]) => { writeFileSync(join(scn, name), JSON.stringify({ steps })); return name; };
  const map = (model: string, participantId = "p2") => ({ participantId, providerId: "scripted", model });
  // p2 dropped out by a failure in the first round: session failed with reasonCode "fewer than two active"
  async function failedSession(dir: string, scn: string, id = "f") {
    await prior(dir, scn, { id, first: [amend("v1"), fatal] });
    expect(readSession(dir, id, () => false)!.status).toBe("failed");
  }

  it("plan: replace p2 → p3, agreements reset, bound for two active; journal and models untouched", async () => {
    const dir = tmp(), scn = tmp();
    await failedSession(dir, scn);
    const m = newScn(scn);
    const ctx = ctxOf(dir, scn);
    const before = bytes(dir, "f");
    const v = await go(ctx, "f", { rounds: 1, replacements: [map(m)] });
    expect(v).toMatchObject({ mode: "plan", accepted: false, status: "failed", agreementReset: true, maxCalls: 2 * 1 * 3 });
    expect(v.replacements).toMatchObject([{ oldParticipantId: "p2", oldName: "N2", newParticipantId: "p3", providerId: "scripted", model: m, role: null }]);
    expect(v.replacements[0]!.reason).toMatch(/^выбыл: /);
    expect(v.participants.map((p) => p.id)).toEqual(["p1", "p3"]);
    expect(v.planToken).toMatch(/^[0-9a-f]{64}$/);
    expect(v.next).toContain("замену");
    expect(bytes(dir, "f").equals(before)).toBe(true);
    expect(existsSync(resumeLockPath(dir, "f"))).toBe(false);
  });

  it("the name of a new replacement follows the council_start rules: provider label and model, #n on a match; not 'Participant N'", async () => {
    const dir = tmp(), scn = tmp();
    await failedSession(dir, scn);
    const ctx = ctxOf(dir, scn);
    const m = newScn(scn);
    const v = await go(ctx, "f", { rounds: 1, replacements: [map(m)] });
    expect(v.replacements[0]!.name).toBe(`Сценарный (${m})`);
    expect(v.participants.find((p) => p.id === "p3")!.name).toBe(`Сценарный (${m})`);
    // the same model as the live p1: a matching base gives #2
    const same = newScn(scn, "f-p1.json");
    const w = await go(ctx, "f", { rounds: 1, replacements: [map(same)] });
    expect(w.replacements[0]!.name).toBe(`Сценарный (${same}) #2`);
  });

  it("launch: one session_resumed with replacements, council_status shows the links, the result is consensus", async () => {
    const dir = tmp(), scn = tmp();
    await failedSession(dir, scn);
    const m = newScn(scn);
    const ctx = ctxOf(dir, scn);
    const v = await exec(ctx, "f", { rounds: 1, replacements: [map(m)] });
    expect(v).toMatchObject({ accepted: true, mode: "execute", agreementReset: true });
    expect(count(dir, "f", "session_resumed")).toBe(1);
    const ev = evs(dir, "f").find((e) => e.type === "session_resumed")!;
    expect(ev.replacements).toMatchObject([{ oldParticipantId: "p2", participant: { id: "p3", model: m } }]);
    await until(() => count(dir, "f", "session_finished") === 2);
    const st = (await councilStatus.run(ctx, { sessionId: "f" })) as any;
    expect(st.participants.find((p: any) => p.id === "p2")).toMatchObject({ state: "dropped", replacedBy: "p3" });
    expect(st.participants.find((p: any) => p.id === "p3")).toMatchObject({ state: "active", replaces: "p2" });
    expect(st.status).toBe("consensus");
  });

  it("another model in the map at execute: stale_plan, the journal and the owner request are intact, no lock", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "f", maxRounds: 3 });
    cut(dir, "f", (e) => e.type === "turn_completed");
    rmSync(join(scn, "f-p2.json"));
    const m = newScn(scn), other = newScn(scn, "other.json");
    const ctx = ctxOf(dir, scn);
    mkdirSync(ownerMessagesDir(dir, "f"), { recursive: true });
    requestOwnerMessage(dir, "f", "реплика", { isAlive: () => true });
    const p = await go(ctx, "f", { rounds: 2, replacements: [map(m)] });
    await refused(dir, "f", () => resume(ctx, { sessionId: "f", rounds: 2, replacements: [map(other)], execute: true, planToken: p.planToken }), /^stale_plan:/);
    expect(readdirSync(ownerMessagesDir(dir, "f"))).toHaveLength(1);
  });

  it("availability changed between plan and launch: stale_plan with a reason, the journal as before", async () => {
    const dir = tmp(), scn = tmp();
    await failedSession(dir, scn);
    const m = newScn(scn);
    const ctx = ctxOf(dir, scn);
    const p = await go(ctx, "f", { rounds: 1, replacements: [map(m)] });
    rmSync(join(scn, m));
    await refused(dir, "f", () => resume(ctx, { sessionId: "f", rounds: 1, replacements: [map(m)], execute: true, planToken: p.planToken }), /^stale_plan:.*Причина: .*p3/s);
  });

  it("the order of entries in the map does not change planToken", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "t", providers: ["ghost", "ghost"], first: [fatal, fatal] });
    const a = newScn(scn, "a.json"), b = newScn(scn, "b.json");
    const ctx = ctxOf(dir, scn);
    const r = [map(a, "p1"), map(b, "p2")];
    const x = await go(ctx, "t", { rounds: 1, replacements: r });
    const y = await go(ctx, "t", { rounds: 1, replacements: [...r].reverse() });
    expect(x.planToken).toBe(y.planToken);
  });

  it("language: stale_plan and replacement on en and ru give the same codes; the en text has no Cyrillic", async () => {
    const dir = tmp(), scn = tmp(), fdir = tmp(), fscn = tmp();
    await prior(dir, scn, { id: "s" });
    await failedSession(fdir, fscn);
    const m = newScn(fscn);
    const texts: Record<string, string[]> = {};
    for (const lang of ["ru", "en"] as const) {
      setProcessLanguage(lang);
      try {
        const ctx = ctxOf(dir, scn), fctx = ctxOf(fdir, fscn);
        const p = await go(ctx, "s", { rounds: 2 });
        const stale = await rejected(resume(ctx, { sessionId: "s", rounds: 3, execute: true, planToken: p.planToken }));
        const rep = await rejected(go(fctx, "f", { rounds: 1, replacements: [map(m, "p9")] }));
        expect(stale).toBeInstanceOf(ToolError);
        expect(stale.message).toMatch(/^stale_plan: /);
        expect(rep.message).toMatch(/^replacement: /);
        texts[lang] = [stale.message, rep.message];
      } finally { setProcessLanguage("ru"); }
    }
    for (const t of texts["en"]!) expect(t).not.toMatch(/[А-Яа-яЁё]/);
    expect(texts["ru"]![0]).toMatch(/устарел/);
    expect(texts["en"]![0]).toMatch(/out of date/);
  });

  it("bad map: replacement:, the server keeps working; without a map — too_few_active; without reasonCode — failed", async () => {
    const dir = tmp(), scn = tmp();
    await failedSession(dir, scn);
    const m = newScn(scn);
    const ctx = ctxOf(dir, scn);
    await refused(dir, "f", () => go(ctx, "f", { rounds: 1, replacements: [map(m), map(m)] }), /^replacement:/);
    expect(((await councilStatus.run(ctx, { sessionId: "f" })) as any).status).toBe("failed");
    await refused(dir, "f", () => go(ctx, "f", { rounds: 1, replacements: [map(m, "p9")] }), /^replacement:/);
    await refused(dir, "f", () => go(ctx, "f", { rounds: 1, replacements: [map(m, "p1"), map(m)] }), /^replacement:/); // p1 is available
    await refused(dir, "f", () => go(ctx, "f", { rounds: 1 }), /^too_few_active:.*p2/s);
    await exec(ctx, "f", { rounds: 1, replacements: [map(m)] });
    await until(() => count(dir, "f", "session_finished") === 2);
    await prior(dir, scn, { id: "g", first: [amend("v1"), fatal] });
    stripReasonCode(dir, "g");
    await refused(dir, "g", () => go(ctx, "g", { rounds: 1, replacements: [map(m)] }), /^failed:/);
  });

  it("an already replaced one is replaced: replacement:", async () => {
    const dir = tmp(), scn = tmp();
    await failedSession(dir, scn);
    const m = newScn(scn, "new.json", [object(), object(), object()]);
    const ctx = ctxOf(dir, scn);
    await exec(ctx, "f", { rounds: 1, replacements: [map(m)] });
    await until(() => count(dir, "f", "session_finished") === 2);
    await refused(dir, "f", () => go(ctx, "f", { rounds: 1, replacements: [map(m)] }), /^replacement:/);
  });

  it("stopped session with a missing scenario: without a map participant:, with a map — unavailable", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "n" });
    const m = newScn(scn);
    rmSync(join(scn, "n-p2.json"));
    const ctx = ctxOf(dir, scn);
    await refused(dir, "n", () => go(ctx, "n", { rounds: 1 }), /^participant:.*p2/);
    const v = await go(ctx, "n", { rounds: 1, replacements: [map(m)] });
    expect(v.replacements[0]).toMatchObject({ oldParticipantId: "p2", newParticipantId: "p3" });
    expect(v.replacements[0]!.reason).toMatch(/^недоступен: /);
  });

  it("an available active participant cannot be replaced: replacement:", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "n" });
    const m = newScn(scn);
    await refused(dir, "n", () => go(ctxOf(dir, scn), "n", { rounds: 1, replacements: [map(m)] }), /^replacement:/);
  });

  it("simultaneous launch with a map: one is accepted, the second is busy or running; one session_resumed", async () => {
    const dir = tmp(), scn = tmp();
    await failedSession(dir, scn);
    const m = newScn(scn, "new.json", [agree(400)]);
    const ctx = ctxOf(dir, scn);
    const input = { sessionId: "f", rounds: 1, replacements: [map(m)] };
    const p = await go(ctx, "f", input);
    const call = () => resume(ctx, { ...input, execute: true, planToken: p.planToken });
    const r = await Promise.allSettled([call(), call()]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const bad = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(bad.reason.message).toMatch(/^(busy|running|stale_plan):/);
    expect(count(dir, "f", "session_resumed")).toBe(1);
    await finished(dir, "f");
  });
});

describe("council_resume: detached executor", () => {
  const launchLeft = (dir: string) => (existsSync(join(dir, "launch")) ? readdirSync(join(dir, "launch")) : []);
  // spy: records each launch file the server hands over and lets `before` act between the server check and the executor
  function spied(dir: string, scn: string, before: (file: string) => void = () => {}) {
    const launches: any[] = [];
    const base = ctxOf(dir, scn);
    const run = base.spawnExecutor!;
    const ctx = ctxOf(dir, scn, { spawnExecutor: (file, errPath) => { launches.push(JSON.parse(readFileSync(file, "utf8"))); before(file); return run(file, errPath); } });
    return { ctx, launches };
  }

  it("execute hands a resume launch file to the executor; dropped owner requests come from the accepted file; launch/ is empty", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s", maxRounds: 3 });
    cut(dir, "s", (e) => e.type === "turn_completed");
    mkdirSync(ownerMessagesDir(dir, "s"), { recursive: true });
    const { requestId } = requestOwnerMessage(dir, "s", "старая реплика", { isAlive: () => true });
    const { ctx, launches } = spied(dir, scn);
    const size = bytes(dir, "s").length;
    const v = await exec(ctx, "s", { rounds: 2, message: "Учтите бюджет" });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ kind: "resume", sessionId: "s", rounds: 2, message: "Учтите бюджет", journalBytes: size });
    expect(Object.keys(launches[0].scenarios).sort()).toEqual(["s-p1.json", "s-p2.json"]);
    expect(v.droppedOwnerRequests).toEqual([{ requestId, text: "старая реплика", questionId: null }]);
    expect(count(dir, "s", "session_resumed")).toBe(1);
    expect(launchLeft(dir)).toEqual([]);
    await finished(dir, "s");
  });

  it("consensus session with a message and rounds 1: owner_message right after session_resumed, through the executor", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "c", first: [amend("v1"), agree()] });
    const { ctx, launches } = spied(dir, scn);
    const v = await exec(ctx, "c", { rounds: 1, message: "Учтите ещё бюджет" });
    expect(v.accepted).toBe(true);
    expect(launches.map((l) => l.kind)).toEqual(["resume"]);
    const all = evs(dir, "c");
    const i = all.findIndex((e) => e.type === "session_resumed");
    expect(all[i + 1]).toMatchObject({ type: "owner_message", text: "Учтите ещё бюджет" });
    await finished(dir, "c");
    expect(launchLeft(dir)).toEqual([]);
  });

  it("the journal changed between the server check and the executor: stale_plan with the usual text, nothing written, launch/ empty", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    let grown = 0;
    const { ctx } = spied(dir, scn, () => {
      // a harmless change of the journal bytes: the pid of the first event
      const all = evs(dir, "s");
      all[0]!.pid = 9999999;
      writeFileSync(eventsPath(dir, "s"), all.map((e) => JSON.stringify(e)).join("\n") + "\n");
      grown = bytes(dir, "s").length;
    });
    const e = await rejected(exec(ctx, "s", { rounds: 1 }));
    expect(e).toBeInstanceOf(ToolError);
    expect(e.message).toBe(`stale_plan: ${mcpMessages().resumeStale}`);
    expect(count(dir, "s", "session_resumed")).toBe(0);
    expect(bytes(dir, "s").length).toBe(grown);
    expect(launchLeft(dir)).toEqual([]);
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
  });

  it("the lock is held when the executor starts: busy; a scenario removed before it starts: stale_plan", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    const lock = resumeLockPath(dir, "s");
    const held = spied(dir, scn, () => writeFileSync(lock, String(process.ppid)));
    const before = bytes(dir, "s");
    const e = await rejected(exec(held.ctx, "s", { rounds: 1 }));
    expect(e).toBeInstanceOf(ToolError);
    expect(e.message).toMatch(/^busy:/);
    expect(bytes(dir, "s").equals(before)).toBe(true);
    expect(launchLeft(dir)).toEqual([]);
    rmSync(lock, { force: true });
    const gone = spied(dir, scn, () => rmSync(join(scn, "s-p2.json")));
    const f = await rejected(exec(gone.ctx, "s", { rounds: 1 }));
    expect(f.message).toMatch(/^stale_plan:/);
    expect(bytes(dir, "s").equals(before)).toBe(true);
    expect(launchLeft(dir)).toEqual([]);
  });

  it("executor start failure and timeout: ToolError, journal unchanged, launch/ empty", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    const before = bytes(dir, "s");
    const failing = ctxOf(dir, scn, { spawnExecutor: async (_f, errPath) => { appendFileSync(errPath, "Error: cannot start the executor\n"); return 2; }, startPollMs: 20 });
    const e = await rejected(exec(failing, "s", { rounds: 1 }));
    expect(e).toBeInstanceOf(ToolError);
    expect(e.message).toContain("cannot start the executor");
    expect(bytes(dir, "s").equals(before)).toBe(true);
    expect(launchLeft(dir)).toEqual([]);
    const silent = ctxOf(dir, scn, { spawnExecutor: () => new Promise<number>(() => {}), startTimeoutMs: 300, startPollMs: 20 });
    const t = await rejected(exec(silent, "s", { rounds: 1 }));
    expect(t).toBeInstanceOf(ToolError);
    expect(t.message).toBe(mcpMessages().startExecutorTimeout(0));
    expect(bytes(dir, "s").equals(before)).toBe(true);
    expect(launchLeft(dir)).toEqual([]);
  });

  // change 199: the executor accepts one poll step after the deadline
  it("resume accepted one poll step after the deadline: accepted, launch/ empty; not accepted: timeout error, launch/ empty", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    const late = ctxOf(dir, scn, { startTimeoutMs: 300, startPollMs: 200, spawnExecutor: (file) => {
      setTimeout(() => { writeFileSync(launchAcceptedPath(file), JSON.stringify({ droppedOwnerRequests: [] })); appendFileSync(eventsPath(dir, "s"), "\n"); }, 450);
      return new Promise<number>(() => {});
    } });
    const v = await exec(late, "s", { rounds: 1 });
    expect(v.accepted).toBe(true);
    expect(launchLeft(dir)).toEqual([]);
    const dir2 = tmp(), scn2 = tmp();
    await prior(dir2, scn2, { id: "s" });
    const silent = ctxOf(dir2, scn2, { spawnExecutor: () => new Promise<number>(() => {}), startTimeoutMs: 300, startPollMs: 200 });
    const t = await rejected(exec(silent, "s", { rounds: 1 }));
    expect(t).toBeInstanceOf(ToolError);
    expect(t.message).toBe(mcpMessages().startExecutorTimeout(0));
    expect(launchLeft(dir2)).toEqual([]);
  });

  // change 187: two launches of one session must not share launch files
  const busyLine = JSON.stringify({ code: "busy", message: "held by another executor" }) + "\n";

  it("the loser's busy survives the winner's cleanup: the second launch is refused with busy, not as a start failure; launch/ is empty", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    const p = await go(ctxOf(dir, scn), "s", { rounds: 1 });
    const call = (ctx: ToolContext) => resume(ctx, { sessionId: "s", rounds: 1, execute: true, planToken: p.planToken });
    let release!: (code: number) => void;
    let started!: () => void;
    const bStarted = new Promise<void>((r) => { started = r; });
    // B's executor has already printed its busy refusal and exits only after A is accepted and has cleaned up
    const ctxB = ctxOf(dir, scn, { startPollMs: 20, spawnExecutor: (_f, errPath) => { appendFileSync(errPath, busyLine); started(); return new Promise<number>((r) => { release = r; }); } });
    const b = rejected(call(ctxB));
    await bStarted;
    const a = await call(ctxOf(dir, scn));
    expect(a.accepted).toBe(true);
    release(2);
    const e = await b;
    expect(e).toBeInstanceOf(ToolError);
    expect(e.message).toMatch(/^busy:/);
    expect(count(dir, "s", "session_resumed")).toBe(1);
    await finished(dir, "s");
    expect(launchLeft(dir)).toEqual([]);
  });

  it("a second launch while the first waits for acceptance does not remove the first's accepted file: the first is accepted at once", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    const p = await go(ctxOf(dir, scn), "s", { rounds: 1 });
    const call = (ctx: ToolContext) => resume(ctx, { sessionId: "s", rounds: 1, execute: true, planToken: p.planToken });
    const ctxB = ctxOf(dir, scn, { startPollMs: 20, spawnExecutor: async (_f, errPath) => { appendFileSync(errPath, busyLine); return 2; } });
    let second: Error | undefined;
    // A's executor wrote its accepted file; B starts (it passes the plan check: the journal is unchanged) and is refused completely before A's session_resumed
    const ctxA = ctxOf(dir, scn, { startTimeoutMs: 3000, startPollMs: 20, spawnExecutor: async (file) => {
      writeFileSync(launchAcceptedPath(file), JSON.stringify({ droppedOwnerRequests: [] }));
      second = await rejected(call(ctxB));
      appendFileSync(eventsPath(dir, "s"), "\n"); // stand-in for session_resumed: the journal grows
      return new Promise<number>(() => {});
    } });
    const t0 = Date.now();
    const a = await call(ctxA);
    expect(a.accepted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(second?.message).toMatch(/^busy:/);
    expect(launchLeft(dir)).toEqual([]);
  });

  it("acceptance counts only with session_resumed in the journal: an accepted file without it, or a stale one from before, is a ToolError", async () => {
    const dir = tmp(), scn = tmp();
    await prior(dir, scn, { id: "s" });
    const before = bytes(dir, "s");
    // the executor wrote the accepted file and died before session_resumed
    const dying = ctxOf(dir, scn, { spawnExecutor: async (file) => { writeFileSync(launchAcceptedPath(file), JSON.stringify({ droppedOwnerRequests: [] })); return 1; }, startPollMs: 20 });
    const e = await rejected(exec(dying, "s", { rounds: 1 }));
    expect(e).toBeInstanceOf(ToolError);
    expect(bytes(dir, "s").equals(before)).toBe(true);
    expect(launchLeft(dir)).toEqual([]);
    // accepted files of an earlier version (no launchId) and of another launch of this session are neither taken nor removed
    mkdirSync(join(dir, "launch"), { recursive: true });
    const old = JSON.stringify({ droppedOwnerRequests: [{ requestId: "old", text: "old", questionId: null }] });
    const foreign = [join(dir, "launch", "s.accepted.json"), launchAcceptedPath(launchFilePath(dir, "s", "other-launch"))];
    for (const f of foreign) writeFileSync(f, old);
    const v = await exec(ctxOf(dir, scn), "s", { rounds: 1 });
    expect(v.droppedOwnerRequests).toEqual([]);
    expect(count(dir, "s", "session_resumed")).toBe(1);
    expect(foreign.every((f) => readFileSync(f, "utf8") === old)).toBe(true);
    await finished(dir, "s");
  });
});
