import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createSessionJournal, eventsPath, sessionsDir } from "./journal.ts";
import { watchSession, watchSessions } from "./watch.ts";
import type { SessionSummary } from "./sessions.ts";
import type { Session, SessionEvent } from "../protocol/schema.ts";
import type { SessionState } from "../protocol/state.ts";

const ts = (n = 0) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const mkSession = (id: string): Session => ({
  id, createdAt: ts(), origin: "cli", topic: `Тема ${id}`, templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
});
const created = (id: string): SessionEvent => ({ seq: 1, ts: ts(), type: "session_created", session: mkSession(id), pid: 1 });
const started = (seq: number): SessionEvent => ({ seq, ts: ts(), type: "turn_started", turn: 1, round: 1, participantId: "p1" });
const completed = (seq: number): SessionEvent => ({
  seq, ts: ts(), type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "agree", normalized: false,
  reasoning: "ok", solution: null, version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
});

let dir: string;
const children: ChildProcess[] = [];
const unsubs: Array<() => void> = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-")); });
afterEach(() => {
  for (const u of unsubs.splice(0)) u();
  for (const c of children.splice(0)) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const write = (id: string, events: SessionEvent[]) => { createSessionJournal(dir, id); for (const e of events) appendEvent(dir, id, e); };

function waitFor<T>(sub: (cb: (v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("не пришло за 2000 мс")), 2000);
    sub((v) => { clearTimeout(t); resolve(v); });
  });
}

const CHILD = "const fs=require('fs'),p=require('path');const f=process.argv[1];fs.mkdirSync(p.dirname(f),{recursive:true});for(const l of process.argv.slice(2))fs.appendFileSync(f,l+'\\n');";
function otherProcess(file: string, events: SessionEvent[]): Promise<void> {
  const c = spawn(process.execPath, ["-e", CHILD, file, ...events.map((e) => JSON.stringify(e))], { stdio: "ignore" });
  children.push(c);
  return new Promise((resolve, reject) => {
    c.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exit ${code}`))));
    c.once("error", reject);
  });
}

describe("watch", () => {
  it("1. new turn from a foreign process, default period", async () => {
    write("a", [created("a"), started(2)]);
    const got = waitFor<{ e: SessionEvent; s: SessionState }>((cb) => {
      unsubs.push(watchSession(dir, "a", (e, s) => { if (e.type === "turn_completed") cb({ e, s }); }));
    });
    await otherProcess(eventsPath(dir, "a"), [completed(3)]);
    const r = await got;
    expect(r.e.seq).toBe(3);
    expect(r.s.turns).toHaveLength(1);
  });

  it("2. new session from another process", async () => {
    const got = waitFor<SessionSummary>((cb) => { unsubs.push(watchSessions(dir, cb)); });
    await otherProcess(eventsPath(dir, "n1"), [created("n1")]);
    expect(await got).toMatchObject({ id: "n1", topic: "Тема n1", origin: "cli" });
  });

  it("3. old sessions do not arrive", async () => {
    write("old", [created("old")]);
    const seen: string[] = [];
    unsubs.push(watchSessions(dir, (s) => seen.push(s.id), { intervalMs: 20 }));
    await sleep(80);
    expect(seen).toEqual([]);
  });

  it("4. already written in order; afterSeq", async () => {
    write("a", [created("a"), started(2), completed(3)]);
    const all: number[] = [];
    unsubs.push(watchSession(dir, "a", (e) => all.push(e.seq), { intervalMs: 20 }));
    const first = await waitFor<SessionState>((cb) => {
      unsubs.push(watchSession(dir, "a", (_e, s) => cb(s), { intervalMs: 20, afterSeq: 2 }));
    });
    await sleep(60);
    expect(all).toEqual([1, 2, 3]);
    expect(first.session).not.toBeNull();
    expect(first.turns).toHaveLength(1);
  });

  it("4b. afterSeq: first two are not delivered", async () => {
    write("a", [created("a"), started(2), completed(3)]);
    const seqs: number[] = [];
    unsubs.push(watchSession(dir, "a", (e) => seqs.push(e.seq), { intervalMs: 20, afterSeq: 2 }));
    await sleep(80);
    expect(seqs).toEqual([3]);
  });

  it("5. truncated write", async () => {
    write("a", [created("a")]);
    const seqs: number[] = [];
    unsubs.push(watchSession(dir, "a", (e) => seqs.push(e.seq), { intervalMs: 20 }));
    await sleep(60);
    const line = JSON.stringify(started(2));
    appendFileSync(eventsPath(dir, "a"), line.slice(0, 20));
    await sleep(80);
    expect(seqs).toEqual([1]);
    appendFileSync(eventsPath(dir, "a"), line.slice(20) + "\n");
    await sleep(80);
    expect(seqs).toEqual([1, 2]);
  });

  it("6. unsubscribe", async () => {
    write("a", [created("a")]);
    const seqs: number[] = [];
    const sessions: string[] = [];
    const u1 = watchSession(dir, "a", (e) => seqs.push(e.seq), { intervalMs: 20 });
    const u2 = watchSessions(dir, (s) => sessions.push(s.id), { intervalMs: 20 });
    await sleep(60);
    u1(); u2();
    expect(() => { u1(); u2(); }).not.toThrow();
    appendEvent(dir, "a", started(2));
    write("b", [created("b")]);
    await sleep(80);
    expect(seqs).toEqual([1]);
    expect(sessions).toEqual([]);
  });

  it("7. subscription before session appears", async () => {
    const seqs: number[] = [];
    unsubs.push(watchSession(dir, "late", (e) => seqs.push(e.seq), { intervalMs: 20 }));
    await sleep(60);
    write("late", [created("late"), started(2)]);
    await sleep(100);
    expect(seqs).toEqual([1, 2]);
  });

  it("8. folder without journal, then session_created: once", async () => {
    mkdirSync(join(sessionsDir(dir), "x"), { recursive: true });
    const seen: string[] = [];
    unsubs.push(watchSessions(dir, (s) => seen.push(s.id), { intervalMs: 20 }));
    await sleep(80);
    expect(seen).toEqual([]);
    appendEvent(dir, "x", created("x"));
    await sleep(100);
    expect(seen).toEqual(["x"]);
  });

  it("9. each event exactly once", async () => {
    write("a", [created("a")]);
    const seqs: number[] = [];
    unsubs.push(watchSession(dir, "a", (e) => seqs.push(e.seq), { intervalMs: 20 }));
    await sleep(50);
    appendEvent(dir, "a", started(2));
    await sleep(60);
    appendEvent(dir, "a", completed(3));
    await sleep(100);
    expect(seqs).toEqual([1, 2, 3]);
  });
});
