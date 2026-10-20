import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_RECORD, VERIFIED_FILE, loadVerifiedRecord, mergeRecords, type VerifiedEntry } from "./verified-record.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = 400;
const VERSIONS = ["0.0.0", "2.1.0", "2.1.288", "0.159.2", "10.0.1"];
const DATES = ["2026-10-01", "2026-10-07", "2026-10-16"];
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const rank = (e: VerifiedEntry) => (e.level === "real" ? 1 : 0);
const key = (e: VerifiedEntry) => `${e.agent}@${e.version}`;

function entry(r: () => number): VerifiedEntry {
  const level = pick(r, ["interface", "real"] as const);
  return {
    agent: pick(r, ["claude", "codex"] as const),
    version: pick(r, VERSIONS),
    level,
    checkedAt: pick(r, DATES),
    os: pick(r, ["darwin-arm64", "linux-x64"]),
    osenVersion: "1.0.0",
    ...(level === "real" ? { modelCalls: 1 + Math.floor(r() * 3) } : {})
  };
}
// A valid record: unique pairs inside, so it can be a file; empty records included.
function record(r: () => number): VerifiedEntry[] {
  const seen = new Map<string, VerifiedEntry>();
  for (let n = Math.floor(r() * 5); n > 0; n--) {
    const e = entry(r);
    seen.set(key(e), e);
  }
  return [...seen.values()];
}

describe("Verified-versions record: merge invariant", () => {
  it("one entry per pair, never a lower level, order-independent unless level and date tie", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = mulberry32(seed);
      const a = record(r);
      const b = record(r);
      const ctx = `seed ${seed}`;
      const m = mergeRecords(a, b);
      expect(new Set(m.map(key)).size, ctx).toBe(m.length);
      expect(new Set(m.map(key)), ctx).toEqual(new Set([...a, ...b].map(key)));
      for (const e of m) {
        const inputs = [...a, ...b].filter((x) => key(x) === key(e));
        expect(rank(e), ctx).toBe(Math.max(...inputs.map(rank)));
        const swapped = mergeRecords(b, a).find((x) => key(x) === key(e))!;
        const top = inputs.filter((x) => rank(x) === rank(e)).map((x) => x.checkedAt).sort().pop()!;
        expect(e.checkedAt, ctx).toBe(top);
        expect(swapped.checkedAt, ctx).toBe(top);
        expect(rank(swapped), ctx).toBe(rank(e));
        const contenders = inputs.filter((x) => rank(x) === rank(e) && x.checkedAt === top);
        if (contenders.length === 1) expect(swapped, ctx).toEqual(e);
      }
      expect(mergeRecords(a, b).map(key), ctx).toEqual(mergeRecords(b, a).map(key));
    }
  });

  it("a rejected local file contributes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "verified-prop-"));
    try {
      for (let seed = 1; seed <= 60; seed++) {
        const r = mulberry32(seed);
        const entries: unknown[] = record(r);
        entries.push({ ...entry(r), level: "real", modelCalls: undefined, extra: seed });
        writeFileSync(join(dir, VERIFIED_FILE), JSON.stringify({ schemaVersion: 1, entries }));
        const loaded = loadVerifiedRecord(dir);
        expect(loaded.rejected, `seed ${seed}`).toBeDefined();
        expect(loaded.entries, `seed ${seed}`).toEqual(loadVerifiedRecord().entries);
        expect(loaded.entries, `seed ${seed}`).toEqual(mergeRecords(BUILTIN_RECORD, []));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
