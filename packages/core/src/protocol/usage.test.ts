import { describe, expect, it } from "vitest";
import type { SessionEvent, Usage } from "./schema.ts";
import { createSession, runSession } from "../engine.ts";
import type { DraftStore } from "../engine.ts";
import { sha256Of } from "../materials.ts";
import { createScriptedDriver } from "../participants/scripted.ts";
import type { Scenario } from "../participants/scripted.ts";
import type { ParticipantDriver, TurnRequest, TurnResult } from "../participants/driver.ts";
import { moscowDay, sessionUsage, summarizeUsage } from "./usage.ts";
import { foldEvents } from "./fold.ts";
import { sessionTotals, tokenUsage } from "./state.ts";
import type { SessionUsage, UsageRecord, UsageSummary } from "./usage.ts";
import type { Tariff, TariffSet } from "./tariffs.ts";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
type At = Body & { at?: string };

// ts by default: growing minutes of one day; at overrides
const mk = (bodies: At[]): SessionEvent[] =>
  bodies.map(({ at, ...b }, i) => ({ ...b, seq: i + 1, ts: at ?? new Date(Date.UTC(2026, 2, 10, 10, i)).toISOString() }) as SessionEvent);

const created = (providers: Record<string, string> = { p1: "A", p2: "B" }): Body => ({
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: "2026-03-10T10:00:00Z", origin: "cli", topic: "t", templateId: null, framing: "",
    participants: Object.entries(providers).map(([id, providerId]) => ({ id, name: id, providerId, model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  },
});
const started = (turn: number, participantId = "p1"): Body => ({ type: "turn_started", turn, round: 1, participantId });
const done = (turn: number, usage: Usage, participantId = "p1"): Body => ({
  type: "turn_completed", turn, round: 1, participantId, stance: "agree", normalized: false, reasoning: "r", solution: null,
  version: 1, questions: [], answers: [], attempts: 1, usage, durationMs: 1,
});
const failed = (turn: number, usage?: Usage, participantId = "p1", attempt = 1): Body => ({
  type: "turn_failed", turn, round: 1, participantId, attempt, kind: "invalid_response", message: "m", ...(usage ? { usage } : {}),
});
const resumed = (): Body => ({ type: "session_resumed", pid: 2, maxRounds: 3 });
const dropped = (participantId = "p1"): Body => ({ type: "participant_dropped", participantId, reason: "x" });
const dStart = (draftId: string, attempt: number, participantId = "p1"): Body => ({ type: "draft_attempt_started", draftId, participantId, attempt });
const dFail = (draftId: string, attempt: number, usage?: Usage, participantId = "p1"): Body => ({
  type: "draft_attempt_failed", draftId, participantId, attempt, kind: "timeout", message: "m", ...(usage ? { usage } : {}),
});
const dDone = (draftId: string, usage: Usage, participantId = "p1", incomplete = false): Body => ({
  type: "draft_completed", draftId, participantId, attempts: 1, durationMs: 1, usage, chars: 1, sha256: "0".repeat(64), reasoning: "r",
  ...(incomplete ? { usageIncomplete: true as const } : {}),
});

const sum = (events: At[], from = "2000-01-01", to = "2100-01-01") => summarizeUsage([sessionUsage(mk(events))], from, to);
const T = (inputTokens: number): Usage => ({ inputTokens });

describe("moscowDay", () => {
  it("day boundary, offset, month and year boundary", () => {
    expect(moscowDay("2026-10-08T20:59:59Z")).toBe("2026-10-08");
    expect(moscowDay("2026-10-08T21:00:00Z")).toBe("2026-10-09");
    expect(moscowDay("2026-10-09T00:30:00+05:00")).toBe("2026-10-08");
    expect(moscowDay("2026-10-31T21:00:00Z")).toBe("2026-11-01");
    expect(moscowDay("2026-12-31T21:00:00Z")).toBe("2027-01-01");
  });
  it("does not depend on the machine's time zone", () => {
    const old = process.env.TZ;
    try {
      for (const tz of ["America/Los_Angeles", "Asia/Tokyo"]) {
        process.env.TZ = tz;
        expect(moscowDay("2026-10-08T20:59:59Z")).toBe("2026-10-08");
        expect(moscowDay("2026-10-08T21:00:00Z")).toBe("2026-10-09");
        expect(moscowDay(new Date("2026-12-31T21:00:00Z"))).toBe("2027-01-01");
      }
    } finally {
      if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
    }
  });
});

describe("sessionUsage and summarizeUsage", () => {
  it("retry before success: the turn aggregate is counted once", () => {
    const s = sum([created(), started(1), failed(1, T(10)), done(1, T(30))]);
    expect(s.total.inputTokens).toBe(30);
    expect(s.total.records).toBe(1);
  });
  it("only failed attempts: one record per failure", () => {
    const s = sum([created(), started(1), failed(1, T(10), "p1", 1), failed(1, T(5), "p1", 2), failed(1, undefined, "p1", 3), dropped()]);
    expect(s.total).toMatchObject({ inputTokens: 15, records: 3, openCalls: 0, missing: { inputTokens: 1, outputTokens: 3, costUsd: 3 } });
  });
  it("failure before continuation and the turn after it: two records", () => {
    const s = sum([created(), started(3), failed(3, T(10)), resumed(), started(3), done(3, T(20))]);
    expect(s.total).toMatchObject({ inputTokens: 30, records: 2, openCalls: 1 }); // open call: retry, cut off before the continuation
  });
  it("aggregate crossing midnight, entirely in the completion day", () => {
    const ev: At[] = [created(), { ...started(1), at: "2026-10-08T10:00:00Z" }, { ...failed(1, T(10)), at: "2026-10-08T10:01:00Z" }, { ...done(1, T(30)), at: "2026-10-08T21:30:00Z" }];
    expect(sum(ev, "2026-10-09", "2026-10-09").total.inputTokens).toBe(30);
    const early = sum(ev, "2026-10-08", "2026-10-08");
    expect(early.total.records).toBe(0);
    expect(early.groups).toEqual([]);
  });
  it("draft with a retry: aggregate, turns beyond", () => {
    const s = sum([created(), dStart("d1", 1), dFail("d1", 1, T(7)), dStart("d1", 2), dDone("d1", T(28)), started(1), done(1, T(5))]);
    expect(s.total).toMatchObject({ inputTokens: 33, records: 2, openCalls: 0 });
  });
  it("interrupted draft attempt and usageIncomplete", () => {
    const a = sum([created(), dStart("d1", 1), dFail("d1", 1, T(4)), dStart("d1", 2)]);
    expect(a.total).toMatchObject({ inputTokens: 4, records: 1, openCalls: 1 });
    const b = sum([created(), dStart("d1", 1), resumed(), dStart("d1", 2), dDone("d1", T(9), "p1", true)]);
    expect(b.total).toMatchObject({ inputTokens: 9, records: 1, openCalls: 1 });
  });
  it("turn without outcome: call without outcome; after a participant dropped out: none", () => {
    expect(sum([created(), started(1)]).total.openCalls).toBe(1);
    expect(sum([created(), started(1), dropped()]).total.openCalls).toBe(0);
    expect(sum([created(), started(1), dropped("p2")]).total.openCalls).toBe(1);
  });
  it("lost file-request call: a gap in attempt numbers", () => {
    const base: Body[] = [created(), started(1), failed(1, T(5), "p1", 2), failed(1, T(6), "p1", 3)];
    const a = sum([...base, dropped()]);
    expect(a.total).toMatchObject({ inputTokens: 11, records: 2, openCalls: 1 });
    expect(sum(base).total.openCalls).toBe(2);
    const b = sum([created(), started(1), failed(1, T(5), "p1", 1), failed(1, T(6), "p1", 2), dropped()]);
    expect(b.total.openCalls).toBe(0);
    expect(sum([created(), started(1), failed(1, T(5), "p1", 2), done(1, T(9))]).total.openCalls).toBe(0);
  });
  it("draft aggregate crossing the date, entirely in the completion day", () => {
    const ev: At[] = [created(), { ...dStart("d1", 1), at: "2026-10-08T10:00:00Z" }, { ...dFail("d1", 1, T(7)), at: "2026-10-08T10:01:00Z" },
      { ...dStart("d1", 2), at: "2026-10-08T21:29:00Z" }, { ...dDone("d1", T(28)), at: "2026-10-08T21:30:00Z" }];
    expect(sum(ev, "2026-10-09", "2026-10-09").total).toMatchObject({ inputTokens: 28, records: 1 });
    const early = sum(ev, "2026-10-08", "2026-10-08");
    expect(early.total.records).toBe(0);
    expect(early.groups).toEqual([]);
  });
  it("gaps and zeros are not filled in", () => {
    const s = sum([created(), started(1), done(1, { inputTokens: 0 }), started(2), done(2, {})]);
    expect(s.total).toMatchObject({ inputTokens: 0, outputTokens: null, costUsd: null, records: 2, missing: { inputTokens: 1, outputTokens: 2, costUsd: 2 } });
  });
  it("mixed provider gives a record in the null group; a participant outside the snapshot too", () => {
    const s = sum([created(), dStart("d1", 1, "p1"), dFail("d1", 1, T(7), "p1"), dStart("d1", 2, "p2"), dDone("d1", T(28), "p2"), started(1, "zz"), done(1, T(3), "zz")]);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ providerId: null, inputTokens: 31, records: 2 });
    expect(s.total.inputTokens).toBe(31);
  });
  it("group order: ascending, null last", () => {
    const s = sum([created({ p1: "B", p2: "A" }), started(1, "p1"), done(1, T(1), "p1"), started(2, "p2"), done(2, T(2), "p2"), started(3, "zz"), done(3, T(4), "zz")]);
    expect(s.groups.map((g) => [g.providerId, g.inputTokens])).toEqual([["A", 2], ["B", 1], [null, 4]]);
  });
  it("journal without session_created does not throw", () => {
    expect(sum([started(1), done(1, T(1))]).groups.map((g) => g.providerId)).toEqual([null]);
  });
  it("journals get into the summary as is", () => {
    expect(summarizeUsage([], "a", "b", { unreadable: 2, truncated: 3 })).toMatchObject({ unreadable: 2, truncated: 3 });
  });

  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  type Acc = { inputTokens: number; outputTokens: number; costUsd: number; any: [boolean, boolean, boolean] };
  const FIELDS = ["inputTokens", "outputTokens", "costUsd"] as const;

  const runProperty = () => {
    let seenThree = 0, seenCutRetry = 0, seenCut = 0, seenIncomplete = 0, seenLost = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = mulberry32(seed), int = (n: number) => Math.floor(rnd() * n);
      const n = 2 + int(3);
      const prov: Record<string, string> = {};
      for (let i = 1; i <= n; i++) prov[`p${i}`] = ["A", "B", "C"][int(3)]!;
      const evs: Body[] = [created(prov)];
      const exp = new Map<string, Acc>();
      let records = 0, open = 0, stop = false;
      const keys = { turns: 0, drafts: 0 };
      const rec = (pid: string, u: Usage) => {
        const a = exp.get(prov[pid]!) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, any: [false, false, false] as [boolean, boolean, boolean] };
        FIELDS.forEach((f, i) => { if (u[f] !== undefined) { a[f] += u[f]!; a.any[i] = true; } });
        exp.set(prov[pid]!, a);
      };
      const usageOf = (): Usage => {
        const u: Usage = {};
        if (rnd() < 0.7) u.inputTokens = int(50);
        if (rnd() < 0.7) u.outputTokens = int(50);
        if (rnd() < 0.5) u.costUsd = int(50);
        return u;
      };
      const add = (a: Usage, b: Usage): Usage => {
        const r: Usage = { ...a };
        for (const f of FIELDS) if (b[f] !== undefined) r[f] = (r[f] ?? 0) + b[f]!;
        return r;
      };
      // files: a successful file-request call: no event, usage goes only into the completion aggregate
      const outcome = (): "ok" | "bad" | "nousage" | "cut" | "files" => {
        const x = rnd();
        return x < 0.07 ? "cut" : x < 0.17 ? "files" : x < 0.5 ? "ok" : x < 0.82 ? "bad" : "nousage";
      };
      const cut = () => { seenCut++; if (rnd() < 0.25) stop = true; else evs.push(resumed()); };

      // independent drafts
      if (rnd() < 0.7) {
        for (let k = 1; k <= n && !stop; k++) {
          const pid = `p${k}`, id = `d${k}`;
          let attempt = 0, failedSum: Usage = {}, failedCount = 0, orphans = 0, completed = false;
          const files: Usage[] = [];
          while (attempt < 3 && !completed && !stop) {
            attempt++;
            evs.push(dStart(id, attempt, pid));
            const o = outcome();
            if (o === "cut") { orphans++; cut(); continue; }
            if (o === "files") { files.push(usageOf()); continue; }
            if (o === "ok") {
              const u = usageOf();
              rec(pid, u);
              for (const f of files) rec(pid, f);
              evs.push(dDone(id, files.reduce(add, add(failedSum, u)), pid, orphans > 0));
              if (orphans > 0) { open++; seenIncomplete++; }
              records += 1;
              completed = true;
              if (attempt === 3) seenThree++;
            } else {
              const u = o === "bad" ? usageOf() : undefined;
              if (u) { rec(pid, u); failedSum = add(failedSum, u); }
              failedCount++;
              evs.push(dFail(id, attempt, u, pid));
            }
          }
          keys.drafts++;
          if (!completed) { records += failedCount; open += orphans + files.length; if (files.length) seenLost++; }
        }
      }
      // regular turns
      const turns = stop ? 0 : 1 + int(6);
      for (let t = 1; t <= turns && !stop; t++) {
        const pid = `p${1 + int(n)}`;
        keys.turns++;
        for (;;) {
          evs.push(started(t, pid));
          let counter: Usage = {}, fails = 0, finished = false, drop = false, maxFail = 0;
          const files: { a: number; u: Usage }[] = [];
          for (let a = 1; a <= 3; a++) {
            let o = outcome();
            if (o === "files" && a === 3) o = "bad";
            if (o === "cut") break;
            if (o === "files") { const u = usageOf(); files.push({ a, u }); counter = add(counter, u); continue; }
            const u = o === "nousage" ? undefined : usageOf();
            if (u) { rec(pid, u); counter = add(counter, u); }
            if (o === "ok") {
              evs.push(done(t, counter, pid));
              for (const f of files) rec(pid, f.u);
              records += 1;
              finished = true;
              if (a === 3) seenThree++;
              break;
            }
            evs.push(failed(t, u, pid, a));
            maxFail = a;
            fails++;
            if (a === 3) { evs.push(dropped(pid)); drop = true; }
          }
          if (finished) break;
          records += fails;
          const lost = files.filter((f) => f.a < maxFail).length; // a file-read call is visible only as a gap below the last failure
          open += lost;
          if (lost) seenLost++;
          if (drop) break;
          open++;
          cut();
          if (stop) break;
          seenCutRetry++;
        }
      }

      const events = mk(evs);
      const s = summarizeUsage([sessionUsage(events)], "2000-01-01", "2100-01-01");
      const ctx = `seed ${seed}`;
      expect(s.total.records, ctx).toBe(records);
      expect(s.total.openCalls, ctx).toBe(open);
      const all: Acc = { inputTokens: 0, outputTokens: 0, costUsd: 0, any: [false, false, false] };
      for (const [p, a] of exp) {
        const g = s.groups.find((x) => x.providerId === p);
        FIELDS.forEach((f, i) => {
          expect(g?.[f] ?? null, `${ctx} ${p} ${f}`).toBe(a.any[i] ? a[f] : null);
          all[f] += a[f]; if (a.any[i]) all.any[i] = true;
        });
      }
      FIELDS.forEach((f, i) => expect(s.total[f], `${ctx} total ${f}`).toBe(all.any[i] ? all[f] : null));
      expect(s.groups.reduce((x, g) => x + g.records, 0), ctx).toBe(records);
    }
    // the generator reached the bounds
    expect(seenThree).toBeGreaterThan(0);
    expect(seenCutRetry).toBeGreaterThan(0);
    expect(seenCut).toBeGreaterThan(0);
    expect(seenIncomplete).toBeGreaterThan(0);
    expect(seenLost).toBeGreaterThan(0);
  };

  it("Requirement: Retries and file reads in history usage; Independent drafts in history usage: 400 random journals", runProperty);

  describe("journals of the real engine: participant replacement on continuation", () => {
    type Step = Scenario["steps"][number];
    const scripted = (...steps: Step[]) => createScriptedDriver({ steps }, { COUNCIL_DEV: "1" });
    const tok = (s: Step, inputTokens: number, outputTokens: number): Step => ({ ...s, inputTokens, outputTokens } as Step);
    const resp = (stance: string, solution: string | null): Step => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });
    const call = (fn: (req: TurnRequest) => Promise<TurnResult>): ParticipantDriver => ({ call: fn });
    let tick = 0;
    const clock = () => new Date(Date.UTC(2026, 2, 10, 10) + (tick += 10));
    const mkSession = (providers: string[], drafts: boolean) => createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 5, turnTimeoutSec: 30, contextChars: 20000 },
        ...(drafts ? { drafts: {} } : {}),
        participants: providers.map((providerId, i) => ({ name: `N${i + 1}`, providerId, model: "m", role: null })),
      },
      { maxParticipants: 8, id: "s1", now: clock },
    );
    const rep = (oldId: string, id: string, providerId: string) => ({
      oldParticipantId: oldId, participant: { id, name: `N${id}`, providerId, model: "m", role: null },
    });
    const byProvider = (events: SessionEvent[]) => {
      const s = summarizeUsage([sessionUsage(events)], "2000-01-01", "2100-01-01");
      return Object.fromEntries(s.groups.map((g) => [String(g.providerId), g.inputTokens]));
    };

    it("The replacement participant is counted in its provider's group", async () => {
      const session = mkSession(["A", "A"], false);
      const head = await runSession({
        session, now: clock,
        drivers: { p1: scripted(tok(resp("amend", "v1"), 100, 10)), p2: scripted({ error: "сбой", retryable: false }) },
      });
      const tail = await runSession({
        session, now: clock,
        drivers: { p1: scripted(tok(resp("agree", null), 7, 1)), p2: scripted(), p3: scripted(tok(resp("agree", null), 40, 4)) },
        resume: { events: head.events, maxRounds: 5, replacements: [rep("p2", "p3", "B")] },
      });
      expect(tail.events.find((e) => e.type === "session_resumed")).toHaveProperty("replacements");
      expect(byProvider([...head.events, ...tail.events])).toEqual({ A: 107, B: 40 });
    });

    it("Requirement: Unknown attribution of mixed usage: replacement with an unfinished draft", async () => {
      const session = mkSession(["C", "A", "C"], true);
      const m = new Map<string, string>();
      const draftStore: DraftStore = {
        save: (id, t) => (m.set(id, t), { chars: t.length, sha256: sha256Of(t) }),
        load: ({ draftId }) => { const t = m.get(draftId); if (t === undefined) throw new Error("нет"); return t; },
      };
      const ctl = new AbortController();
      const hang = call((req) => new Promise<TurnResult>((_, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => ctl.abort(), 0);
      }));
      const bad = tok({ raw: "это не JSON" }, 25, 5);
      const first = scripted(bad);
      let n = 0;
      const p2 = call((req) => (n++ === 0 ? first.call(req) : hang.call(req)));
      const head = await runSession({
        session, now: clock, signal: ctl.signal, draftStore,
        drivers: { p1: scripted(tok(resp("amend", "черновик p1"), 1, 1)), p2, p3: scripted() },
      });
      const headEvents = head.events.filter((e) => e.type !== "session_finished");
      const tail = await runSession({
        session, now: clock, draftStore,
        drivers: {
          p1: scripted(resp("agree", null)), p2: scripted(), p3: scripted(tok(resp("amend", "черновик p3"), 2, 2), resp("agree", null)),
          p4: scripted(tok(resp("amend", "черновик p2/p4"), 60, 6), resp("agree", null)),
        },
        resume: { events: headEvents, maxRounds: 1, replacements: [rep("p2", "p4", "B")] },
      });
      const all = [...headEvents, ...tail.events];
      const d2 = all.filter((e) => "draftId" in e && e.draftId === "d2").map((e) => `${e.type}:${"participantId" in e ? e.participantId : ""}:${JSON.stringify("usage" in e ? e.usage : null)}`);
      const done2 = all.find((e) => e.type === "draft_completed" && e.draftId === "d2");
      expect(done2, d2.join(" | ")).toBeDefined();
      const sum = summarizeUsage([sessionUsage(all)], "2000-01-01", "2100-01-01");
      const g = (id: string | null) => sum.groups.find((x) => x.providerId === id);
      // slot d2 aggregate (failure of p2 from provider A + completion of p4 from provider B): one record without a provider
      expect(done2 && "usage" in done2 ? done2.usage?.inputTokens : null, d2.join(" | ")).toBe(85);
      expect(g(null)).toMatchObject({ inputTokens: 85, records: 1 });
      expect(g("A")).toBeUndefined();
      expect(g("B")).toBeUndefined();
    });
  });
});

describe("record model", () => {
  const mkP = (spec: Record<string, [string, string]>): Body => ({
    ...created(), session: { ...(created() as any).session, participants: Object.entries(spec).map(([id, [providerId, model]]) => ({ id, name: id, providerId, model, role: null })) },
  } as Body);
  const recs = (events: At[]) => sessionUsage(mk(events)).records;
  it("model comes from the participant snapshot", () => {
    expect(recs([mkP({ p1: ["A", "m1"] }), started(1), done(1, T(1))])[0]).toMatchObject({ providerId: "A", model: "m1" });
  });
  it("model of a replacement participant comes from session_resumed.replacements", () => {
    const r = recs([mkP({ p1: ["A", "m1"] }), resumed(), started(1, "p3"), done(1, T(1), "p3")].map((b) => b.type === "session_resumed"
      ? { ...b, replacements: [{ oldParticipantId: "p1", participant: { id: "p3", name: "p3", providerId: "B", model: "m9", role: null } }] } as Body : b));
    expect(r[0]).toMatchObject({ providerId: "B", model: "m9" });
  });
  it("participants of one provider with different models: provider is set, model is not", () => {
    const r = recs([mkP({ p1: ["A", "m1"], p2: ["A", "m2"] }), dStart("d1", 1, "p1"), dFail("d1", 1, T(7), "p1"), dStart("d1", 2, "p2"), dDone("d1", T(28), "p2")]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ providerId: "A", model: null });
    expect(r[0]!.participantIds.sort()).toEqual(["p1", "p2"]);
  });
  it("participant outside the lineup: provider and model null", () => {
    expect(recs([mkP({ p1: ["A", "m1"] }), started(1, "zz"), done(1, T(1), "zz")])[0]).toMatchObject({ providerId: null, model: null });
  });
});

describe("tariff estimate", () => {
  const tar = (providerId: string, model: string, i: number, o: number, currency = "USD", asOf = "2026-03-01"): Tariff =>
    ({ providerId, model, source: "s", asOf, currency, inputPerMillion: i, outputPerMillion: o });
  const set = (...tariffs: Tariff[]): TariffSet => ({ state: "loaded", tariffs, warnings: [] });
  const rec = (providerId: string | null, model: string | null, usage: Usage, ts = "2026-03-10T10:00:00Z"): UsageRecord => ({ ts, providerId, model, usage, participantIds: [] });
  const run = (records: UsageRecord[], tariffs?: TariffSet) => summarizeUsage([{ records, open: [] }], "2026-03-10", "2026-03-10", undefined, tariffs);
  const zero = { no_model: 0, default_model: 0, no_tariff: 0, no_split: 0 };

  it("simple tariff; reported cost does not change", () => {
    const t = tar("A", "m1", 2, 4);
    const s = run([rec("A", "m1", { inputTokens: 1_000_000, outputTokens: 500_000, costUsd: 3 })], set(t));
    expect(s.total.estimate).toEqual({ byCurrency: [{ currency: "USD", amount: 4, records: 1 }], skipped: zero });
    expect(s.groups[0]!.estimate).toEqual(s.total.estimate);
    expect(s.total.costUsd).toBe(3);
    expect(s.tariffs.applied).toEqual([t]);
  });
  it("only input tokens: no_split, not zero", () => {
    const s = run([rec("A", "m1", { inputTokens: 100 })], set(tar("A", "m1", 2, 4)));
    expect(s.total.estimate).toEqual({ byCurrency: [], skipped: { ...zero, no_split: 1 } });
    expect(s.tariffs.applied).toEqual([]);
  });
  it("default model: tariff is ignored", () => {
    const s = run([rec("A", "default", { inputTokens: 1, outputTokens: 1 })], set(tar("A", "default", 2, 4)));
    expect(s.total.estimate).toEqual({ byCurrency: [], skipped: { ...zero, default_model: 1 } });
    expect(s.tariffs.applied).toEqual([]);
  });
  it("no tariff for the model", () => {
    const s = run([rec("A", "m2", { inputTokens: 1, outputTokens: 1 })], set(tar("A", "m1", 2, 4)));
    expect(s.total.estimate!.skipped).toEqual({ ...zero, no_tariff: 1 });
  });
  it("ambiguous aggregate: model null", () => {
    const s = run([rec("A", null, { inputTokens: 1, outputTokens: 1 }), rec(null, "m1", { inputTokens: 1, outputTokens: 1 })], set(tar("A", "m1", 2, 4)));
    expect(s.total.estimate!.skipped).toEqual({ ...zero, no_model: 2 });
  });
  it("different currencies: in code order, without a total; applied by model", () => {
    const eur = tar("A", "m2", 1, 1, "EUR"), usd = tar("A", "m1", 2, 2, "USD");
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const s = run([rec("A", "m1", u), rec("A", "m2", u)], set(usd, eur));
    expect(s.total.estimate!.byCurrency).toEqual([{ currency: "EUR", amount: 2, records: 1 }, { currency: "USD", amount: 4, records: 1 }]);
    expect(s.tariffs.applied).toEqual([usd, eur]);
  });
  it("reported zero tokens: estimate 0, record covered", () => {
    const s = run([rec("A", "m1", { inputTokens: 0, outputTokens: 0 })], set(tar("A", "m1", 2, 4)));
    expect(s.total.estimate).toEqual({ byCurrency: [{ currency: "USD", amount: 0, records: 1 }], skipped: zero });
  });
  it("without tariffs, unreadable and loaded with an empty list: estimate null, state and warnings as is", () => {
    const r = [rec("A", "m1", { inputTokens: 1, outputTokens: 1 })];
    for (const ts of [undefined, { state: "unreadable" as const, tariffs: [], warnings: ["tariffs.json: не JSON"] }, { state: "loaded" as const, tariffs: [], warnings: ["w"] }]) {
      const s = run(r, ts);
      expect(s.total.estimate).toBeNull();
      expect(s.groups.every((g) => g.estimate === null)).toBe(true);
      expect(s.tariffs).toEqual({ state: ts?.state ?? "absent", warnings: ts?.warnings ?? [], applied: [] });
    }
  });
  it("a record outside the period is not in the estimate or applied", () => {
    const s = run([rec("A", "m1", { inputTokens: 1, outputTokens: 1 }, "2026-03-12T10:00:00Z")], set(tar("A", "m1", 2, 4)));
    expect(s.total.records).toBe(0);
    expect(s.total.estimate).toEqual({ byCurrency: [], skipped: zero });
    expect(s.tariffs.applied).toEqual([]);
  });

  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const strip = (s: UsageSummary) => {
    const { tariffs: _t, ...rest } = s;
    return { ...rest, total: { ...rest.total, estimate: undefined }, groups: rest.groups.map((g) => ({ ...g, estimate: undefined })) };
  };

  it("Requirement «Reported and calculated cost are separated»: 400 random sets of records and tariffs", () => {
    const seen = { cut: 0, def: 0, nullModel: 0, twoCur: 0, empty: 0, zero: 0 };
    const PROV = ["A", "B", null], MODELS = ["m1", "m2", "default", null], PAIRS = [["A", "m1"], ["A", "m2"], ["B", "m1"], ["B", "m2"], ["A", "default"]] as const;
    const DAYS = ["2026-03-09", "2026-03-10", "2026-03-11"];
    for (let seed = 1; seed <= 400; seed++) {
      const rnd = mulberry32(seed), int = (n: number) => Math.floor(rnd() * n), pick = <X,>(a: readonly X[]) => a[int(a.length)]!;
      const num = () => (int(4) === 0 ? 0 : int(5_000_000));
      const sessions: SessionUsage[] = Array.from({ length: 1 + int(3) }, () => ({
        records: Array.from({ length: int(8) }, () => {
          const usage: Usage = {};
          if (int(4)) usage.inputTokens = num();
          if (int(4)) usage.outputTokens = num();
          if (int(2)) usage.costUsd = rnd();
          return { ts: `${pick(DAYS)}T${String(int(24)).padStart(2, "0")}:00:00Z`, providerId: pick(PROV), model: pick(MODELS), usage, participantIds: [] };
        }),
        open: Array.from({ length: int(3) }, () => ({ ts: `${pick(DAYS)}T10:00:00Z`, providerId: pick(PROV) })),
      }));
      const tariffs: Tariff[] = int(5) === 0 ? [] : PAIRS.filter(() => int(2)).map(([providerId, model], i) => ({
        providerId, model, source: "s", asOf: `2026-03-0${1 + i}`, currency: pick(["USD", "EUR"]),
        inputPerMillion: int(4) === 0 ? 0 : rnd() * 20, outputPerMillion: int(4) === 0 ? 0 : rnd() * 20,
      }));
      const ts: TariffSet = { state: "loaded", tariffs, warnings: ["w"] };
      const plain = summarizeUsage(sessions, "2026-03-10", "2026-03-10");
      const full = summarizeUsage(sessions, "2026-03-10", "2026-03-10", undefined, ts);
      // (a) the reported part does not depend on tariffs
      expect(strip(full)).toEqual(strip(plain));
      if (tariffs.length === 0) seen.empty++;

      // independent calculation
      const usedKeys = new Set<string>();
      type Ref = { n: number; cur: Map<string, { sum: number; n: number }> };
      const refs = new Map<string, Ref>();
      const ref = (k: string) => { let r = refs.get(k); if (!r) refs.set(k, (r = { n: 0, cur: new Map() })); return r; };
      for (const sess of sessions) for (const r of sess.records) {
        const d = new Date(r.ts); const day = new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
        if (day !== "2026-03-10") continue;
        const t = tariffs.find((x) => x.providerId === r.providerId && x.model === r.model);
        const buckets = [ref("total"), ref(`g:${r.providerId}`)];
        for (const b of buckets) b.n++;
        if (r.model === "default" && r.providerId !== null && tariffs.some((x) => x.model === "default")) seen.def++;
        if (r.model === null) seen.nullModel++;
        if (!t || r.providerId === null || r.model === null || r.model === "default") continue;
        if (r.usage.inputTokens === undefined || r.usage.outputTokens === undefined) {
          if (r.usage.inputTokens !== undefined || r.usage.outputTokens !== undefined) seen.cut++;
          continue;
        }
        const amount = (r.usage.inputTokens * t.inputPerMillion) / 1e6 + (r.usage.outputTokens * t.outputPerMillion) / 1e6;
        if (r.usage.inputTokens === 0 && r.usage.outputTokens === 0) seen.zero++;
        usedKeys.add(`${t.providerId}/${t.model}`);
        for (const b of buckets) { const c = b.cur.get(t.currency) ?? { sum: 0, n: 0 }; c.sum += amount; c.n++; b.cur.set(t.currency, c); }
      }
      // (b)
      const check = (key: string, e: UsageSummary["total"]["estimate"], records: number) => {
        if (tariffs.length === 0) { expect(e).toBeNull(); return; }
        expect(e).not.toBeNull();
        const covered = e!.byCurrency.reduce((a, c) => a + c.records, 0) + Object.values(e!.skipped).reduce((a, b) => a + b, 0);
        expect(covered).toBe(records);
        const want = refs.get(key)?.cur ?? new Map();
        expect(e!.byCurrency.map((c) => c.currency)).toEqual([...want.keys()].sort());
        for (const c of e!.byCurrency) { expect(c.amount).toBeCloseTo(want.get(c.currency)!.sum, 6); expect(c.records).toBe(want.get(c.currency)!.n); }
        if (e!.byCurrency.length === 2) seen.twoCur++;
      };
      check("total", full.total.estimate, full.total.records);
      for (const g of full.groups) check(`g:${g.providerId}`, g.estimate, g.records);
      // (c)
      expect(new Set(full.tariffs.applied.map((t) => `${t.providerId}/${t.model}`))).toEqual(usedKeys);
      expect(full.tariffs.applied).toHaveLength(usedKeys.size);
    }
    for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(0);
  });
});

describe("Requirement: Total session usage: state and «History» from one journal", () => {
  const TT = (inputTokens: number, outputTokens: number): Usage => ({ inputTokens, outputTokens });
  const served = (turn: number, usage: Usage, participantId = "p2", attempt = 1): Body => ({ type: "turn_files_served", turn, round: 1, participantId, attempt, usage });
  const dServed = (draftId: string, attempt: number, usage: Usage, participantId = "p2"): Body => ({ type: "draft_files_served", draftId, participantId, attempt, usage });
  const three = created({ p1: "A", p2: "B", p3: "C" });
  const journals: Record<string, { bodies: Body[]; total: number; incomplete: boolean }> = {
    // turn 2: failure 250, call cut off by a stop, continuation, turn 2 repeated with 20
    F1: { bodies: [created(), started(1), done(1, TT(0, 0)), started(2, "p2"), failed(2, TT(150, 100), "p2", 1), resumed(), started(2, "p2"), done(2, TT(10, 10), "p2")], total: 270, incomplete: true },
    // file request 1000, two failures without usage, dropout
    F2: { bodies: [three, started(1), done(1, TT(0, 0)), started(2, "p2"), served(2, TT(600, 400)), failed(2, undefined, "p2", 2), failed(2, undefined, "p2", 3), dropped("p2")], total: 1000, incomplete: true },
    F3: { bodies: [three, dStart("d2", 1, "p2"), dServed("d2", 1, TT(600, 400)), dStart("d2", 2, "p2"), dFail("d2", 2, undefined, "p2"), dStart("d2", 3, "p2"), dFail("d2", 3, undefined, "p2"), dropped("p2")], total: 1000, incomplete: true },
    // file request, cut-off call, continuation, draft accepted: aggregate 1300 with usageIncomplete
    F4: { bodies: [three, dStart("d2", 1, "p2"), dServed("d2", 1, TT(600, 400)), dStart("d2", 2, "p2"), resumed(), dStart("d2", 3, "p2"), dDone("d2", TT(900, 400), "p2", true)], total: 1300, incomplete: true },
    // turn without failures cut off by a stop, completed after continuation
    F5: { bodies: [created(), started(1), resumed(), started(1), done(1, TT(5, 5))], total: 10, incomplete: true },
  };
  const recordTokens = (events: SessionEvent[]) => sessionUsage(events).records.reduce((a, r) => a + (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0), 0);

  for (const [name, j] of Object.entries(journals)) {
    it(`${name}: tokenUsage, sessionTotals and sessionUsage entries give ${j.total}`, () => {
      const events = mk(j.bodies);
      const state = foldEvents(events);
      expect(tokenUsage(state)).toMatchObject({ total: j.total, incomplete: j.incomplete });
      const t = sessionTotals(state);
      expect((t.inputTokens ?? 0) + (t.outputTokens ?? 0)).toBe(j.total);
      expect(t.incomplete).toBe(j.incomplete);
      expect(recordTokens(events)).toBe(j.total);
    });
  }
  it("F2: an attempt with a file-request event has no call without outcome; incompleteness comes from failures without usage", () => {
    const u = sessionUsage(mk(journals.F2!.bodies));
    expect(u.open).toEqual([]);
    expect(u.records.filter((r) => r.usage.inputTokens === undefined)).toHaveLength(2);
  });
  it("file request and completion in one segment: aggregate 1400, the event is not counted a second time", () => {
    const events = mk([three, started(1, "p2"), served(1, TT(600, 400)), done(1, TT(1000, 400), "p2")]);
    expect(tokenUsage(foldEvents(events))).toEqual({ inputTokens: 1000, outputTokens: 400, total: 1400, incomplete: false });
    expect(recordTokens(events)).toBe(1400);
  });
  it("provider did not report file-request usage: event with empty usage, sum incomplete", () => {
    const events = mk([three, started(1, "p2"), served(1, {}), failed(1, TT(5, 5), "p2", 2), failed(1, TT(5, 5), "p2", 3), dropped("p2")]);
    expect(tokenUsage(foldEvents(events))).toMatchObject({ total: 20, incomplete: true });
    expect(sessionUsage(events).open).toEqual([]);
  });
});
