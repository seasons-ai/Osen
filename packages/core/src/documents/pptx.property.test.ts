import { describe, expect, it } from "vitest";
import { extractDocument } from "./detect.ts";
import { DOC_LIMITS } from "./extract.ts";
import { makePptx, sp } from "./fixture.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = 300;
const MAX_SLIDES = 8;

describe("PPTX text: slide order", () => {
  it("any permutation of the slide files gives the presentation order and numbering", () => {
    let sawOne = false, sawMax = false, sawMoved = false;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = mulberry32(seed);
      const n = seed === 1 ? 1 : seed === 2 ? MAX_SLIDES : 1 + Math.floor(rnd() * MAX_SLIDES);
      const order = Array.from({ length: n }, (_, i) => i + 1);
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
      if (n === 1) sawOne = true;
      if (n === MAX_SLIDES) sawMax = true;
      if (order.some((f, i) => f !== i + 1)) sawMoved = true;
      const slides = Array.from({ length: n }, (_, i) => ({ shapes: sp([`text ${seed}-${i}`]) }));
      const r = extractDocument(makePptx({ slides, fileOrder: order }), DOC_LIMITS);
      const want = slides.map((_, i) => `# ${i + 1}\ntext ${seed}-${i}`).join("\n\n");
      expect(r, `seed ${seed}`).toEqual({ ok: true, text: want, format: "pptx" });
    }
    expect({ sawOne, sawMax, sawMoved }).toEqual({ sawOne: true, sawMax: true, sawMoved: true });
  });
});
