import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionEvent } from "../protocol/schema.ts";
import { appendEvent, createSessionJournal, eventsPath, sessionsDir } from "./journal.ts";
import { readUsageSummary, type UsageSkip } from "./usage.ts";
import { tariffsPath } from "./tariffs.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-usage-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ts = (n = 0) => new Date(Date.UTC(2026, 2, 10, 10, n)).toISOString();
const session = (id: string, providerId: string): Session => ({
  id, createdAt: ts(), origin: "cli", topic: "t", templateId: null, framing: "",
  participants: ["p1", "p2"].map((i) => ({ id: i, name: i, providerId, model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
});
function write(id: string, providerId: string, input: number, day = ts()) {
  createSessionJournal(dir, id);
  const evs: SessionEvent[] = [
    { seq: 1, ts: day, type: "session_created", session: session(id, providerId), pid: 1 },
    { seq: 2, ts: day, type: "turn_started", turn: 1, round: 1, participantId: "p1" },
    {
      seq: 3, ts: day, type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "agree", normalized: false, reasoning: "r",
      solution: null, version: 1, questions: [], answers: [], attempts: 1, usage: { inputTokens: input }, durationMs: 1,
    },
  ];
  for (const e of evs) appendEvent(dir, id, e);
}
const ids = (n: number) => `20260310-10000${n}-aaaa`;

describe("readUsageSummary", () => {
  it("two sessions with different providers, no config — both groups in place", () => {
    write(ids(1), "alpha", 5);
    write(ids(2), "removed-from-config", 7);
    const s = readUsageSummary(dir, "2026-03-10", "2026-03-10");
    expect(s.groups.map((g) => [g.providerId, g.inputTokens])).toEqual([["alpha", 5], ["removed-from-config", 7]]);
    expect(s.unreadable + s.truncated).toBe(0);
  });
  it("empty data folder — empty summary", () => {
    expect(readUsageSummary(dir, "2026-03-10", "2026-03-10").groups).toEqual([]);
  });
  it("broken journals: unreadable start and junk tail", () => {
    write(ids(1), "alpha", 5);
    write(ids(2), "beta", 7);
    appendFileSync(eventsPath(dir, ids(2)), "{мусор\n");
    createSessionJournal(dir, ids(3));
    writeFileSync(eventsPath(dir, ids(3)), "не json\n");
    const s = readUsageSummary(dir, "2026-03-10", "2026-03-10");
    expect(s.unreadable).toBe(1);
    expect(s.truncated).toBe(1);
    expect(s.groups.map((g) => [g.providerId, g.inputTokens])).toEqual([["alpha", 5], ["beta", 7]]);
  });
  it("onSkip: once per unreadable and truncated journal, no path in reason", () => {
    write(ids(1), "alpha", 5);
    write(ids(2), "beta", 7);
    appendFileSync(eventsPath(dir, ids(2)), "{мусор\n");
    createSessionJournal(dir, ids(3));
    writeFileSync(eventsPath(dir, ids(3)), "не json\n");
    const skips: UsageSkip[] = [];
    const s = readUsageSummary(dir, "2026-03-10", "2026-03-10", (k) => skips.push(k));
    const size = readFileSync(eventsPath(dir, ids(2))).length;
    const full = size - Buffer.byteLength("{мусор\n");
    expect(skips.sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual([
      { id: ids(2), kind: "truncated", reason: `прочитано ${full} из ${size} байт` },
      { id: ids(3), kind: "unreadable", reason: "нет читаемого события session_created" },
    ]);
    expect(skips.some((k) => k.reason.includes(dir))).toBe(false);
    expect(s).toEqual(readUsageSummary(dir, "2026-03-10", "2026-03-10"));
  });
  it("onSkip: read exception gives error code without path", () => {
    write(ids(1), "alpha", 5);
    rmSync(eventsPath(dir, ids(1)));
    mkdirSync(eventsPath(dir, ids(1)));
    const skips: UsageSkip[] = [];
    expect(readUsageSummary(dir, "2026-03-10", "2026-03-10", (k) => skips.push(k)).unreadable).toBe(1);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ id: ids(1), kind: "unreadable" });
    expect(skips[0]!.reason).not.toContain(dir);
  });
  it("Requirement: Summary is not a provider count: reading changes nothing (60 date pairs)", () => {
    write(ids(1), "alpha", 5);
    write(ids(2), "beta", 7);
    appendFileSync(eventsPath(dir, ids(2)), "{мусор\n");
    const snap = () => {
      const out: Record<string, string> = {};
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p); else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
        }
      };
      walk(dir);
      return out;
    };
    const before = snap();
    expect(Object.keys(before).length).toBeGreaterThan(0);
    expect(sessionsDir(dir)).toContain(dir);
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const day = () => `2026-03-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;
    for (let i = 0; i < 60; i++) {
      readUsageSummary(dir, day(), day());
      expect(snap()).toEqual(before);
    }
  });

  describe("tariffs", () => {
    const tariff = (asOf: string, inputPerMillion: number) => ({ providerId: "alpha", model: "m", source: "прайс", asOf, currency: "USD", inputPerMillion, outputPerMillion: 0 });
    const putTariffs = (asOf: string, price: number) => writeFileSync(tariffsPath(dir), JSON.stringify({ tariffs: [tariff(asOf, price)] }));
    const files = () => {
      const out: Record<string, string> = {};
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p); else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
        }
      };
      walk(dir);
      return out;
    };
    // the participant has no outputTokens: the estimate needs both values, so the journal with both
    const writeBoth = () => {
      write(ids(1), "alpha", 1_000_000);
      const e: SessionEvent = {
        seq: 4, ts: ts(), type: "turn_completed", turn: 2, round: 1, participantId: "p1", stance: "agree", normalized: false, reasoning: "r",
        solution: null, version: 1, questions: [], answers: [], attempts: 1, usage: { inputTokens: 1_000_000, outputTokens: 0 }, durationMs: 1,
      };
      appendEvent(dir, ids(1), { seq: 4, ts: ts(), type: "turn_started", turn: 2, round: 1, participantId: "p1" });
      appendEvent(dir, ids(1), { ...e, seq: 5 });
    };
    const reported = (s: ReturnType<typeof readUsageSummary>) => ({ ...s, total: { ...s.total, estimate: null }, groups: s.groups.map((g) => ({ ...g, estimate: null })), tariffs: null });

    it("correct tariffs.json: estimate present, files unchanged, nothing new", () => {
      writeBoth();
      putTariffs("2026-03-01", 2);
      const before = files();
      const s = readUsageSummary(dir, "2026-03-10", "2026-03-10");
      expect(s.tariffs.state).toBe("loaded");
      expect(s.total.estimate).toEqual({ byCurrency: [{ currency: "USD", amount: 2, records: 1 }], skipped: { no_model: 0, default_model: 0, no_tariff: 0, no_split: 1 } });
      expect(files()).toEqual(before);
    });
    it("no tariffs.json: absent, estimate null, reported unchanged", () => {
      writeBoth();
      const bare = readUsageSummary(dir, "2026-03-10", "2026-03-10");
      putTariffs("2026-03-01", 2);
      expect(reported(readUsageSummary(dir, "2026-03-10", "2026-03-10"))).toEqual(reported(bare));
      rmSync(tariffsPath(dir));
      const s = readUsageSummary(dir, "2026-03-10", "2026-03-10");
      expect(s.tariffs.state).toBe("absent");
      expect(s.total.estimate).toBeNull();
      expect(s.groups.every((g) => g.estimate === null)).toBe(true);
    });
    it("tariffs.json not JSON: summary returned, unreadable, file untouched", () => {
      writeBoth();
      const bare = readUsageSummary(dir, "2026-03-10", "2026-03-10");
      writeFileSync(tariffsPath(dir), "{не json");
      const before = files();
      const s = readUsageSummary(dir, "2026-03-10", "2026-03-10");
      expect(s.tariffs.state).toBe("unreadable");
      expect(s.tariffs.warnings).toContain("tariffs.json: не JSON");
      expect(s.total.estimate).toBeNull();
      expect(reported(s)).toEqual(reported(bare));
      expect(files()).toEqual(before);
    });
    it("tariffs.json replaced between calls: new amount and asOf, no cache", () => {
      writeBoth();
      putTariffs("2026-03-01", 2);
      const a = readUsageSummary(dir, "2026-03-10", "2026-03-10");
      const log = readFileSync(eventsPath(dir, ids(1)));
      putTariffs("2026-03-05", 5);
      const b = readUsageSummary(dir, "2026-03-10", "2026-03-10");
      expect(a.total.estimate!.byCurrency[0]!.amount).toBe(2);
      expect(b.total.estimate!.byCurrency[0]!.amount).toBe(5);
      expect(b.tariffs.applied.map((t) => t.asOf)).toEqual(["2026-03-05"]);
      expect(reported(b)).toEqual(reported(a));
      expect(readFileSync(eventsPath(dir, ids(1)))).toEqual(log);
    });
  });
});
