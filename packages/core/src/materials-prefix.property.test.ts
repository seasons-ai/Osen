import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { folderPrefixes } from "./materials.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (s: string) => s.normalize("NFC").toLowerCase();
const POOL = ["Docs", "docs", "DOCS", "x", "x (2)", "x (3)", "café", "café", "CAFÉ", "proj"];
const SEEDS = 500;

function generate(seed: number): string[] {
  const rnd = mulberry32(seed);
  const n = 1 + Math.floor(rnd() * 8);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (out.length > 0 && rnd() < 0.2) out.push(out[Math.floor(rnd() * out.length)]!);
    else out.push(`/d${Math.floor(rnd() * 3)}/${POOL[Math.floor(rnd() * POOL.length)]}`);
  }
  return out;
}

describe("Distinguishable names of same-named folders", () => {
  it("folderPrefixes properties on random sets", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const folders = generate(seed);
      const got = folderPrefixes(folders);
      const distinct = [...new Set(folders)];
      const ctx = `seed ${seed}: ${JSON.stringify(folders)}`;
      expect(new Set(got.keys()), ctx).toEqual(new Set(distinct));
      const prefixes = distinct.map((f) => got.get(f)!);
      expect(new Set(prefixes.map(key)).size, ctx).toBe(prefixes.length);
      for (const p of prefixes) expect(p.includes("/") || p.startsWith("/"), ctx).toBe(false);
      const seen = new Set<string>();
      for (const f of distinct) {
        const k = key(basename(f));
        const unique = distinct.filter((o) => key(basename(o)) === k).length === 1;
        if (unique || !seen.has(k)) expect(got.get(f), ctx).toBe(basename(f));
        seen.add(k);
      }
    }
  });
});
