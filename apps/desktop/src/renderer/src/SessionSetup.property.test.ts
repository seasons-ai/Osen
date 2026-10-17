import { describe, expect, it } from "vitest";
import { clipReason, startEnabled } from "./SessionSetup.tsx";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHABET = ["a", "к", " ", "😀", "𝔸", "…", "é"]; // two surrogate pairs, an ellipsis in the reason itself
const lone = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("Unavailable provider: trimming the reason in the variant label", () => {
  it("for any reason of 0–120 code points: no longer than 61, whole up to 60, otherwise a 60 prefix and «…», without lone surrogates", () => {
    const rnd = mulberry32(101);
    const lengths = [0, 1, 59, 60, 61, 62, 120];
    for (let i = 0; i < 2000; i++) {
      const n = i < lengths.length * 20 ? lengths[i % lengths.length]! : Math.floor(rnd() * 121);
      const reason = Array.from({ length: n }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)]!).join("");
      const out = clipReason(reason);
      const points = Array.from(out);
      expect(lone(out)).toBe(false);
      if (n <= 60) expect(out).toBe(reason);
      else {
        expect(points).toHaveLength(61);
        expect(points[60]).toBe("…");
        expect(points.slice(0, 60).join("")).toBe(Array.from(reason).slice(0, 60).join(""));
      }
    }
  });
});

// Requirement «Material limit exceeded»: over is part of canStart (setup.ts), so over=true is checked as canStart=false.
describe("Material limit exceeded: availability of «Start»", () => {
  it("for any flags: available if and only if none of the busy flags is set and canStart", () => {
    const rnd = mulberry32(106);
    const b = () => rnd() < 0.5;
    const cases = Array.from({ length: 300 }, () => ({ canStart: b(), starting: b(), urlPending: b() ? "https://x.y/" + Math.floor(rnd() * 1000) : null, materialsBusy: b(), previewBusy: b() }));
    const off = { canStart: true, starting: false, urlPending: null, materialsBusy: false, previewBusy: false };
    cases.push(off, { ...off, canStart: false }, { ...off, starting: true }, { ...off, urlPending: "u" }, { ...off, materialsBusy: true }, { ...off, previewBusy: true });
    for (const c of cases) {
      expect(startEnabled(c), JSON.stringify(c)).toBe(c.canStart && !c.starting && c.urlPending === null && !c.materialsBusy && !c.previewBusy);
    }
  });
});
