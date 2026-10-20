import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createCliDriver, createLogger, createSession, inspectProvider, listSessions, resetDiscoveryCache, resetGuardCache, runStoredSession, setProcessLanguage } from "@model-council/core";
import type { InspectDeps, ParticipantDriver, SessionEvent } from "@model-council/core";
import { addLocalEntry } from "../../core/src/cli-agents/verified-record.ts";
import { claudeTurn, installStub, realEntry, runs, tamper } from "../../core/src/cli-agents/launch-guard.fixture.ts";
import { ToolError } from "./context.ts";
import type { ToolContext } from "./context.ts";
import { councilOptions } from "./options.ts";
import type { OptionsView } from "./options.ts";
import { councilStart } from "./start.ts";
import { councilStatus } from "./status.ts";

const R = "Отказ при несовпадении закрепления CLI";
const V = "9.1.0"; // not in the built-in record: only the local record decides
const FIX = join(import.meta.dirname, "../../core/src/cli-agents/fixtures");
const helpText = readFileSync(join(FIX, "claude-2.1.288-help.txt"), "utf8");

const roots: string[] = [];
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

let root: string;
let data: string;
beforeEach(() => {
  setProcessLanguage("ru");
  resetDiscoveryCache();
  resetGuardCache();
  root = mkdtempSync(join(tmpdir(), "mcp-pin-guard-"));
  roots.push(root);
  data = join(root, "data");
  mkdirSync(join(root, "bin")); // empty: no CLI on PATH, so a PATH binary can never be what runs
  chmodSync(join(root, "bin"), 0o755);
});

// the real locate (no `locate` override): the pin guard runs inside discovery
const inspectDeps = (): Partial<InspectDeps> => ({
  readHelp: async () => helpText,
  readFeatures: async () => "",
  listModels: (async () => ({ models: [], confirmed: false })) as InspectDeps["listModels"],
});
const ctxOf = (): ToolContext => {
  const env = { PATH: join(root, "bin"), SHELL: "/usr/bin/false", COUNCIL_DEV: "1" };
  return {
    dataDir: data, env, logger: createLogger(data, "mcp", env), builtinTemplatesDir: join(import.meta.dirname, "../../../templates"),
    scenariosDir: join(import.meta.dirname, "../../core/scenarios"), shutdown: new AbortController().signal,
    councilLaunch: { command: process.execPath, args: [join(import.meta.dirname, "../../core/src/council.ts")], env: {} }, inspectDeps: inspectDeps(),
  };
};
const options = () => councilOptions.run(ctxOf(), {}) as Promise<OptionsView>;

/** Pinned and verified claude; the registry is created while the pin still matches, so it lists claude. */
async function pinned(turn?: string): Promise<string> {
  const binary = await installStub(data, V, { entries: [realEntry(V)] }, turn);
  expect(addLocalEntry(data, realEntry(V)).ok).toBe(true);
  expect((await options()).providers.find((p) => p.id === "claude")).toMatchObject({ available: true, reason: null });
  rmSync(`${binary}.runs`, { force: true }); // the inspection probed --version
  return binary;
}

describe(R, () => {
  it(`${R}: council_options marks a tampered pinned provider unavailable with the checksum reason (ru)`, async () => {
    const binary = await pinned();
    tamper(binary);
    const claude = (await options()).providers.find((p) => p.id === "claude")!;
    expect(claude).toMatchObject({ kind: "cli", available: false });
    expect(claude.reason).toContain("контрольная сумма не совпала");
    expect(claude.reason).toContain(binary);
    expect(runs(binary)).toBe(0);
  });

  it(`${R}: council_options marks a tampered pinned provider unavailable with the checksum reason (en)`, async () => {
    const binary = await pinned();
    tamper(binary);
    setProcessLanguage("en");
    const claude = (await options()).providers.find((p) => p.id === "claude")!;
    expect(claude.available).toBe(false);
    expect(claude.reason).toMatch(/checksum does not match/);
    expect(claude.reason).not.toContain("контрольная");
    expect(runs(binary)).toBe(0);
  });

  it(`${R}: council_start refuses a participant with a tampered pinned provider before a session exists`, async () => {
    const binary = await pinned();
    tamper(binary);
    const e = await (councilStart.run(ctxOf(), { topic: "Тема", participants: [{ providerId: "claude", model: "default" }, { providerId: "scripted", model: "consensus/p2.json" }] }) as Promise<unknown>).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    expect((e as Error).message).toContain("Claude Code");
    expect((e as Error).message).toContain("контрольная сумма не совпала");
    expect(listSessions(data)).toEqual([]);
    expect(runs(binary)).toBe(0);
  });

  it(`${R}: council_status shows a participant dropped after a mid-session swap with the mismatch reason, the others go on`, async () => {
    const binary = await pinned(claudeTurn("amend", "v1")); // the stub answers p1's turns with an amendment
    const found = await inspectProvider({ id: "claude", kind: "cli", label: "Claude Code", agent: "claude", models: [] }, { env: ctxOf().env, dataDir: data, deps: inspectDeps() });
    if (!found.runtime) throw new Error(found.status.reason);
    const amend = (solution: string): ParticipantDriver => ({ call: async () => ({ text: JSON.stringify({ stance: "amend", reasoning: "r", solution, answers: [], questions: [] }), usage: { inputTokens: 1, outputTokens: 1 } }) });
    const session = createSession(
      {
        topic: "T", framing: "", origin: "mcp", limits: { maxRounds: 2, turnTimeoutSec: 30, contextChars: 20000 },
        participants: ["claude", "scripted", "scripted"].map((providerId, i) => ({ name: `N${i + 1}`, providerId, model: "m", role: null })),
      },
      { maxParticipants: 8, id: "s1" },
    );
    let swappedOnce = false;
    resetGuardCache();
    await runStoredSession({
      session, dataDir: data, drivers: { p1: createCliDriver(found.runtime), p2: amend("v2"), p3: amend("v3") },
      onEvent: (ev: SessionEvent) => { if (!swappedOnce && ev.type === "turn_completed" && ev.participantId === "p1") { swappedOnce = true; tamper(binary); } },
    });
    expect(swappedOnce).toBe(true);
    const view = await councilStatus.run(ctxOf(), { sessionId: "s1" }) as { participants: { id: string; state: string; dropReason?: string }[] };
    const by = Object.fromEntries(view.participants.map((p) => [p.id, p]));
    expect(by["p1"]).toMatchObject({ state: "dropped" });
    expect(by["p1"]!.dropReason).toContain("контрольная сумма не совпала");
    expect(by["p2"]).toMatchObject({ state: "active" });
    expect(by["p3"]).toMatchObject({ state: "active" });
    expect(by["p2"]!.dropReason).toBeUndefined();
    expect(runs(binary)).toBe(2); // the guard probe and the turn before the swap; nothing after it
  }, 30000);
});
