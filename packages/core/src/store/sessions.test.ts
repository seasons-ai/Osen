import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createSessionJournal, eventsPath, materialsDir, sessionDir, sessionsDir, stopRequestPath, writeMaterialSnapshots } from "./journal.ts";
import { StopRejectedError, isProcessAlive, listSessions, partialNote, readSession, requestStop } from "./sessions.ts";
import type { Session, SessionEvent } from "../protocol/schema.ts";

const ts = (n = 0) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const mkSession = (id: string, o: Partial<Session> = {}): Session => ({
  id, createdAt: ts(), origin: "cli", topic: `Тема ${id}`, templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 }, ...o,
});
const done = (turn: number, seq: number): SessionEvent[] => [
  { seq, ts: ts(), type: "turn_started", turn, round: 1, participantId: `p${turn}` },
  {
    seq: seq + 1, ts: ts(), type: "turn_completed", turn, round: 1, participantId: `p${turn}`, stance: "agree", normalized: false,
    reasoning: "ok", solution: null, version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
  },
];
const finished = (seq: number): SessionEvent => ({
  seq, ts: ts(), type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [],
});

let dir: string;
const children: ChildProcess[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-")); });
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

function write(id: string, events: SessionEvent[]) {
  createSessionJournal(dir, id);
  for (const e of events) appendEvent(dir, id, e);
}
const created = (s: Session, pid: number): SessionEvent => ({ seq: 1, ts: s.createdAt, type: "session_created", session: s, pid });
const log = (id: string) => readFileSync(eventsPath(dir, id));
const alive = () => true;
const dead = () => false;

describe("sessions", () => {
  describe("partial-read flag", () => {
    const unknown = (seq: number) => JSON.stringify({ seq, ts: ts(), type: "future_event" }) + "\n";
    const setup = (id: string, events: SessionEvent[]) => {
      const s = mkSession(id);
      write(id, [created(s, 1), ...events]);
      return s;
    };

    it("readSession: partial newer_version and lastEvent", () => {
      setup("a", done(1, 2));
      appendFileSync(eventsPath(dir, "a"), unknown(4));
      appendEvent(dir, "a", finished(5));
      const s = readSession(dir, "a", alive)!;
      expect(s.partial).toEqual({ reason: "newer_version", lastEvent: 3 });
      expect(s.status).toBe("running");
    });

    it("result before unreadable line is kept together with partial", () => {
      setup("b", [...done(1, 2), ...done(2, 4), finished(6)]);
      appendFileSync(eventsPath(dir, "b"), unknown(7));
      const s = readSession(dir, "b", dead)!;
      expect(s.status).toBe("consensus");
      expect(s.partial).toEqual({ reason: "newer_version", lastEvent: 6 });
    });

    it("listSessions carries partial", () => {
      setup("c", done(1, 2));
      appendFileSync(eventsPath(dir, "c"), unknown(4));
      const t = mkSession("d", { createdAt: ts(5) });
      write("d", [created(t, 1)]);
      const list = listSessions(dir, alive);
      expect(list.find((x) => x.id === "c")!.partial).toEqual({ reason: "newer_version", lastEvent: 3 });
      expect(list.find((x) => x.id === "d")!.partial).toBeNull();
    });

    it("journal intact — partial null", () => {
      setup("e", [...done(1, 2), finished(4)]);
      expect(readSession(dir, "e", dead)!.partial).toBeNull();
    });

    it("truncated last line — partial corrupted, state by previous events", () => {
      setup("f", done(1, 2));
      appendFileSync(eventsPath(dir, "f"), '{"seq":4,"ts":"2026');
      const s = readSession(dir, "f", alive)!;
      expect(s.partial).toEqual({ reason: "corrupted", lastEvent: 3 });
      expect(s.state.turns).toHaveLength(1);
      expect(s.status).toBe("running");
    });

    it("session with unreadable session_created not found", () => {
      createSessionJournal(dir, "g");
      appendFileSync(eventsPath(dir, "g"), unknown(1));
      expect(readSession(dir, "g")).toBeNull();
      expect(listSessions(dir).map((x) => x.id)).not.toContain("g");
    });
  });
  describe("list: journal without a session creation event", () => {
    const unknownEvent = (seq: number): SessionEvent => ({ seq, ts: ts(), type: "turn_started", turn: 1, round: 1, participantId: "p1" });
    const setup = () => {
      const s = mkSession("ok");
      write("ok", [created(s, 1)]);
      const seen: [string, unknown][] = [];
      return { seen, run: () => listSessions(dir, alive, (id, e) => seen.push([id, e])).map((x) => x.id) };
    };
    it("Session list: journal without a session creation event: garbage line", () => {
      const { seen, run } = setup();
      createSessionJournal(dir, "bad");
      writeFileSync(eventsPath(dir, "bad"), "garbage\n");
      expect(run()).toEqual(["ok"]);
      expect(seen.map(([id]) => id)).toEqual(["bad"]);
      expect(seen[0]![1]).toBeInstanceOf(Error);
    });
    it("Session list: journal without a session creation event: valid event that is not the creation", () => {
      const { seen, run } = setup();
      write("bad", [unknownEvent(1)]);
      expect(run()).toEqual(["ok"]);
      expect(seen.map(([id]) => id)).toEqual(["bad"]);
      expect(seen[0]![1]).toBeInstanceOf(Error);
    });
    it("Session list: session being created: no events.jsonl or an empty one is skipped silently", () => {
      const { seen, run } = setup();
      mkdirSync(sessionDir(dir, "nofile"), { recursive: true });
      createSessionJournal(dir, "empty");
      expect(run()).toEqual(["ok"]);
      expect(seen).toEqual([]);
    });
  });

  it("list: three sources, from newest to oldest", () => {
    (["cli", "mcp", "desktop"] as const).forEach((origin, i) => {
      const s = mkSession(`s-${origin}`, { origin, createdAt: ts(i) });
      write(s.id, [created(s, 1), ...done(1, 2), ...done(2, 4), finished(6)]);
    });
    const list = listSessions(dir, dead);
    expect(list.map((s) => s.origin)).toEqual(["desktop", "mcp", "cli"]);
    expect(list[2]).toMatchObject({ id: "s-cli", topic: "Тема s-cli", createdAt: ts(0), status: "consensus" });
    expect(list[2]!.participants).toHaveLength(2);
  });

  it("empty folder and no folder", () => {
    expect(listSessions(dir)).toEqual([]);
    mkdirSync(sessionsDir(dir));
    expect(listSessions(dir)).toEqual([]);
  });

  it("running session in the middle of third turn", () => {
    const s = mkSession("a");
    write("a", [created(s, 1), ...done(1, 2), ...done(2, 4),
      { seq: 6, ts: ts(), type: "turn_started", turn: 3, round: 2, participantId: "p1" }]);
    const r = readSession(dir, "a")!;
    expect(r.status).toBe("running");
    expect(r.state.turns).toHaveLength(2);
    expect(r.state.currentTurn?.turn).toBe(3);
  });

  it("truncated last line", () => {
    const s = mkSession("a");
    write("a", [created(s, 1), ...done(1, 2)]);
    appendFileSync(eventsPath(dir, "a"), '{"seq":99,"ts":"2026');
    const r = readSession(dir, "a")!;
    expect(r.state.turns).toHaveLength(1);
    expect(r.status).toBe("running");
  });

  it("process killed mid-session: interrupted, disk unchanged", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    const exited = new Promise((r) => child.once("exit", r));
    const s = mkSession("a");
    write("a", [created(s, child.pid!), ...done(1, 2)]);
    const before = log("a");
    const files = readdirSync(sessionDir(dir, "a"));
    expect(readSession(dir, "a")!.status).toBe("running");
    expect(listSessions(dir)[0]!.status).toBe("running");
    child.kill("SIGKILL");
    await exited;
    expect(readSession(dir, "a")!.status).toBe("interrupted");
    expect(listSessions(dir)[0]!.status).toBe("interrupted");
    expect(log("a").equals(before)).toBe(true);
    expect(readdirSync(sessionDir(dir, "a"))).toEqual(files);
  });

  it("completed session with dead pid is not interrupted", () => {
    const s = mkSession("a");
    write("a", [created(s, 999999), ...done(1, 2), finished(4)]);
    expect(readSession(dir, "a", dead)!.status).toBe("consensus");
  });

  it("requestStop for running", () => {
    const s = mkSession("a");
    write("a", [created(s, 1), ...done(1, 2)]);
    const before = log("a");
    requestStop(dir, "a", alive);
    expect(readFileSync(stopRequestPath(dir, "a"), "utf8")).toMatch(/^\d{4}-.*\n$/);
    requestStop(dir, "a", alive);
    expect(log("a").equals(before)).toBe(true);
  });

  it("stop of newer_version session accepted: request file created, journal unchanged", () => {
    const s = mkSession("a");
    write("a", [created(s, 1), ...done(1, 2)]);
    appendFileSync(eventsPath(dir, "a"), JSON.stringify({ seq: 4, ts: ts(), type: "future_event" }) + "\n");
    const before = log("a");
    requestStop(dir, "a", alive);
    expect(readFileSync(stopRequestPath(dir, "a"), "utf8")).toMatch(/^\d{4}-.*\n$/);
    expect(log("a").equals(before)).toBe(true);
  });

  it("stop of newer_version session with broken executor: refusal does not call it interrupted", () => {
    const s = mkSession("a");
    write("a", [created(s, 1), ...done(1, 2)]);
    appendFileSync(eventsPath(dir, "a"), JSON.stringify({ seq: 4, ts: ts(), type: "future_event" }) + "\n");
    let message = "";
    try {
      requestStop(dir, "a", () => false);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("исполнитель не работает, останавливать нечего; журнал записан более новой версией, прочитан до события №3");
    expect(message).not.toContain("прервана");
    expect(existsSync(stopRequestPath(dir, "a"))).toBe(false);
  });

  it("partialNote: both reasons", () => {
    expect(partialNote({ reason: "newer_version", lastEvent: 3 })).toBe("журнал записан более новой версией, прочитан до события №3");
    expect(partialNote({ reason: "corrupted", lastEvent: 7 })).toBe("журнал повреждён, прочитан до события №7");
  });

  it("requestStop for completed", () => {
    const s = mkSession("a");
    write("a", [created(s, 1), ...done(1, 2), finished(4)]);
    const before = log("a");
    const err = (() => { try { requestStop(dir, "a", alive); } catch (e) { return e; } })() as StopRejectedError;
    expect(err).toBeInstanceOf(StopRejectedError);
    expect(err.reason).toBe("finished");
    expect(err.message).toContain("завершена");
    expect(readdirSync(sessionDir(dir, "a"))).toEqual(["events.jsonl"]);
    expect(log("a").equals(before)).toBe(true);
  });

  it("requestStop: not_found and interrupted", () => {
    const reason = (id: string, f = alive) => { try { requestStop(dir, id, f); } catch (e) { return (e as StopRejectedError).reason; } };
    expect(reason("nope")).toBe("not_found");
    expect(reason("../x")).toBe("not_found");
    const s = mkSession("a");
    write("a", [created(s, 999999), ...done(1, 2)]);
    expect(reason("a", dead)).toBe("interrupted");
    expect(readdirSync(sessionDir(dir, "a"))).toEqual(["events.jsonl"]);
  });

  it("junk does not get into the list", () => {
    mkdirSync(sessionsDir(dir), { recursive: true });
    mkdirSync(sessionDir(dir, "empty"));
    createSessionJournal(dir, "junk");
    writeFileSync(eventsPath(dir, "junk"), "мусор\nещё\n");
    writeFileSync(join(sessionsDir(dir), "file.txt"), "x");
    expect(listSessions(dir)).toEqual([]);
    for (const id of ["empty", "junk", "file.txt", "nope"]) expect(readSession(dir, id)).toBeNull();
  });

  it("isProcessAlive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    for (const bad of [0, -1, 1.5, NaN]) expect(isProcessAlive(bad)).toBe(false);
  });

  it("same createdAt: by id descending", () => {
    for (const id of ["a1", "c3", "b2"]) write(id, [created(mkSession(id), 1)]);
    expect(listSessions(dir).map((s) => s.id)).toEqual(["c3", "b2", "a1"]);
  });

  it("materials do not take part in reading state", () => {
    const meta = [{ id: "m1", name: "a.txt", chars: 3, sha256: "0".repeat(64) }];
    const s = mkSession("mat", { materials: meta });
    write("mat", [created(s, 1), ...done(1, 2), ...done(2, 4), finished(6)]);
    writeMaterialSnapshots(dir, "mat", [{ id: "m1", text: "abc" }]);
    const one = readSession(dir, "mat", dead);
    const l1 = listSessions(dir, dead);
    rmSync(materialsDir(dir, "mat"), { recursive: true });
    expect(readSession(dir, "mat", dead)).toEqual(one);
    expect(listSessions(dir, dead)).toEqual(l1);
    expect(one!.state.session!.materials).toEqual(meta);
  });

  it("folder with only material, without events.jsonl: no session", () => {
    createSessionJournal(dir, "only");
    writeMaterialSnapshots(dir, "only", [{ id: "m1", text: "abc" }]);
    expect(readSession(dir, "only", dead)).toBeNull();
    expect(listSessions(dir, dead)).toEqual([]);
  });

  describe("unreadable journal of one session", () => {
    it("list returns the readable one and names two unreadable; read by id throws", () => {
      write("ok", [created(mkSession("ok"), 1)]);
      write("noperm", [created(mkSession("noperm"), 1)]);
      createSessionJournal(dir, "isdir");
      rmSync(eventsPath(dir, "isdir"), { force: true });
      mkdirSync(eventsPath(dir, "isdir"));
      if (process.getuid?.() === 0) { rmSync(eventsPath(dir, "noperm")); mkdirSync(eventsPath(dir, "noperm")); }
      else chmodSync(eventsPath(dir, "noperm"), 0o000);
      try {
        const seen: string[] = [];
        const list = listSessions(dir, dead, (id, e) => { seen.push(id); expect(e).toBeInstanceOf(Error); });
        expect(list.map((x) => x.id)).toEqual(["ok"]);
        expect(seen.sort()).toEqual(["isdir", "noperm"]);
        expect(() => readSession(dir, "noperm", dead)).toThrow();
        expect(() => readSession(dir, "isdir", dead)).toThrow();
        expect(listSessions(dir, dead).map((x) => x.id)).toEqual(["ok"]);
      } finally {
        if (process.getuid?.() !== 0) chmodSync(eventsPath(dir, "noperm"), 0o644);
      }
    });
  });
});
