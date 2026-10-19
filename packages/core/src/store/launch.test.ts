import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../cli.ts";
import { createSession } from "../engine.ts";
import { cliMessages } from "../messages/cli.ts";
import { LaunchFileError, launchDir, launchFilePath, readLaunchFile, writeLaunchFile } from "./launch.ts";
import type { LaunchPayload } from "./launch.ts";
import { sessionsDir } from "./journal.ts";
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
    const path = writeLaunchFile(home, p);
    expect(path).toBe(launchFilePath(home, p.session.id));
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
