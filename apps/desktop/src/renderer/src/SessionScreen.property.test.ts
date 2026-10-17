import { describe, expect, it } from "vitest";
import { noStop, stopFlags, stopMarks } from "./SessionScreen.tsx";
import type { StopMarks } from "./SessionScreen.tsx";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// confirm with ends — confirmed stop, after which the finish event arrived; finish — the session ended on its own.
type Step = { type: "ask" | "cancel" | "ok" | "failed" | "finish" | "resume" } | { type: "confirm"; ends: boolean };

function generate(seed: number): Step[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const out: Step[] = [];
  let running = true;
  for (let i = 0, len = 5 + Math.floor(rnd() * 40); i < len; i++) {
    // More often drive to the stop → continue cycle, including with the confirmation open.
    const type = rnd() < 0.3 ? (running ? pick(["confirm", "ask"] as const) : "resume")
      : pick(running ? (["ask", "cancel", "confirm", "ok", "failed", "finish"] as const) : (["resume", "ok", "failed"] as const));
    const step: Step = type === "confirm" ? { type, ends: rnd() < 0.5 } : { type };
    if (step.type === "finish" || (step.type === "confirm" && step.ends)) running = false;
    if (step.type === "resume") running = true;
    out.push(step);
  }
  return out;
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe("session stop: property", () => {
  it.each(SEEDS)("seed %i: button inactive if and only if stop is requested in the current segment and not rejected; confirmation — only one open in the current", (seed) => {
    let marks: StopMarks = noStop;
    let segment = 0, confirmOpen = false, stopIn: number | null = null;
    const requests: number[] = []; // spans of stopSession requests that have not yet received a response
    for (const step of generate(seed)) {
      switch (step.type) {
        case "ask": marks = stopMarks(marks, { type: "ask", segment }); confirmOpen = true; break;
        case "cancel": marks = stopMarks(marks, { type: "cancel", segment }); confirmOpen = false; break;
        case "confirm": marks = stopMarks(marks, { type: "confirm", segment }); confirmOpen = false; requests.push(segment); stopIn = segment; break;
        case "ok": requests.shift(); break; // success switches nothing
        case "failed": {
          const seg = requests.shift();
          if (seg === undefined) break;
          marks = stopMarks(marks, { type: "failed", segment: seg });
          if (stopIn === seg) stopIn = null;
          break;
        }
        case "finish": break; // the confirmation could have stayed open
        case "resume": segment++; confirmOpen = false; break;
      }
      expect(stopFlags(marks, segment)).toEqual({ stopping: stopIn === segment, confirming: confirmOpen });
    }
  });
  it("generator reaches two or more cycles of stop → continue, and continue while the confirmation is open", () => {
    let multi = 0, openResume = 0;
    for (const seed of SEEDS) {
      let open = false, resumes = 0;
      for (const s of generate(seed)) {
        if (s.type === "ask") open = true;
        if (s.type === "cancel" || s.type === "confirm") open = false;
        if (s.type === "resume") { if (open) openResume++; resumes++; open = false; }
      }
      if (resumes >= 2) multi++;
    }
    expect(multi).toBeGreaterThan(50);
    expect(openResume).toBeGreaterThan(20);
  });
});
