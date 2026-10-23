import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDriver } from "./driver.ts";
import { cleanupStubs, stub } from "./stub.fixture.ts";
import type { Stub } from "./stub.fixture.ts";
import { ParticipantCallError } from "../participants/driver.ts";
import type { TurnRequest } from "../participants/driver.ts";
import type { CliAgent } from "./types.ts";

// Own temp folder: other test files create council-turn-* folders in the shared one at the same time.
const sharedTmp = tmpdir();
const ownTmp = mkdtempSync(join(sharedTmp, "driver-process-test-"));
process.env.TMPDIR = ownTmp;
const turnDirs = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("council-turn-")));
let before: Set<string>;
beforeAll(() => { before = turnDirs(); });
afterEach(cleanupStubs);
afterAll(() => {
  try {
    expect([...turnDirs()].filter((n) => !before.has(n))).toEqual([]);
  } finally {
    process.env.TMPDIR = sharedTmp;
    rmSync(ownTmp, { recursive: true, force: true });
  }
});

const turnDirOf = (s: Stub) => join(readFileSync(s.proto("pwd"), "utf8").trim(), "..");
const answer = { stance: "agree", reasoning: "r", solution: null, answers: [], questions: [] };
const validClaude = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "text", structured_output: answer });

function start(s: Stub, signal: AbortSignal = new AbortController().signal) {
  const chunks: string[] = [];
  const req: TurnRequest = {
    participant: { id: "p1", name: "N1", providerId: "x", model: "default", role: null },
    prompt: "question", language: "en", timeoutSec: 30, signal, onChunk: (t) => chunks.push(t),
  };
  return { chunks, p: createCliDriver(s.runtime).call(req) };
}

const rejection = async (p: Promise<unknown>): Promise<ParticipantCallError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ParticipantCallError);
  return e as ParticipantCallError;
};

/** The turn is rejected, nothing was streamed, and the turn folder of the call is gone. */
async function expectRejected(s: Stub): Promise<ParticipantCallError> {
  const { p, chunks } = start(s);
  const e = await rejection(p);
  expect(chunks).toEqual([]);
  expect(existsSync(turnDirOf(s))).toBe(false);
  return e;
}

const waitFor = async (cond: () => boolean, ceilingMs = 20_000): Promise<boolean> => {
  for (let t = 0; t < ceilingMs; t += 50) { if (cond()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return cond();
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (s: Stub, name: string) => Number(readFileSync(s.proto(name), "utf8"));

const bothAgents: CliAgent[] = ["claude", "codex"];
const garbage = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

describe("Stub processes in contract checks", () => {
  it("Stub processes in contract checks: exit code 1 rejects even a fully valid output", async () => {
    await expectRejected(stub("claude", { stdout: validClaude, code: 1 }));
  });

  it("Stub processes in contract checks: output truncated mid-JSON is a retryable rejection with the output tail", async () => {
    const cut = validClaude.slice(0, 40);
    const e = await expectRejected(stub("claude", { stdout: cut }));
    expect(e.retryable).toBe(true);
    expect(e.message).toContain(cut.slice(-20));
  });

  it.each(bothAgents)("Stub processes in contract checks: binary garbage at code 0 is rejected (%s)", async (agent) => {
    await expectRejected(stub(agent, { stdout: garbage }));
  });

  it.each(bothAgents)("Stub processes in contract checks: empty output at code 0 is rejected (%s)", async (agent) => {
    await expectRejected(stub(agent, { stdout: "" }));
  });

  it("Stub processes in contract checks: timeout ends the process", async () => {
    const s = stub("claude", { sleep: 30 });
    const ac = new AbortController();
    const { p, chunks } = start(s, ac.signal);
    expect(await waitFor(() => s.has("ls"))).toBe(true);
    ac.abort();
    const e = await rejection(p);
    expect(e.kind).toBe("timeout");
    expect(chunks).toEqual([]);
    expect(await waitFor(() => !alive(pidOf(s, "pid")))).toBe(true);
    expect(existsSync(turnDirOf(s))).toBe(false);
  }, 60_000);

  it("Stub processes in contract checks: stop ends the process and its child", async () => {
    const s = stub("claude", { sleep: 30, child: true });
    const ac = new AbortController();
    const { p } = start(s, ac.signal);
    expect(await waitFor(() => s.has("ls") && s.has("child"))).toBe(true);
    const [pid, child] = [pidOf(s, "pid"), pidOf(s, "child")];
    expect(alive(child)).toBe(true);
    ac.abort();
    await rejection(p);
    expect(await waitFor(() => !alive(pid) && !alive(child))).toBe(true);
    expect(existsSync(turnDirOf(s))).toBe(false);
  }, 60_000);

  it("Таймаут и прерывание: потомок игнорирует SIGTERM — the stub has exited, its SIGTERM-ignoring child gets SIGKILL", async () => {
    const s = stub("claude", { sleep: 30, child: "ignores-term" });
    const ac = new AbortController();
    const { p } = start(s, ac.signal);
    expect(await waitFor(() => s.has("ls") && s.has("child") && readFileSync(s.proto("child"), "utf8").trim() !== "")).toBe(true);
    const [pid, child] = [pidOf(s, "pid"), pidOf(s, "child")];
    try {
      ac.abort();
      await rejection(p);
      expect(await waitFor(() => !alive(pid) && !alive(child))).toBe(true);
    } finally { try { process.kill(child, "SIGKILL"); } catch { /* already gone */ } }
  }, 60_000);
});
