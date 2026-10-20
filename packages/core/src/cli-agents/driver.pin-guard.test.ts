import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, runSession } from "../engine.ts";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { ParticipantCallError } from "../participants/driver.ts";
import type { ParticipantDriver, TurnRequest } from "../participants/driver.ts";
import type { SessionEvent } from "../protocol/schema.ts";
import type { CliProvider } from "../registry/config.ts";
import { inspectProvider } from "../registry/providers.ts";
import { createCliDriver } from "./driver.ts";
import { resetDiscoveryCache } from "./discovery.ts";
import { claudeTurn, installStub, realEntry, runs, tamper } from "./launch-guard.fixture.ts";
import { resetGuardCache } from "./launch-guard.ts";
import { pinsPath, usePin } from "./pins.ts";
import { addLocalEntry } from "./verified-record.ts";

const R = "Проверка закреплённой установки перед запуском";
const helpText = readFileSync(resolve(import.meta.dirname, "fixtures/claude-2.1.288-help.txt"), "utf8");
const V1 = "9.1.0";
const V2 = "9.2.0";
const record = { entries: [realEntry(V1), realEntry(V2)] };

let root: string;
let data: string;
beforeEach(() => {
  setProcessLanguage("en");
  resetDiscoveryCache();
  resetGuardCache();
  root = mkdtempSync(join(tmpdir(), "driver-guard-"));
  data = join(root, "data");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const provider: CliProvider = { id: "claude", kind: "cli", label: "Claude Code", agent: "claude", models: [] };
const inspect = () =>
  inspectProvider(provider, {
    env: { PATH: join(root, "empty"), SHELL: "/usr/bin/false" }, dataDir: data,
    deps: { listModels: async () => ({ models: [], confirmed: false }), readHelp: async () => helpText },
  });

async function setup(turn?: string) {
  const v2 = await installStub(data, V2, record, turn);
  const v1 = await installStub(data, V1, record, turn); // V1 is active
  for (const v of [V1, V2]) expect(addLocalEntry(data, realEntry(v)).ok).toBe(true);
  const r = await inspect();
  if (!r.runtime) throw new Error(r.status.reason);
  for (const b of [v1, v2]) rmSync(`${b}.runs`, { force: true }); // the inspection probed --version
  return { v1, v2, runtime: r.runtime };
}

const request = (): TurnRequest => ({
  participant: { id: "p1", name: "N1", providerId: "claude", model: "default", role: null },
  prompt: "q", language: "en", timeoutSec: 30, signal: new AbortController().signal, onChunk: () => {},
});
const rejection = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ParticipantCallError);
  return e as ParticipantCallError;
};

describe(R, () => {
  it(`${R}: binary replaced after inspection`, async () => {
    const { v1, runtime } = await setup();
    const driver = createCliDriver(runtime);
    tamper(v1);
    const e = await rejection(driver.call(request()));
    expect(e).toMatchObject({ kind: "call_error", retryable: false });
    expect(e.message).toBe((await inspect()).status.reason); // same reason as a fresh inspection
    expect(e.message).toContain("checksum");
    expect(runs(v1)).toBe(0);
  });

  it(`${R}: unchanged pin runs the turn`, async () => {
    const { v1, runtime } = await setup();
    const out = await createCliDriver(runtime).call(request());
    expect(out.text).toContain("agree");
    expect(runs(v1)).toBe(2); // the guard's --version probe and the turn
  });

  it(`${R}: pin switched in the middle of a session`, async () => {
    const { v1, v2, runtime } = await setup();
    const driver = createCliDriver(runtime);
    expect(usePin(data, "claude", V2, { record }).ok).toBe(true);
    const e = await rejection(driver.call(request()));
    expect(e).toMatchObject({ kind: "call_error", retryable: false });
    expect(e.message).toContain(v2);
    expect(e.message).toContain(v1);
    expect(runs(v1)).toBe(0);
    expect(runs(v2)).toBe(0);
  });

  it(`${R}: pins.json gone after inspection means no active pin, no check`, async () => {
    const { v1, runtime } = await setup();
    rmSync(pinsPath(data));
    await createCliDriver(runtime).call(request());
    expect(runs(v1)).toBe(1); // the turn only
  });

  it(`${R}: usage and journal when the binary is replaced between turns`, async () => {
    const { v1, runtime } = await setup(claudeTurn("amend", "v1"));
    const pinned = createCliDriver(runtime);
    const other: ParticipantDriver = { call: async () => ({ text: JSON.stringify({ stance: "amend", reasoning: "r", solution: "v2", answers: [], questions: [] }), usage: { inputTokens: 1, outputTokens: 1 } }) };
    const session = createSession(
      {
        topic: "T", framing: "", origin: "cli", limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000 },
        participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "x", model: "default", role: null })),
      },
      { maxParticipants: 8, id: "s1" },
    );
    let before: string[] | undefined;
    const all: SessionEvent[] = [];
    const { events } = await runSession({
      session, drivers: { p1: pinned, p2: other },
      onEvent: (ev) => {
        all.push(ev);
        if (!before && ev.type === "turn_completed" && ev.participantId === "p1") { before = all.map((e) => JSON.stringify(e)); tamper(v1); }
      },
    });
    expect(before).toBeDefined();
    // everything written before the swap is byte-identical afterwards
    expect(events.slice(0, before!.length).map((e) => JSON.stringify(e))).toEqual(before);
    const p1Failed = events.filter((e) => e.type === "turn_failed" && e.participantId === "p1");
    expect(p1Failed).toHaveLength(1); // no retry
    expect(events.some((e) => e.type === "participant_dropped" && e.participantId === "p1")).toBe(true);
    // the rejected turn has no usage; p1 completed exactly the one turn before the swap
    expect(events.filter((e) => e.type === "turn_completed" && e.participantId === "p1")).toHaveLength(1);
    expect((p1Failed[0] as { usage?: unknown }).usage).toBeUndefined();
    expect(runs(v1)).toBe(2); // guard probe + turn of the first call; nothing after the swap
  }, 30000);
});
