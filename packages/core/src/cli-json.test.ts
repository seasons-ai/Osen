import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import type { CliIo } from "./cli.ts";
import { setProcessLanguage } from "./i18n/index.ts";
import { appendEvent, createSessionJournal, eventsPath, readEvents } from "./store/journal.ts";
import { applyEvent } from "./protocol/fold.ts";
import { initialState, sessionTotals } from "./protocol/state.ts";
import type { SessionEvent } from "./protocol/schema.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-json-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(() => setProcessLanguage("ru"));

const sc = (dir: string, file: string) => `scripted:${join(import.meta.dirname, "../scenarios", dir, file)}`;
const two = ["--participant", sc("consensus", "p1.json"), "--participant", sc("consensus", "p2.json")];
const three = ["--participant", sc("no-consensus", "p1.json"), "--participant", sc("no-consensus", "p2.json"), "--participant", sc("no-consensus", "p3.json")];

async function run(argv: string[], home: string, over: { inspectDeps?: CliIo["inspectDeps"] } = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, {
    stdout: (t) => out.push(t), stderr: (t) => err.push(t),
    env: { COUNCIL_HOME: home, COUNCIL_DEV: "1" },
    inspectDeps: { locate: async (agent) => ({ agent, found: false, searchPath: "", reason: `Команда ${agent} не найдена` }), ...over.inspectDeps },
  });
  return { code, out, err: err.join("\n") };
}
// the single stdout call parsed as JSON
const doc = (r: { out: string[] }) => { expect(r.out).toHaveLength(1); return JSON.parse(r.out[0]!); };
const sessionIds = (home: string) => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []);

async function start(home: string, argv: string[], topic = "Как назвать кота", rounds = "3") {
  const before = new Set(sessionIds(home));
  await run(["--topic", topic, ...argv, "--max-rounds", rounds], home);
  return sessionIds(home).find((i) => !before.has(i))!;
}

const ts = "2026-01-01T00:00:00.000Z";
const session = (id: string) => ({
  id, createdAt: ts, origin: "cli" as const, topic: "Тема", templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
});
const turn = (seq: number, questions: { id: string; to: string; text: string }[] = []): SessionEvent => ({
  seq, ts, type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "amend", normalized: false,
  reasoning: "r", solution: "Text", version: 1, questions, answers: [], attempts: 1, usage: {}, durationMs: 1,
});
function make(home: string, id: string, events: SessionEvent[]) {
  createSessionJournal(home, id);
  appendEvent(home, id, { seq: 1, ts, type: "session_created", session: session(id), pid: 1 });
  for (const e of events) appendEvent(home, id, e);
  return id;
}

describe("council --json", () => {
  it("refusal: --json on commands without machine output exits 2 with an empty stdout and no new session", async () => {
    const home = tmp();
    const id = await start(home, two);
    const before = sessionIds(home);
    const cases = [
      ["say", id, "x"], ["stop", id], ["continue", id], ["resume", id], ["home"],
      ["lineups", "save", "n", "--from-session", id],
      ["--topic", "x", ...two],
    ];
    for (const argv of cases) {
      const r = await run([...argv, "--json"], home);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.out, argv.join(" ")).toEqual([]);
      expect(r.err, argv.join(" ")).toContain("--json");
      expect(r.err, argv.join(" ")).toContain("Использование:");
    }
    expect((await run(["lineups", "save", "n", "--from-session", id, "--json"], home)).err).toContain("lineups save");
    expect(sessionIds(home)).toEqual(before);
  });

  it("list: one document with raw statuses, full topic, and byte-equal in en and ru", async () => {
    const home = tmp();
    const topic = `Line one "quoted"\nline two ${"x".repeat(80)}`;
    const a = await start(home, two, topic);
    const b = await start(home, three, "Как назвать кота", "2");
    const r = await run(["list", "--json"], home);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.schemaVersion).toBe(1);
    expect(Object.keys(d)).toEqual(["schemaVersion", "sessions"]);
    const byId = Object.fromEntries(d.sessions.map((s: { id: string }) => [s.id, s]));
    expect(byId[a].status).toBe("consensus");
    expect(byId[a].topic).toBe(topic);
    expect(byId[a].partial).toBeNull();
    expect(Object.keys(byId[a])).toEqual(["id", "createdAt", "status", "origin", "topic", "partial"]);
    expect(byId[b].status).toBe("no_consensus");
    setProcessLanguage("en");
    const en = await run(["list", "--json"], home);
    expect(en.out).toEqual(r.out);
  });

  it("list: an empty data dir gives sessions [] and code 0", async () => {
    const r = await run(["list", "--json"], tmp());
    expect([r.code, doc(r)]).toEqual([0, { schemaVersion: 1, sessions: [] }]);
  });

  it("list: partial journals carry reason and lastEvent, other sessions are still listed", async () => {
    const home = tmp();
    await start(home, two);
    make(home, "bad", [turn(2)]);
    appendFileSync(eventsPath(home, "bad"), '{"seq":3,"ts":"');
    make(home, "newer", [turn(2)]);
    appendFileSync(eventsPath(home, "newer"), `{"seq":3,"ts":"${ts}","type":"future_event"}\n`);
    const r = await run(["list", "--json"], home);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(d.sessions).toHaveLength(3);
    const get = (id: string) => d.sessions.find((s: { id: string }) => s.id === id);
    expect(get("bad").partial).toEqual({ reason: "corrupted", lastEvent: 2 });
    expect(get("newer").partial).toEqual({ reason: "newer_version", lastEvent: 2 });
    const st = doc(await run(["status", "newer", "--json"], home));
    expect(st.partial.reason).toBe("newer_version");
  });

  it("show: consensus gives finish, current version text equal to the text decision, totals equal sessionTotals", async () => {
    const home = tmp();
    const id = await start(home, two);
    const r = await run(["show", id, "--json"], home);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(Object.keys(d)).toEqual(["schemaVersion", "id", "status", "partial", "finish", "currentVersion", "agreed", "waiting", "ownerSelection", "totals"]);
    expect(d.finish.status).toBe("consensus");
    expect(d.ownerSelection).toBeNull();
    expect(d.waiting).toBeNull();
    const text = await run(["show", id], home);
    expect(text.out.join("\n")).toContain(`Решение:\n${d.currentVersion.text}`);
    expect(d.currentVersion.text).toBe("Назвать кота Мурзик Великий.");
    const state = readEvents(home, id)!.events.reduce(applyEvent, initialState());
    const t = sessionTotals(state);
    expect(d.totals).toEqual({ turns: t.turns, drafts: t.drafts, durationMs: t.durationMs, inputTokens: t.inputTokens, outputTokens: t.outputTokens, costUsd: t.costUsd, incomplete: t.incomplete });
  });

  it("show: no_consensus lists the objecting participants", async () => {
    const home = tmp();
    const id = await start(home, three, "Как назвать кота", "2");
    const d = doc(await run(["show", id, "--json"], home));
    expect(d.finish.status).toBe("no_consensus");
    expect(d.finish.objecting.length).toBeGreaterThan(0);
    expect(Object.keys(d.finish.objecting[0])).toEqual(["participantId", "reasoning"]);
  });

  it("status: a finished session has waiting null and numeric round fields", async () => {
    const home = tmp();
    const id = await start(home, two);
    const r = await run(["status", id, "--json"], home);
    expect(r.code).toBe(0);
    const d = doc(r);
    expect(Object.keys(d)).toEqual(["schemaVersion", "id", "status", "partial", "round", "maxRounds", "turns", "waiting"]);
    expect(d.waiting).toBeNull();
    expect(d.status).toBe("consensus");
    expect([typeof d.round, d.maxRounds, typeof d.turns]).toEqual(["number", 3, "number"]);
  });

  it("status and show: an owner wait gives waitId, reasons, questions and deadline", async () => {
    const home = tmp();
    const deadline = new Date(Date.now() + 120_000).toISOString();
    make(home, "w", [
      turn(2, [{ id: "q1", to: "owner", text: "Table or text?" }]),
      { seq: 3, ts, type: "owner_wait_started", waitId: "w1", reasons: ["round_boundary", "owner_question"], questionIds: ["q1", "q9"], afterTurn: 1, deadline },
    ]);
    const expected = {
      waitId: "w1", reasons: ["round_boundary", "owner_question"], deadline,
      questions: [{ id: "q1", from: "p1", text: "Table or text?" }, { id: "q9", from: null, text: null }],
    };
    expect(doc(await run(["status", "w", "--json"], home)).waiting).toEqual(expected);
    expect(doc(await run(["show", "w", "--json"], home)).waiting).toEqual(expected);
  });

  it("unknown session: status and show --json exit 2 with an empty stdout", async () => {
    const home = tmp();
    for (const cmd of ["status", "show"]) {
      const r = await run([cmd, "nope", "--json"], home);
      expect([r.code, r.out]).toEqual([2, []]);
      expect(r.err).not.toBe("");
    }
  });

  it("providers: one document, warning in the provider and in stderr, no key value", async () => {
    const home = tmp();
    const found = async (agent: "claude" | "codex") => agent === "claude"
      ? { agent, found: true as const, path: "/nope/claude", version: "9.9.9", searchPath: "", warning: "version is newer than tested" }
      : { agent, found: false as const, searchPath: "", reason: "not found" };
    const r = await run(["providers", "--json"], home, { inspectDeps: { locate: found, listModels: async () => ({ models: [], confirmed: false, reason: "no list" }), readHelp: async () => "" } });
    expect(r.code).toBe(0);
    const d = doc(r);
    const claude = d.providers.find((p: { id: string }) => p.id === "claude");
    expect(claude.warning).toBe("version is newer than tested");
    expect(r.err).toContain("version is newer than tested");
    expect(Object.keys(claude)).toEqual(["id", "kind", "label", "available", "reason", "warning", "path", "version", "verified", "baseUrl", "keyEnv", "keySet", "models", "modelsConfirmed", "modelsReason"]);
    expect(claude.baseUrl).toBeNull();
    expect(claude.verified).toBeNull();
    expect(JSON.stringify(d)).not.toContain("searchPath");
  });

  it("templates and lineups: one document each, empty lineups give []", async () => {
    const home = tmp();
    const t = await run(["templates", "--json"], home);
    const td = doc(t);
    expect([t.code, td.schemaVersion, Array.isArray(td.templates), Array.isArray(td.errors)]).toEqual([0, 1, true, true]);
    if (td.templates.length) expect(Object.keys(td.templates[0])).toEqual(["id", "category", "title", "source"]);
    const l = await run(["lineups", "--json"], home);
    expect([l.code, doc(l)]).toEqual([0, { schemaVersion: 1, lineups: [] }]);
  });
});
