import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../cli.ts";
import { createSession } from "../engine.ts";
import { cliMessages } from "../messages/cli.ts";
import { LaunchFileError, launchAcceptedPath, launchDir, launchFilePath, readLaunchFile, sweepLaunchDir, writeLaunchFile } from "./launch.ts";
import type { LaunchPayload, LaunchResumePayload } from "./launch.ts";
import { createScriptedDriver } from "../participants/scripted.ts";
import type { Scenario } from "../participants/scripted.ts";
import { eventsPath, readEvents, resumeLockPath, sessionsDir } from "./journal.ts";
import { runStoredSession } from "./run.ts";
import { readSession } from "./sessions.ts";
import "../../scenarios/language-ru.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "launch-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const sc = (file: string) => join(import.meta.dirname, "../../scenarios/consensus", file);
const FUTURE = () => new Date(Date.now() + 60_000).toISOString();

function payload(over: Partial<LaunchPayload> = {}): LaunchPayload {
  const session = createSession({
    topic: "Как назвать кота", framing: "", origin: "mcp",
    limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000 },
    participants: [1, 2].map((n) => ({ name: `П${n}`, providerId: "scripted", model: `p${n}.json`, role: null })),
  }, { maxParticipants: 8 });
  return { session, scenarios: { p1: sc("p1.json"), p2: sc("p2.json") }, deadline: FUTURE(), ...over };
}

async function cli(home: string, argv: string[], env: Record<string, string> = { COUNCIL_DEV: "1" }) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: { COUNCIL_HOME: home, ...env }, inspectDeps: { locate: async (agent) => ({ agent, found: false, searchPath: "", reason: "no" }) } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const sessionIds = (home: string) => (existsSync(sessionsDir(home)) ? readdirSync(sessionsDir(home)) : []);

describe("Internal start of a prepared session: launch file", () => {
  it("write then read returns the payload; mode 0600; file removed after read", () => {
    const home = tmp();
    const p = payload();
    const path = writeLaunchFile(home, p, "L1");
    expect(path).toBe(launchFilePath(home, p.session.id, "L1"));
    expect(path).toBe(join(launchDir(home), `${p.session.id}.L1.json`));
    // every launch gets its own file: two writes of one session never share a path
    const other = writeLaunchFile(home, p);
    expect(other).not.toBe(path);
    expect(existsSync(other) && existsSync(path)).toBe(true);
    rmSync(other);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(launchDir(home)).isDirectory()).toBe(true);
    expect(readLaunchFile(path)).toEqual(p);
    expect(existsSync(path)).toBe(false);
  });

  it("missing file, damaged JSON, schema mismatch and expired deadline are LaunchFileError; the file is removed", () => {
    const home = tmp();
    expect(() => readLaunchFile(join(home, "nope.json"))).toThrow(LaunchFileError);
    const bad = (name: string, text: string) => { mkdirSync(launchDir(home), { recursive: true }); const f = join(launchDir(home), name); writeFileSync(f, text); return f; };
    const damaged = bad("a.json", "{not json");
    expect(() => readLaunchFile(damaged)).toThrow(LaunchFileError);
    expect(existsSync(damaged)).toBe(false);
    const rel = bad("b.json", JSON.stringify({ ...payload(), scenarios: { p1: "relative.json" } }));
    expect(() => readLaunchFile(rel)).toThrow(LaunchFileError);
    expect(existsSync(rel)).toBe(false);
    const extra = bad("c.json", JSON.stringify({ ...payload(), apiKey: "x" }));
    expect(() => readLaunchFile(extra)).toThrow(LaunchFileError);
    const old = writeLaunchFile(home, payload({ deadline: new Date(Date.now() - 1000).toISOString() }));
    expect(() => readLaunchFile(old)).toThrow(LaunchFileError);
    expect(existsSync(old)).toBe(false);
  });

  it("rejects a session id that is not a safe file name", () => {
    const p = payload();
    expect(() => writeLaunchFile(tmp(), { ...p, session: { ...p.session, id: "../x" } })).toThrow();
  });
});

describe("Internal start of a prepared session: council run-prepared", () => {
  it("runs the session to the end with the origin from the file and removes the launch file", async () => {
    const home = tmp();
    const p = payload();
    const path = writeLaunchFile(home, p);
    const r = await cli(home, ["run-prepared", path]);
    expect(r.code).toBe(0);
    expect(existsSync(path)).toBe(false);
    const stored = readSession(home, p.session.id);
    expect(stored?.state.session?.origin).toBe("mcp");
    expect(stored?.state.finish?.status).toBe("consensus");
  });

  it.each([
    ["missing file", (home: string) => join(home, "launch", "none.json")],
    ["damaged file", (home: string) => { mkdirSync(launchDir(home), { recursive: true }); const f = join(launchDir(home), "d.json"); writeFileSync(f, "{"); return f; }],
    ["expired file", (home: string) => writeLaunchFile(home, payload({ deadline: new Date(Date.now() - 1000).toISOString() }))],
  ])("%s: exit 2, reason on stderr, no session", async (_n, make) => {
    const home = tmp();
    const r = await cli(home, ["run-prepared", make(home)]);
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(sessionIds(home)).toEqual([]);
  });

  it("scripted participants without COUNCIL_DEV: exit 2, no session", async () => {
    const home = tmp();
    const r = await cli(home, ["run-prepared", writeLaunchFile(home, payload())], {});
    expect(r.code).toBe(2);
    expect(sessionIds(home)).toEqual([]);
  });

  it("needs exactly one argument and accepts no flags", async () => {
    const home = tmp();
    expect((await cli(home, ["run-prepared"])).code).toBe(2);
    expect((await cli(home, ["run-prepared", "a", "b"])).code).toBe(2);
    expect((await cli(home, ["run-prepared", "a", "--topic", "x"])).code).toBe(2);
  });

  it("is not mentioned in --help (en and ru)", async () => {
    const home = tmp();
    expect((await cli(home, ["--help"])).out).not.toContain("run-prepared");
    expect(cliMessages().help).not.toContain("run-prepared");
    expect(cliMessages("en").help).not.toContain("run-prepared");
  });
});

type Step = Scenario["steps"][number];
const resp = (stance: string, solution: string | null): Step => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });

/** A finished session with two scripted participants; the scenario files continue after the steps already played. */
async function finished(home: string, id: string, kind: "no_consensus" | "consensus"): Promise<LaunchResumePayload> {
  const rest = Array.from({ length: 6 }, () => resp("agree", null));
  const [a, b] = kind === "no_consensus" ? [[resp("amend", "v1"), ...rest], [resp("object", null), ...rest]] : [[resp("amend", "v1"), ...rest], [resp("agree", null), ...rest]];
  const files = [a, b].map((steps, i) => { const f = join(home, `${id}-p${i + 1}.json`); writeFileSync(f, JSON.stringify({ steps })); return f; });
  const session = createSession({
    topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: kind === "consensus" ? 3 : 1, turnTimeoutSec: 30, contextChars: 20000 },
    participants: files.map((f, i) => ({ name: `N${i + 1}`, providerId: "scripted", model: f, role: null })),
  }, { maxParticipants: 8, id });
  const drivers = Object.fromEntries([a, b].map((steps, i) => [`p${i + 1}`, createScriptedDriver({ steps: steps.slice(0, kind === "consensus" ? 2 : 1) }, { COUNCIL_DEV: "1" })]));
  const run = await runStoredSession({ session, drivers, dataDir: home });
  expect(run.state.finish?.status).toBe(kind);
  return {
    kind: "resume", sessionId: id, journalBytes: statSync(eventsPath(home, id)).size,
    scenarios: Object.fromEntries(files.map((f) => [f, f])), deadline: FUTURE(),
  };
}
const firstLine = (s: string) => s.split("\n")[0]!;
const journalText = (home: string, id: string) => readFileSync(eventsPath(home, id), "utf8");

describe("Внутренний запуск подготовленной сессии: resume launch file", () => {
  it("runs one session_resumed, deletes the launch file, writes the accepted file (0600) and exits with the finish code", async () => {
    const home = tmp();
    const p = await finished(home, "r1", "no_consensus");
    const path = writeLaunchFile(home, { ...p, rounds: 2 });
    const r = await cli(home, ["run-prepared", path]);
    const evs = readEvents(home, "r1")!.events;
    expect(evs.filter((e) => e.type === "session_resumed")).toHaveLength(1);
    expect(readSession(home, "r1")?.state.session?.origin).toBe("cli");
    expect(existsSync(path)).toBe(false);
    const acc = launchAcceptedPath(path);
    expect(statSync(acc).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(acc, "utf8"))).toEqual({ droppedOwnerRequests: [] });
    const status = readSession(home, "r1")!.state.finish!.status;
    expect(status).toBe("consensus");
    expect(r.code).toBe(0);
  });

  it("a journal changed after the plan: stale_plan on the first stderr line, journal untouched, no accepted file", async () => {
    const home = tmp();
    const p = await finished(home, "r2", "no_consensus");
    const before = journalText(home, "r2");
    const f = writeLaunchFile(home, { ...p, rounds: 2, journalBytes: p.journalBytes + 1 });
    const r = await cli(home, ["run-prepared", f]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(firstLine(r.err))).toMatchObject({ code: "stale_plan" });
    expect(journalText(home, "r2")).toBe(before);
    expect(existsSync(launchAcceptedPath(f))).toBe(false);
  });

  it("a consensus session with a message: owner_message right after session_resumed", async () => {
    const home = tmp();
    const p = await finished(home, "r3", "consensus");
    const r = await cli(home, ["run-prepared", writeLaunchFile(home, { ...p, message: "Подумайте ещё\nраз" })]);
    expect(r.code).toBeLessThanOrEqual(1);
    const types = readEvents(home, "r3")!.events.map((e) => e.type);
    const i = types.indexOf("session_resumed");
    expect(i).toBeGreaterThan(0);
    expect(types[i + 1]).toBe("owner_message");
  });

  it("the deadline passed before the lock (the server has already timed out): refused before any write", async () => {
    const home = tmp();
    const p = await finished(home, "r6", "no_consensus");
    const before = journalText(home, "r6");
    const path = writeLaunchFile(home, { ...p, rounds: 2, deadline: new Date(Date.now() + 300).toISOString() });
    const err: string[] = [];
    // the registry check before the lock is slow: the deadline passes while it runs
    const slow = async (agent: "claude" | "codex") => { await new Promise((r) => setTimeout(r, 400)); return { agent, found: false, searchPath: "", reason: "no" }; };
    const code = await main(["run-prepared", path], { stdout: () => {}, stderr: (t) => err.push(t), env: { COUNCIL_HOME: home, COUNCIL_DEV: "1" }, inspectDeps: { locate: slow } });
    expect(code).toBe(2);
    expect(JSON.parse(firstLine(err.join("\n")))).toMatchObject({ code: "stale_plan" });
    expect(journalText(home, "r6")).toBe(before);
    expect(existsSync(launchAcceptedPath(path))).toBe(false);
    expect(existsSync(resumeLockPath(home, "r6"))).toBe(false);
  });

  it("resume.lock held by a live process: busy on the first stderr line, journal untouched", async () => {
    const home = tmp();
    const p = await finished(home, "r4", "no_consensus");
    writeFileSync(resumeLockPath(home, "r4"), String(process.ppid));
    const before = journalText(home, "r4");
    const r = await cli(home, ["run-prepared", writeLaunchFile(home, { ...p, rounds: 2 })]);
    expect(r.code).toBe(2);
    expect(JSON.parse(firstLine(r.err))).toMatchObject({ code: "busy" });
    expect(journalText(home, "r4")).toBe(before);
  });

  it("a damaged resume file (no journalBytes): plain error, journal untouched", async () => {
    const home = tmp();
    const { journalBytes: _drop, ...p } = await finished(home, "r5", "no_consensus");
    mkdirSync(launchDir(home), { recursive: true });
    const f = join(launchDir(home), "r5.json");
    writeFileSync(f, JSON.stringify(p));
    const before = journalText(home, "r5");
    const r = await cli(home, ["run-prepared", f]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(cliMessages().error("").trim().split(":")[0]!);
    expect(() => JSON.parse(firstLine(r.err))).toThrow();
    expect(journalText(home, "r5")).toBe(before);
    expect(existsSync(f)).toBe(false);
  });
});

describe("sweepLaunchDir", () => {
  it("removes launch, err, accepted and temp files older than 60 s and keeps fresh ones", () => {
    const dir = tmp();
    expect(sweepLaunchDir(dir)).toBe(0);
    mkdirSync(launchDir(dir), { recursive: true });
    const old = ["a.l1.json", "a.l1.err", "a.l1.accepted.json", "a.l1.accepted.json.123.tmp", "a.l1.json.123.tmp"];
    const fresh = ["b.l2.json", "b.l2.accepted.json.9.tmp"];
    const at = (n: string, ageSec: number) => { const f = join(launchDir(dir), n); writeFileSync(f, "{}"); const t = new Date(Date.now() - ageSec * 1000); utimesSync(f, t, t); };
    old.forEach((n) => at(n, 120));
    fresh.forEach((n) => at(n, 1));
    expect(sweepLaunchDir(dir)).toBe(old.length);
    expect(readdirSync(launchDir(dir)).sort()).toEqual([...fresh].sort());
  });
});
