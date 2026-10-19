import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createSession, SessionInputError } from "../engine.ts";
import { createScriptedDriver, readScenario } from "../participants/scripted.ts";
import type { Scenario } from "../participants/scripted.ts";
import type { ParticipantDriver } from "../participants/driver.ts";
import { MaterialSnapshotError, resumeLockPath, eventsPath, materialPath, materialsDir, readEvents, SessionExistsError, sessionDir, stopRequestPath } from "./journal.ts";
import { runStoredSession } from "./run.ts";
import { draftPath, readDraftSnapshot } from "./draft-snapshots.ts";
import { OwnerMessageRejectedError, OwnerReleaseRejectedError, ownerMessagesDir, requestOwnerMessage, requestOwnerRelease } from "./owner-messages.ts";
import { StopRejectedError, listSessions, readSession, requestStop } from "./sessions.ts";
import { ResumeRejectedError, acquireResumeLock, planResume, runResumedSession } from "./resume.ts";
import type { ResumePlan } from "./resume.ts";

const fsHook = vi.hoisted(() => ({ failOn: "" }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: ((path: unknown, ...a: unknown[]) => {
      if (fsHook.failOn && String(path).endsWith(fsHook.failOn)) throw Object.assign(new Error("boom"), { code: "EIO" });
      return (real.writeFileSync as (...x: unknown[]) => void)(path, ...a);
    }) as typeof real.writeFileSync,
  };
});

const scenarios = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scenarios");
const env = { COUNCIL_DEV: "1" };
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-")); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const mk = (id: string, maxRounds = 3) =>
  createSession(
    {
      topic: "Тема", framing: "", origin: "cli", limits: { maxRounds, turnTimeoutSec: 30, contextChars: 20000 },
      participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
    },
    { maxParticipants: 8, id },
  );
const pair = async (name: string): Promise<Record<string, ParticipantDriver>> => ({
  p1: createScriptedDriver(await readScenario(join(scenarios, name, "p1.json")), env),
  p2: createScriptedDriver(await readScenario(join(scenarios, name, "p2.json")), env),
});
const lines = (dir: string, id: string) => readFileSync(eventsPath(dir, id), "utf8").split("\n").filter(Boolean);

describe("runStoredSession", () => {
  it("1. journal equals launch events", async () => {
    const dir = tmp();
    const run = await runStoredSession({ session: mk("a"), drivers: await pair("consensus"), dataDir: dir });
    expect(readEvents(dir, "a")!.events).toEqual(run.events);
    const ls = lines(dir, "a").map((l) => JSON.parse(l));
    expect(ls).toHaveLength(run.events.length);
    expect(ls.at(-1).type).toBe("session_finished");
    for (const l of ls) expect(l).toEqual(expect.objectContaining({ seq: expect.any(Number), ts: expect.anything(), type: expect.any(String) }));
  });

  it("2. event on disk by onEvent time, 4. journal only appends", async () => {
    const dir = tmp();
    let n = 0;
    let prev = "";
    await runStoredSession({
      session: mk("b"), drivers: await pair("consensus"), dataDir: dir,
      onEvent: (e) => {
        const text = readFileSync(eventsPath(dir, "b"), "utf8");
        expect(JSON.parse(text.trim().split("\n").at(-1)!).seq).toBe(e.seq);
        expect(text.startsWith(prev)).toBe(true);
        prev = text;
        n++;
      },
    });
    expect(n).toBeGreaterThan(3);
  });

  it("3. at call of turn N the journal has turn_started of N and turn_completed of all previous", async () => {
    const dir = tmp();
    const base = await pair("consensus");
    const snaps: ReturnType<typeof readEvents>[] = [];
    const wrap = (d: ParticipantDriver): ParticipantDriver => ({
      call: (req) => { snaps.push(readEvents(dir, "c")); return d.call(req); },
    });
    const run = await runStoredSession({ session: mk("c"), drivers: { p1: wrap(base.p1!), p2: wrap(base.p2!) }, dataDir: dir });
    const started = run.events.filter((e) => e.type === "turn_started");
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    snaps.forEach((s, i) => {
      const types = s!.events.map((e) => e.type);
      expect(types.filter((t) => t === "turn_started")).toHaveLength(i + 1);
      expect(types.filter((t) => t === "turn_completed")).toHaveLength(i);
    });
    expect(started.length).toBeGreaterThanOrEqual(snaps.length);
  });

  const stopped = async (id: string, stopPollMs?: number) => {
    const dir = tmp();
    let at = 0;
    const run = await runStoredSession({
      session: mk(id), drivers: await pair("slow"), dataDir: dir, stopPollMs,
      onEvent: (e) => {
        if (e.type === "turn_started" && !at) { at = Date.now(); writeFileSync(stopRequestPath(dir, id), ""); }
      },
    });
    expect(Date.now() - at).toBeLessThan(2000);
    expect(run.state.finish!.status).toBe("stopped");
    const last = readEvents(dir, id)!.events.at(-1)!;
    expect(last).toMatchObject({ type: "session_finished", status: "stopped" });
    expect(existsSync(stopRequestPath(dir, id))).toBe(true);
  };

  it("5. stop via request file", () => stopped("d", 50));
  it("6. stop with default period", () => stopped("e"));

  it("7. external signal stops", async () => {
    const dir = tmp();
    const ctl = new AbortController();
    const run = await runStoredSession({
      session: mk("f"), drivers: await pair("slow"), dataDir: dir, signal: ctl.signal,
      onEvent: (e) => { if (e.type === "turn_started") ctl.abort(); },
    });
    expect(run.state.finish!.status).toBe("stopped");
    expect(readEvents(dir, "f")!.events.at(-1)).toMatchObject({ type: "session_finished", status: "stopped" });
  });

  it("8. existing session is not overwritten", async () => {
    const dir = tmp();
    mkdirSync(sessionDir(dir, "g"), { recursive: true });
    writeFileSync(eventsPath(dir, "g"), "старое\n");
    await expect(runStoredSession({ session: mk("g"), drivers: await pair("consensus"), dataDir: dir }))
      .rejects.toBeInstanceOf(SessionExistsError);
    expect(readFileSync(eventsPath(dir, "g"), "utf8")).toBe("старое\n");
  });

  it("9. logger", async () => {
    const dir = tmp();
    const info: string[] = [];
    const error: [string, unknown][] = [];
    const logger = { info: (m: string) => { info.push(m); }, error: (m: string, c?: unknown) => { error.push([m, c]); } };
    const run = await runStoredSession({ session: mk("h"), drivers: await pair("consensus"), dataDir: dir, logger });
    expect(info[0]).toContain("h");
    expect(info.at(-1)).toContain(run.state.finish!.status);
    await expect(runStoredSession({ session: mk("h"), drivers: await pair("consensus"), dataDir: dir, logger }))
      .rejects.toBeInstanceOf(SessionExistsError);
    expect(error).toHaveLength(1);
    expect(error[0]![1]).toBeInstanceOf(SessionExistsError);
  });

  it("10. without logger and onEvent", async () => {
    const run = await runStoredSession({ session: mk("i"), drivers: await pair("consensus"), dataDir: tmp() });
    expect(run.state.finish).toBeTruthy();
  });

  it("11. timer cleared on success and on exception", async () => {
    const dir = tmp();
    const spy = vi.spyOn(globalThis, "clearInterval");
    await runStoredSession({ session: mk("j"), drivers: await pair("consensus"), dataDir: dir });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    await expect(runStoredSession({ session: mk("j"), drivers: await pair("consensus"), dataDir: dir })).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe("material snapshots", () => {
    const MARK = "УНИКАЛЬНЫЙ-МАРКЕР-7731";
    const mat = (id: string, name: string, text: string) =>
      ({ id, name, text, chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex") });
    const texts = [mat("m1", "a.txt", `Привет 😀 ${MARK}\nбез перевода строки`), mat("m2", "b.txt", "второй\n")];
    const mkm = (id: string, materials = texts) =>
      createSession(
        {
          topic: "Тема", framing: "", origin: "cli",
          limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000, materialsChars: 1000 },
          participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
          materials,
        },
        { maxParticipants: 8, id },
      );
    const snap = (dir: string, id: string, m: string) => materialPath(dir, id, m);
    const counted = (d: ParticipantDriver, n: { v: number }): ParticipantDriver => ({ call: (r) => { n.v++; return d.call(r); } });

    it("12. files equal texts, journal has only metadata", async () => {
      const dir = tmp();
      await runStoredSession({ session: mkm("m"), drivers: await pair("consensus"), dataDir: dir, materials: texts });
      const first = JSON.parse(lines(dir, "m")[0]!);
      for (const t of texts) {
        const bytes = readFileSync(snap(dir, "m", t.id));
        expect(bytes.toString("utf8")).toBe(t.text);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          first.session.materials.find((x: { id: string }) => x.id === t.id).sha256,
        );
      }
      for (const x of first.session.materials) expect(Object.keys(x).sort()).toEqual(["chars", "id", "name", "sha256"]);
      for (const l of lines(dir, "m")) expect(l).not.toContain(MARK);
    });

    it("13. snapshots exist by session_created and by first participant call", async () => {
      const dir = tmp();
      const base = await pair("consensus");
      const seen: boolean[] = [];
      const both = () => texts.every((t) => existsSync(snap(dir, "o", t.id)));
      const wrap = (d: ParticipantDriver): ParticipantDriver => ({ call: (r) => { seen.push(both()); return d.call(r); } });
      await runStoredSession({
        session: mkm("o"), drivers: { p1: wrap(base.p1!), p2: wrap(base.p2!) }, dataDir: dir, materials: texts,
        onEvent: (e) => { if (e.type === "session_created") seen.push(both()); },
      });
      expect(seen.length).toBeGreaterThan(2);
      expect(seen.every(Boolean)).toBe(true);
    });

    it("14. second write failure: no journal, no calls, foreign session untouched", async () => {
      const dir = tmp();
      await runStoredSession({ session: mkm("old"), drivers: await pair("consensus"), dataDir: dir, materials: texts });
      const before = [eventsPath(dir, "old"), snap(dir, "old", "m1"), snap(dir, "old", "m2")].map((f) => readFileSync(f));
      const base = await pair("consensus");
      const n = { v: 0 };
      fsHook.failOn = "m2.txt";
      try {
        await expect(runStoredSession({
          session: mkm("bad"), drivers: { p1: counted(base.p1!, n), p2: counted(base.p2!, n) }, dataDir: dir, materials: texts,
        })).rejects.toBeInstanceOf(MaterialSnapshotError);
      } finally { fsHook.failOn = ""; }
      expect(existsSync(eventsPath(dir, "bad"))).toBe(false);
      expect(n.v).toBe(0);
      const after = [eventsPath(dir, "old"), snap(dir, "old", "m1"), snap(dir, "old", "m2")].map((f) => readFileSync(f));
      after.forEach((b, i) => expect(b.equals(before[i]!)).toBe(true));
    });

    it("15. id conflict: first session unchanged", async () => {
      const dir = tmp();
      await runStoredSession({ session: mkm("x"), drivers: await pair("consensus"), dataDir: dir, materials: texts });
      const files = [eventsPath(dir, "x"), snap(dir, "x", "m1"), snap(dir, "x", "m2")];
      const before = files.map((f) => readFileSync(f));
      await expect(runStoredSession({ session: mkm("x"), drivers: await pair("consensus"), dataDir: dir, materials: texts }))
        .rejects.toBeInstanceOf(SessionExistsError);
      files.forEach((f, i) => expect(readFileSync(f).equals(before[i]!)).toBe(true));
    });

    describe("No partial session on snapshot error", () => {
      const ws = [{ name: "p/a.txt", text: "a" }, { name: "p/b.txt", text: "b" }];
      const mkw = (id: string) =>
        createSession(
          {
            topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000, materialsChars: 1000 },
            participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })), materials: texts, workspace: ws,
          },
          { maxParticipants: 8, id },
        );

      it("session folder write failure of second file: session folder absent, previous intact, error same", async () => {
        const dir = tmp();
        await runStoredSession({ session: mkw("old"), drivers: await pair("consensus"), dataDir: dir, materials: texts, workspace: ws });
        const before = readFileSync(eventsPath(dir, "old"));
        fsHook.failOn = "p/b.txt";
        try {
          await expect(runStoredSession({ session: mkw("bad"), drivers: await pair("consensus"), dataDir: dir, materials: texts, workspace: ws }))
            .rejects.toThrow(/p\/b\.txt.*EIO/);
        } finally { fsHook.failOn = ""; }
        expect(existsSync(sessionDir(dir, "bad"))).toBe(false);
        expect(readFileSync(eventsPath(dir, "old")).equals(before)).toBe(true);
      });

      it("occupied identifier: folder not deleted or changed", async () => {
        const dir = tmp();
        await runStoredSession({ session: mkw("x"), drivers: await pair("consensus"), dataDir: dir, materials: texts, workspace: ws });
        const before = readFileSync(eventsPath(dir, "x"));
        await expect(runStoredSession({ session: mkw("x"), drivers: await pair("consensus"), dataDir: dir, materials: texts, workspace: ws }))
          .rejects.toBeInstanceOf(SessionExistsError);
        expect(readFileSync(eventsPath(dir, "x")).equals(before)).toBe(true);
      });
    });

    it("16. set does not match metadata: folder not created", async () => {
      const dir = tmp();
      const changed = [mat("m1", "a.txt", "другой текст"), texts[1]!];
      await expect(runStoredSession({ session: mkm("y"), drivers: await pair("consensus"), dataDir: dir, materials: changed }))
        .rejects.toBeInstanceOf(SessionInputError);
      expect(existsSync(sessionDir(dir, "y"))).toBe(false);
    });

    it("17. without materials, materials folder is not created", async () => {
      const dir = tmp();
      await runStoredSession({ session: mk("z"), drivers: await pair("consensus"), dataDir: dir });
      expect(existsSync(materialsDir(dir, "z"))).toBe(false);
    });
  });
});

describe("owner messages in a saved run", () => {
  const resp = (stance: string, solution: string | null) => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });
  const sc = (...steps: object[]) => createScriptedDriver({ steps } as Scenario, env);
  const send = (drv: ParticipantDriver, fn: () => void): ParticipantDriver => ({ call: (r) => { fn(); return drv.call(r); } });

  it("messages during turn 2 are written to journal after turn 2 before turn 3; journal only appends", async () => {
    const dir = tmp();
    const snaps: string[] = [];
    const p2 = send(sc(resp("agree", null), resp("agree", null)), () => {
      if (snaps.length) return;
      snaps.push(readFileSync(eventsPath(dir, "o"), "utf8"));
      requestOwnerMessage(dir, "o", "Первая", { isAlive: () => true });
      requestOwnerMessage(dir, "o", "Вторая", { isAlive: () => true });
    });
    const run = await runStoredSession({ session: mk("o"), drivers: { p1: sc(resp("amend", "v1"), resp("agree", null)), p2 }, dataDir: dir });
    const ev = readEvents(dir, "o")!.events;
    const i = ev.findIndex((e) => e.type === "owner_message");
    expect(ev[i - 1]).toMatchObject({ type: "turn_completed", turn: 2 });
    expect(ev.slice(i, i + 2)).toMatchObject([{ id: "o1", text: "Первая", afterTurn: 2 }, { id: "o2", text: "Вторая", afterTurn: 2 }]);
    expect(ev[i + 2]).toMatchObject({ type: "turn_started", turn: 3 });
    expect(readFileSync(eventsPath(dir, "o"), "utf8").startsWith(snaps[0]!)).toBe(true);
    expect(run.state.finish?.status).toBe("consensus");
    expect(existsSync(ownerMessagesDir(dir, "o"))).toBe(false);
  });

  it("after completion: finished refusal, journal unchanged, no queue folder, dropped file not applied", async () => {
    const dir = tmp();
    await runStoredSession({ session: mk("f"), drivers: await pair("consensus"), dataDir: dir });
    const before = readFileSync(eventsPath(dir, "f"));
    const state = readSession(dir, "f")!.state;
    expect(() => requestOwnerMessage(dir, "f", "Поздно", { isAlive: () => true })).toThrowError(OwnerMessageRejectedError);
    try { requestOwnerMessage(dir, "f", "Поздно", { isAlive: () => true }); } catch (e) { expect((e as OwnerMessageRejectedError).reason).toBe("finished"); }
    expect(existsSync(ownerMessagesDir(dir, "f"))).toBe(false);
    mkdirSync(ownerMessagesDir(dir, "f"));
    writeFileSync(join(ownerMessagesDir(dir, "f"), "1-x.json"), JSON.stringify({ text: "подброшено" }));
    expect(readSession(dir, "f")!.state).toEqual(state);
    expect(readFileSync(eventsPath(dir, "f")).equals(before)).toBe(true);
  });

  it("without messages the events are the same as before, except service fields", async () => {
    const strip = (es: object[]) => es.map((e) => { const { seq, ts, ...r } = e as Record<string, unknown>; return r; });
    const a = tmp();
    const b = tmp();
    const ra = await runStoredSession({ session: mk("n"), drivers: await pair("consensus"), dataDir: a });
    const rb = await runStoredSession({ session: mk("n"), drivers: await pair("consensus"), dataDir: b });
    expect(ra.events.some((e) => e.type === "owner_message")).toBe(false);
    expect(strip(ra.events).map((e) => e.type)).toEqual(strip(rb.events).map((e) => e.type));
  });
});

describe("owner wait", () => {
  type OW = { pauseAfterRound?: boolean; waitForOwner?: boolean; timeoutSec?: number };
  const step = (stance: string, solution: string | null, questions: object[] = []) =>
    ({ response: { stance, reasoning: "r", solution, answers: [], questions } });
  const sc = (...steps: object[]) => createScriptedDriver({ steps } as Scenario, env);
  const ask = [{ to: "owner", text: "Какой бюджет?" }];
  const mkw = (id: string, ownerWait: OW | undefined, maxRounds: number) =>
    createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: { maxRounds, turnTimeoutSec: 30, contextChars: 20000 },
        participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
        ...(ownerWait ? { ownerWait } : {}),
      },
      { maxParticipants: 8, id },
    );
  const counted = (d: ParticipantDriver, n: { v: number }): ParticipantDriver => ({ call: (r) => { n.v++; return d.call(r); } });
  const evs = (dir: string, id: string) => readEvents(dir, id)?.events ?? [];
  const ofType = (dir: string, id: string, t: string) => evs(dir, id).filter((e) => e.type === t);
  const until = async (cond: () => boolean, ms = 5000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error("не дождались условия");
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const waitStarted = (dir: string, id: string, n = 1) => until(() => ofType(dir, id, "owner_wait_started").length >= n);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Wait step under test control: sleep hangs until the test calls step().
  const gate = () => {
    let tick: (() => void) | null = null;
    return {
      sleep: (_ms: number, sig?: AbortSignal) => new Promise<void>((res) => { tick = res; sig?.addEventListener("abort", () => res(), { once: true }); }),
      parked: () => until(() => tick !== null),
      step: () => { const t = tick; tick = null; t?.(); },
    };
  };

  const ctls: AbortController[] = [];
  const runs: Promise<unknown>[] = [];
  afterEach(async () => {
    for (const c of ctls.splice(0)) c.abort();
    await Promise.allSettled(runs.splice(0));
  });
  const start = (dir: string, id: string, ow: OW | undefined, ds: [ParticipantDriver, ParticipantDriver], extra: object = {}, rounds = 2) => {
    const ctl = new AbortController();
    ctls.push(ctl);
    const p = runStoredSession({
      session: mkw(id, ow, rounds), drivers: { p1: ds[0], p2: ds[1] }, dataDir: dir, waitPollMs: 10, stopPollMs: 20, signal: ctl.signal, ...extra,
    });
    runs.push(p);
    return p;
  };
  const finishedEvents = (dir: string, id: string) => ofType(dir, id, "owner_wait_finished") as unknown as { waitId: string; reason: string; requestId?: string }[];
  const simple = (): [ParticipantDriver, ParticipantDriver] => [sc(step("amend", "v1"), step("agree", null)), sc(step("object", null), step("agree", null))];

  it("1. pause after round: running, deadline, participants not called; release removes", async () => {
    const dir = tmp();
    const n = { v: 0 };
    const [a, b] = simple();
    const run = start(dir, "a", { pauseAfterRound: true }, [counted(a, n), counted(b, n)]);
    await waitStarted(dir, "a");
    const s = readSession(dir, "a")!;
    expect(s.status).toBe("running");
    expect(s.state.waiting).toMatchObject({ waitId: "w1", reasons: ["round_boundary"], questionIds: [] });
    expect(Number.isNaN(Date.parse(s.state.waiting!.deadline))).toBe(false);
    expect(ofType(dir, "a", "turn_started")).toHaveLength(2);
    await pause(80);
    expect(ofType(dir, "a", "turn_started")).toHaveLength(2);
    expect(n.v).toBe(2);
    const { requestId } = requestOwnerRelease(dir, "a");
    const r = await run;
    const ev = evs(dir, "a");
    const i = ev.findIndex((e) => e.type === "owner_wait_finished");
    expect(ev[i]).toMatchObject({ waitId: "w1", reason: "continued", requestId });
    expect(existsSync(join(ownerMessagesDir(dir, "a"), `${requestId}.json`))).toBe(false);
    expect(ev[i + 1]).toMatchObject({ type: "turn_started", turn: 3 });
    expect(r.state.finish?.status).toBe("consensus");
  });

  it("2. release by a real child process: removed once, journal and participants untouched", async () => {
    const dir = tmp();
    const n = { v: 0 };
    const [a, b] = simple();
    const g = gate();
    const run = start(dir, "a", { pauseAfterRound: true }, [counted(a, n), counted(b, n)], { sleep: g.sleep });
    await waitStarted(dir, "a");
    await g.parked();
    const before = readFileSync(eventsPath(dir, "a"));
    const calls = n.v;
    const url = pathToFileURL(fileURLToPath(new URL("./owner-messages.ts", import.meta.url))).href;
    const code = `const m = await import(${JSON.stringify(url)});
process.stdout.write(JSON.stringify(m.requestOwnerRelease(${JSON.stringify(dir)}, "a")));`;
    const out = await new Promise<string>((res, rej) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
      let buf = "";
      c.stdout.on("data", (d) => { buf += d; });
      c.once("exit", (k) => (k === 0 ? res(buf) : rej(new Error(`sender exit ${k}`))));
    });
    const { requestId, waitId } = JSON.parse(out) as { requestId: string; waitId: string };
    expect(waitId).toBe("w1");
    expect(readFileSync(eventsPath(dir, "a")).equals(before)).toBe(true);
    expect(n.v).toBe(calls);
    g.step();
    await run;
    expect(finishedEvents(dir, "a")).toMatchObject([{ waitId: "w1", reason: "continued", requestId }]);
  });

  it("3. ordinary message does not remove pause, deadline same; then release", async () => {
    const dir = tmp();
    const g = gate();
    const run = start(dir, "a", { pauseAfterRound: true }, simple(), { sleep: g.sleep });
    await waitStarted(dir, "a");
    await g.parked();
    const deadline = readSession(dir, "a")!.state.waiting!.deadline;
    const { requestId } = requestOwnerMessage(dir, "a", "Просто реплика");
    g.step();
    await until(() => ofType(dir, "a", "owner_message").length === 1);
    await g.parked();
    expect(ofType(dir, "a", "owner_message")[0]).toMatchObject({ text: "Просто реплика", requestId });
    expect(finishedEvents(dir, "a")).toHaveLength(0);
    expect(readSession(dir, "a")!.state.waiting).toMatchObject({ waitId: "w1", deadline });
    requestOwnerRelease(dir, "a");
    g.step();
    await run;
    expect(finishedEvents(dir, "a")).toMatchObject([{ reason: "continued" }]);
  });

  it("4. waiting for answer: question held, answer removes wait", async () => {
    const dir = tmp();
    const run = start(dir, "a", { waitForOwner: true }, [sc(step("amend", "v1", ask), step("agree", null)), sc(step("agree", null), step("agree", null))]);
    await waitStarted(dir, "a");
    expect(readSession(dir, "a")!.state.waiting).toMatchObject({ waitId: "w1", reasons: ["owner_question"], questionIds: ["q1"] });
    requestOwnerMessage(dir, "a", "Бюджет 10", { questionId: "q1" });
    await run;
    const ev = evs(dir, "a");
    const i = ev.findIndex((e) => e.type === "owner_message");
    expect(ev[i]).toMatchObject({ answers: [{ questionId: "q1", text: "Бюджет 10" }] });
    expect(ev[i + 1]).toMatchObject({ type: "question_closed", questionId: "q1", reason: "answered" });
    expect(ev[i + 2]).toMatchObject({ type: "owner_wait_finished", waitId: "w1", reason: "answered" });
    expect(ev[i + 3]).toMatchObject({ type: "turn_started", turn: 2 });
  });

  it("5. race: release and answer back to back before executor step — one completion, publication order", async () => {
    for (const order of ["release-first", "answer-first"]) {
      const dir = tmp();
      const g = gate();
      const run = start(dir, "a", { waitForOwner: true }, [sc(step("amend", "v1", ask), step("agree", null)), sc(step("object", null), step("agree", null))], { sleep: g.sleep });
      await waitStarted(dir, "a");
      await g.parked();
      const at = evs(dir, "a").length;
      const ids: string[] = [];
      const rel = () => ids.push(requestOwnerRelease(dir, "a").requestId);
      const ans = () => ids.push(requestOwnerMessage(dir, "a", "Ответ", { questionId: "q1" }).requestId);
      if (order === "release-first") { rel(); ans(); } else { ans(); rel(); }
      g.step();
      await run;
      const ev = evs(dir, "a");
      ev.forEach((e, i) => expect(e.seq).toBe(i + 1));
      expect(finishedEvents(dir, "a")).toHaveLength(1);
      const tail = ev.slice(at, at + 3);
      if (order === "release-first") {
        expect(tail).toMatchObject([
          { type: "question_closed", reason: "unanswered" }, { type: "owner_wait_finished", reason: "continued", requestId: ids[0] },
          { type: "owner_message", requestId: ids[1] },
        ]);
      } else {
        expect(tail).toMatchObject([
          { type: "owner_message", requestId: ids[0] }, { type: "question_closed", reason: "answered" },
          { type: "owner_wait_finished", reason: "answered" },
        ]);
      }
      expect(existsSync(ownerMessagesDir(dir, "a"))).toBe(false);
    }
  });

  it("6. repeated and late release: one completion per wait", async () => {
    const dir = tmp();
    const g = gate();
    const run = start(dir, "a", { pauseAfterRound: true }, [
      sc(step("amend", "v1"), step("amend", "v2"), step("agree", null)), sc(step("object", null), step("object", null), step("agree", null)),
    ], { sleep: g.sleep }, 3);
    await waitStarted(dir, "a");
    await g.parked();
    const r1 = requestOwnerRelease(dir, "a");
    const r2 = requestOwnerRelease(dir, "a");
    expect([r1.waitId, r2.waitId]).toEqual(["w1", "w1"]);
    g.step();
    await waitStarted(dir, "a", 2);
    await g.parked();
    expect(finishedEvents(dir, "a")).toMatchObject([{ waitId: "w1", requestId: r1.requestId }]);
    const queue = ownerMessagesDir(dir, "a");
    let reason = "";
    try { requestOwnerRelease(dir, "a", { waitId: "w1" }); } catch (e) { reason = (e as OwnerReleaseRejectedError).reason; }
    expect(reason).toBe("stale_wait");
    const late = join(queue, "999999999999999-late.json");
    writeFileSync(late, JSON.stringify({ releaseWaitId: "w1" }));
    g.step();
    await g.parked();
    expect(existsSync(late)).toBe(false);
    expect(finishedEvents(dir, "a")).toHaveLength(1);
    expect(readSession(dir, "a")!.state.waiting).toMatchObject({ waitId: "w2" });
    const r3 = requestOwnerRelease(dir, "a", { waitId: "w2" });
    g.step();
    await run;
    expect(finishedEvents(dir, "a")).toMatchObject([{ waitId: "w1" }, { waitId: "w2", reason: "continued", requestId: r3.requestId }]);
  });

  it("7. deadline passed: question closed unanswered, then expired, discussion continued by itself", async () => {
    const dir = tmp();
    const t0 = Date.now();
    const run = start(dir, "a", { waitForOwner: true, timeoutSec: 1 }, [sc(step("amend", "v1", ask), step("agree", null)), sc(step("object", null), step("agree", null))], { waitPollMs: 20 });
    const r = await run;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    const ev = evs(dir, "a");
    const i = ev.findIndex((e) => e.type === "owner_wait_finished");
    expect(ev[i]).toMatchObject({ waitId: "w1", reason: "expired" });
    expect(ev[i - 1]).toMatchObject({ type: "question_closed", questionId: "q1", reason: "unanswered" });
    expect(ev[i + 1]).toMatchObject({ type: "turn_started", turn: 2 });
    expect(r.state.finish).not.toBeNull();
  });

  it("8. stop via file during wait: stopped, no turns after wait start", async () => {
    const dir = tmp();
    const run = start(dir, "a", { pauseAfterRound: true }, simple());
    await waitStarted(dir, "a");
    requestStop(dir, "a");
    const r = await run;
    const ev = evs(dir, "a");
    const i = ev.findIndex((e) => e.type === "owner_wait_started");
    expect(ev.slice(i).some((e) => e.type === "turn_started")).toBe(false);
    expect(ev[i + 1]).toMatchObject({ type: "owner_wait_finished", waitId: "w1", reason: "stopped" });
    expect(ev.at(-1)).toMatchObject({ type: "session_finished", status: "stopped" });
    expect(r.state.finish?.status).toBe("stopped");
  });

  it("9. session without ownerWait: no wait events", async () => {
    const dir = tmp();
    await runStoredSession({ session: mk("n"), drivers: await pair("consensus"), dataDir: dir });
    expect(evs(dir, "n").some((e) => e.type.startsWith("owner_wait"))).toBe(false);
    expect(readSession(dir, "n")!.state.waiting).toBeNull();
  });
});

describe("runStoredSession: draft snapshots", () => {
  const mkDrafts = (id: string, withDrafts = true) =>
    createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000 },
        ...(withDrafts ? { drafts: { synthesizerId: "p2" } } : {}),
        participants: [1, 2, 3].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id },
    );
  const reply = (stance: string, solution: string | null) => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });
  const trio = (withDrafts = true): Record<string, ParticipantDriver> => Object.fromEntries([1, 2, 3].map((i) => [
    `p${i}`, createScriptedDriver({ steps: [...(withDrafts ? [reply("amend", `Решение №${i}\nс переводом`)] : []), reply("amend", `Версия ${i}`), reply("agree", null), reply("agree", null)] }, env),
  ]));

  it("drafts/dN.txt files contain solution; chars and sha256 in journal match", async () => {
    const dir = tmp();
    await runStoredSession({ session: mkDrafts("dr"), drivers: trio(), dataDir: dir });
    const done = readEvents(dir, "dr")!.events.filter((e) => e.type === "draft_completed");
    expect(done).toHaveLength(3);
    for (const [i, e] of done.entries()) {
      if (e.type !== "draft_completed") throw new Error();
      const text = readFileSync(draftPath(dir, "dr", `d${i + 1}`), "utf8");
      expect(text).toBe(`Решение №${i + 1}\nс переводом`);
      expect(e).toMatchObject({ chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex") });
    }
  });

  it("snapshot written before draft_completed event", async () => {
    const dir = tmp();
    let seen = 0;
    await runStoredSession({
      session: mkDrafts("dr2"), drivers: trio(), dataDir: dir,
      onEvent: (e) => {
        if (e.type !== "draft_completed") return;
        expect(readDraftSnapshot(dir, "dr2", { draftId: e.draftId, chars: e.chars, sha256: e.sha256 })).toContain("Решение №");
        seen++;
      },
    });
    expect(seen).toBe(3);
  });

  it("without drafts there is no drafts folder", async () => {
    const dir = tmp();
    await runStoredSession({ session: mkDrafts("nd", false), drivers: trio(false), dataDir: dir });
    expect(existsSync(join(sessionDir(dir, "nd"), "drafts"))).toBe(false);
  });
});

describe("Interrupted session: executor crashed in a live process", () => {
  // writing after the first event fails: EACCES (chmod 0o444); as root chmod has no effect — then the journal is replaced by a folder (EISDIR)
  const breakJournal = (dir: string, id: string) => {
    if (process.getuid?.() === 0) { rmSync(eventsPath(dir, id)); mkdirSync(eventsPath(dir, id)); } else chmodSync(eventsPath(dir, id), 0o444);
  };
  const crash = async (dir: string, id: string) => {
    let broke = false;
    await expect(runStoredSession({
      session: mk(id), drivers: await pair("consensus"), dataDir: dir,
      onEvent: () => { if (!broke) { broke = true; breakJournal(dir, id); } },
    })).rejects.toThrow();
  };

  it("write failed: reading and list give interrupted, journal unchanged", async () => {
    const dir = tmp();
    await crash(dir, "x");
    if (process.getuid?.() === 0) return; // reading is impossible when a folder stands in place of the journal; the failure itself is already checked
    const before = readFileSync(eventsPath(dir, "x"), "utf8");
    expect(readSession(dir, "x")!.status).toBe("interrupted");
    expect(listSessions(dir).find((s) => s.id === "x")!.status).toBe("interrupted");
    expect(readFileSync(eventsPath(dir, "x"), "utf8")).toBe(before);
  });

  it("continuation does not refuse with reason running", async () => {
    const dir = tmp();
    await crash(dir, "x");
    if (process.getuid?.() === 0) return;
    let reason: string | undefined;
    try { planResume(dir, "x"); } catch (e) { reason = (e as { reason?: string }).reason; }
    expect(reason).not.toBe("running");
  });

  it("stop refused as interrupted, no request file", async () => {
    const dir = tmp();
    await crash(dir, "x");
    if (process.getuid?.() === 0) return;
    let err: unknown;
    try { requestStop(dir, "x"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StopRejectedError);
    expect((err as StopRejectedError).reason).toBe("interrupted");
    expect(existsSync(stopRequestPath(dir, "x"))).toBe(false);
  });

  it("control: while executor runs, status running in this process; after completion registry is clean", async () => {
    const dir = tmp();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });
    const base = await pair("consensus");
    const slow: ParticipantDriver = { call: async (r) => { started(); await gate; return base.p1!.call(r); } };
    const run = runStoredSession({ session: mk("c"), drivers: { ...base, p1: slow }, dataDir: dir });
    await hasStarted;
    expect(readSession(dir, "c")!.status).toBe("running");
    expect(listSessions(dir)[0]!.status).toBe("running");
    release();
    await run;
    expect(readSession(dir, "c")!.status).toBe("consensus");
  });
});

describe("Executor lock at session start", () => {
  // a driver that blocks the first call until released
  const gated = async (id: string) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => { started = r; });
    const base = await pair("consensus");
    const slow: ParticipantDriver = { call: async (r) => { started(); await gate; return base.p1!.call(r); } };
    return { drivers: { ...base, p1: slow }, release, hasStarted, id };
  };
  const rejected = (f: () => unknown) => { try { f(); } catch (e) { return e; } return null; };

  it("holds resume.lock with this pid while running and removes it after the end", async () => {
    const dir = tmp();
    const g = await gated("a");
    const run = runStoredSession({ session: mk("a"), drivers: g.drivers, dataDir: dir });
    await g.hasStarted;
    expect(readFileSync(resumeLockPath(dir, "a"), "utf8").trim()).toBe(String(process.pid));
    g.release();
    await run;
    expect(existsSync(resumeLockPath(dir, "a"))).toBe(false);
  });

  it("removes the lock after a stop", async () => {
    const dir = tmp();
    let at = 0;
    const run = await runStoredSession({
      session: mk("s"), drivers: await pair("slow"), dataDir: dir, stopPollMs: 20,
      onEvent: (e) => {
        if (e.type === "turn_started" && !at) { at = 1; expect(existsSync(resumeLockPath(dir, "s"))).toBe(true); writeFileSync(stopRequestPath(dir, "s"), ""); }
      },
    });
    expect(run.state.finish!.status).toBe("stopped");
    expect(existsSync(resumeLockPath(dir, "s"))).toBe(false);
  });

  it("removes the folder with the lock after an error before the first event", async () => {
    const dir = tmp();
    const text = "x\n";
    const m = { id: "m1", name: "a.txt", text, chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
    const session = createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000, materialsChars: 1000 },
        participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })), materials: [m],
      },
      { maxParticipants: 8, id: "e" },
    );
    fsHook.failOn = "m1.txt";
    try {
      await expect(runStoredSession({ session, drivers: await pair("consensus"), dataDir: dir, materials: [m] })).rejects.toBeInstanceOf(MaterialSnapshotError);
    } finally { fsHook.failOn = ""; }
    expect(existsSync(sessionDir(dir, "e"))).toBe(false);
  });

  it("rejects a repeated start with SessionExistsError and leaves the first lock and journal untouched", async () => {
    const dir = tmp();
    const g = await gated("r");
    const run = runStoredSession({ session: mk("r"), drivers: g.drivers, dataDir: dir });
    await g.hasStarted;
    const lock = readFileSync(resumeLockPath(dir, "r"), "utf8");
    const journal = readFileSync(eventsPath(dir, "r"));
    await expect(runStoredSession({ session: mk("r"), drivers: await pair("consensus"), dataDir: dir })).rejects.toBeInstanceOf(SessionExistsError);
    expect(readFileSync(resumeLockPath(dir, "r"), "utf8")).toBe(lock);
    expect(readFileSync(eventsPath(dir, "r")).equals(journal)).toBe(true);
    g.release();
    await run;
    expect(existsSync(resumeLockPath(dir, "r"))).toBe(false);
  });

  it("rejects another executor of a running session with busy before any writes", async () => {
    const dir = tmp();
    const g = await gated("b");
    const run = runStoredSession({ session: mk("b"), drivers: g.drivers, dataDir: dir });
    await g.hasStarted;
    const journal = readFileSync(eventsPath(dir, "b"));
    const e1 = rejected(() => acquireResumeLock(resumeLockPath(dir, "b"), () => true));
    expect(e1).toBeInstanceOf(ResumeRejectedError);
    expect((e1 as ResumeRejectedError).reason).toBe("busy");
    const e2 = await runResumedSession({ dataDir: dir, plan: { id: "b" } as ResumePlan, drivers: {} }).catch((e) => e);
    expect(e2).toBeInstanceOf(ResumeRejectedError);
    expect((e2 as ResumeRejectedError).reason).toBe("busy");
    expect(readFileSync(eventsPath(dir, "b")).equals(journal)).toBe(true);
    expect(readFileSync(resumeLockPath(dir, "b"), "utf8").trim()).toBe(String(process.pid));
    g.release();
    await run;
  });

  it("replaces a stale lock of a dead process", async () => {
    const dir = tmp();
    mkdirSync(sessionDir(dir, "d"), { recursive: true });
    writeFileSync(resumeLockPath(dir, "d"), "999999");
    acquireResumeLock(resumeLockPath(dir, "d"), (pid) => pid !== 999999);
    expect(readFileSync(resumeLockPath(dir, "d"), "utf8").trim()).toBe(String(process.pid));
  });
});
