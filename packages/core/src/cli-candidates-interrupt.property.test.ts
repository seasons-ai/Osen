import { describe, expect, it } from "vitest";
import { cliMessages } from "./messages/cli.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_SEED = 197000;
const ITERATIONS = 200;
const NOTHING = { en: "nothing was recorded", ru: "ничего не записано" } as const;

describe("cli candidates: the interruption names exactly the recorded pairs", () => {
  for (const lang of ["en", "ru"] as const) {
    it(`property (${lang}): every recorded pair is named, \"nothing recorded\" only for an empty list, no other version`, () => {
      for (let i = 0; i < ITERATIONS; i++) {
        const rnd = mulberry32(BASE_SEED + i);
        // a pool of distinct versions; the first k are recorded, the rest were never recorded
        const pool = [...new Set(Array.from({ length: 8 }, () => `${rnd() < 0.5 ? "claude" : "codex"} ${1 + Math.floor(rnd() * 3)}.${Math.floor(rnd() * 200)}.${Math.floor(rnd() * 400)}`))];
        const k = i === 0 ? 0 : Math.floor(rnd() * Math.min(6, pool.length));
        const recorded = pool.slice(0, k).map((p) => { const [agent, version] = p.split(" "); return { agent: agent!, version: version! }; });
        const text = cliMessages(lang).candidatesInterrupted(recorded);
        const seed = `seed ${BASE_SEED + i}: ${text}`;
        for (const r of recorded) expect(text, seed).toContain(`${r.agent} ${r.version}`);
        expect(text.includes(NOTHING[lang]), seed).toBe(k === 0);
        const named = [...text.matchAll(/\b(claude|codex) (\d+\.\d+\.\d+)\b/g)].map((m) => `${m[1]} ${m[2]}`);
        expect(new Set(named), seed).toEqual(new Set(pool.slice(0, k)));
      }
    });
  }
});
