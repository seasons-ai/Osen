import { describe, expect, it } from "vitest";
import { parseVersion } from "./discovery.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent reference: the previous expression, used only on inputs whose digit runs stay short.
const oracle = (raw: string) => raw.match(/\d+\.\d+\.\d+/)?.[0];

const ALPHABET = "0019.....v -a\n١";
function generate(rand: () => number, length: number): string {
  let s = "";
  while (s.length < length) {
    const r = rand();
    if (r < 0.05) s += ["2.1.288", "0.159.2", "001.02.003", "1.2", "1..2.3", "9."][Math.floor(rand() * 6)];
    else s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return s.slice(0, length);
}

describe("Bounded CLI version extraction", () => {
  it("compatibility examples", () => {
    expect(parseVersion("2.1.288 (Claude Code)")).toBe("2.1.288");
    expect(parseVersion("codex-cli 0.159.2")).toBe("0.159.2");
    expect(parseVersion("v001.02.003 extra 4.5.6")).toBe("001.02.003");
    expect(parseVersion("")).toBeUndefined();
    expect(parseVersion("no version")).toBeUndefined();
  });

  it("boundary corpus matches the reference", () => {
    const corpus = [
      "1", "1.", "1.2", "1.2.", ".1.2.3", "1.2.3.", "1.2.3.4", "1..2.3.4", "a1.2.3b", "1.2.3-beta.4", "١.٢.٣", "1.2.٣",
      "9".repeat(64) + ".1.2", "9".repeat(64) + ".", "1." + "9".repeat(64) + ".3", "x.1.2.3", "1.2.\n3", "1 .2.3",
    ];
    for (const raw of corpus) expect(parseVersion(raw), JSON.stringify(raw)).toBe(oracle(raw));
  });

  it("generated inputs over 300 seeds and boundary lengths match the reference", () => {
    for (let seed = 1; seed <= 320; seed++) {
      const rand = mulberry32(seed);
      for (const length of [0, 1, 2, 3, Math.floor(rand() * 40), 1_024, 4_096, 16_384]) {
        const raw = generate(rand, length);
        expect(parseVersion(raw), `seed ${seed}, length ${length}`).toBe(oracle(raw));
      }
    }
  });

  it("long digit runs: no version without dots, the version after a run is still found", () => {
    for (const n of [0, 1, 2, 3, 1_024, 4_096, 16_384]) {
      const run = "9".repeat(n);
      expect(parseVersion(run)).toBeUndefined();
      expect(parseVersion(`${run}.`)).toBeUndefined();
      expect(parseVersion(`${run}.1.2`)).toBe(n ? `${run}.1.2` : undefined);
      expect(parseVersion(`${run} 2.1.288`)).toBe("2.1.288");
    }
  });
});
