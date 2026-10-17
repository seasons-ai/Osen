import { afterEach, describe, expect, it } from "vitest";
import { createSession, runSession } from "../engine.ts";
import type { StreamChunk } from "../engine.ts";
import type { Limits, SessionEvent } from "../protocol/schema.ts";
import { createHttpDriver } from "./driver.ts";
import { startFakeServer } from "./fake-server.ts";
import type { FakeServer } from "./fake-server.ts";
import type { HttpRuntime } from "./types.ts";

const KEY = "sk-secret-123";
const servers: FakeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });
const start = async (opts: Parameters<typeof startFakeServer>[0] = {}) => { const s = await startFakeServer(opts); servers.push(s); return s; };

async function go(runtime: HttpRuntime, models: string[], over: Partial<Limits> = {}, extra: { onChunk?: (c: StreamChunk) => void; signal?: AbortSignal } = {}) {
  const session = createSession(
    {
      topic: "Как назвать кота", framing: "", origin: "cli",
      limits: { maxRounds: 2, turnTimeoutSec: 30, contextChars: 20000, ...over },
      participants: models.map((model, i) => ({ name: `N${i + 1}`, providerId: "http", model, role: null })),
    },
    { maxParticipants: 8, id: "s1", now: () => new Date("2026-01-01T00:00:00Z") },
  );
  const drivers = Object.fromEntries(models.map((_, i) => [`p${i + 1}`, createHttpDriver(runtime)]));
  return runSession({ session, drivers, ...extra });
}
const of = <T extends SessionEvent["type"]>(events: SessionEvent[], type: T) => events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type);
const status = (events: SessionEvent[]) => of(events, "session_finished")[0]!.status;
const rt = (s: FakeServer, over: Partial<HttpRuntime> = {}): HttpRuntime => ({ baseUrl: s.url, keyFile: "/data/.env", ...over });

describe("HTTP driver in the engine", () => {
  it("consensus of two participants, usage and chunks", async () => {
    const s = await start();
    const chunks: StreamChunk[] = [];
    const { events } = await go(rt(s), ["fake-amend", "fake-agree"], {}, { onChunk: (c) => chunks.push(c) });
    expect(status(events)).toBe("consensus");
    for (const e of of(events, "turn_completed")) expect(e.usage).toStrictEqual({ inputTokens: 11, outputTokens: 7 });
    expect(chunks.filter((c) => c.participantId === "p1").length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.participantId === "p2")).toBe(true);
    const known = new Set(["session_created", "turn_started", "turn_completed", "turn_failed", "participant_dropped", "question_closed", "session_finished"]);
    for (const e of events) expect(known.has(e.type)).toBe(true);
  });

  it("hung participant: two timeouts and dropout", async () => {
    const s = await start();
    const { events } = await go(rt(s), ["fake-hang", "fake-amend", "fake-agree"], { turnTimeoutSec: 1 });
    const failed = of(events, "turn_failed").filter((e) => e.participantId === "p1");
    expect(failed.map((e) => e.kind)).toEqual(["timeout", "timeout"]);
    expect(of(events, "participant_dropped").some((e) => e.participantId === "p1")).toBe(true);
    expect(of(events, "session_finished")).toHaveLength(1);
  }, 15000);

  it("request limit: two attempts and dropout", async () => {
    const s = await start();
    const { events } = await go(rt(s), ["fake-rate", "fake-amend", "fake-agree"]);
    const failed = of(events, "turn_failed").filter((e) => e.participantId === "p1");
    expect(failed.map((e) => e.attempt)).toEqual([1, 2]);
    for (const e of failed) expect(e.message.startsWith("Превышен лимит запросов")).toBe(true);
    expect(of(events, "participant_dropped").some((e) => e.participantId === "p1")).toBe(true);
  });

  it("unknown model: one failure and dropout", async () => {
    const s = await start();
    const { events } = await go(rt(s), ["nope-model", "fake-amend", "fake-agree"]);
    expect(of(events, "turn_failed").filter((e) => e.participantId === "p1")).toHaveLength(1);
    const dropped = of(events, "participant_dropped").find((e) => e.participantId === "p1")!;
    expect(dropped.reason).toContain("nope-model");
  });

  it("authorization refused: key does not leak", async () => {
    const s = await start();
    const { events } = await go(rt(s, { apiKeyEnv: "MY_KEY", apiKey: KEY }), ["fake-auth", "fake-amend", "fake-agree"]);
    expect(of(events, "turn_failed").filter((e) => e.participantId === "p1")).toHaveLength(1);
    expect(of(events, "participant_dropped").some((e) => e.participantId === "p1")).toBe(true);
    const all = JSON.stringify(events);
    expect(all).not.toContain(KEY);
    expect(all).toContain("MY_KEY");
  });

  it("stop during the stream", async () => {
    const s = await start();
    const ctl = new AbortController();
    const { events } = await go(rt(s), ["fake-slow", "fake-agree"], {}, { signal: ctl.signal, onChunk: () => ctl.abort() });
    expect(status(events)).toBe("stopped");
    await import("vitest").then(({ vi }) => vi.waitFor(() => expect(s.closedEarly).toBe(1)));
  });

  it("endpoint unavailable", async () => {
    const s = await start();
    const runtime = rt(s);
    await s.close();
    const { events } = await go(runtime, ["fake-amend", "fake-agree", "fake-agree"]);
    const failed = of(events, "turn_failed");
    expect(failed.length).toBeGreaterThan(0);
    for (const e of failed) { expect(e.message.startsWith("Эндпоинт недоступен: ")).toBe(true); expect(e.message).toContain(runtime.baseUrl); }
    expect(of(events, "participant_dropped").length).toBeGreaterThanOrEqual(2);
    expect(status(events)).toBe("failed");
  });
});
