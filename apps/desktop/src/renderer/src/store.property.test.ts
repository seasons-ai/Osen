import { describe, expect, it } from "vitest";
import type { RerunView } from "../../shared/setup.ts";
import { initialUi, reduce } from "./store.ts";
import type { UiAction, UiState } from "./store.ts";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const view: RerunView = {
  sessionId: "s1", date: "2026-10-07", topic: "Тема", templateId: null, framingFromSession: false,
  participants: [], maxRounds: 3, ownerWait: null,
  materials: { items: [], skipped: [], left: [], folder: null, ignored: [], error: null, chars: 0, limit: 100, over: 0, stamp: "s" },
};
const nav = (section: "new" | "settings" | "history"): UiAction => ({ type: "navigate", section });
const KEEP: UiAction[] = [nav("new"), nav("settings")];
const DROP: UiAction[] = [
  nav("history"), { type: "started", id: "s9" }, { type: "open", id: "s9" },
  { type: "bridge", event: { type: "open-result", id: "s9" } }, { type: "bridge", event: { type: "open-session", id: "s9" } },
];
const ALL: UiAction[] = [...KEEP, ...DROP, { type: "rerun", view }];
const run = (s: UiState, ...a: UiAction[]) => a.reduce(reduce, s);
const pick = <T,>(rnd: () => number, xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;

describe("session setup survives going to «Settings»", () => {
  it("after rerun any new/settings chain keeps the rerun and setupKept", () => {
    const rnd = mulberry32(106);
    for (let i = 0; i < 500; i++) {
      const tail = Array.from({ length: Math.floor(rnd() * 8) }, () => pick(rnd, KEEP));
      const s = run(initialUi(), nav("history"), { type: "rerun", view }, ...tail);
      expect(s.rerun).toBe(view);
      expect(s.setupKept).toBe(true);
    }
  });

  it("after navigate(new) a new/settings chain holds setupKept", () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 300; i++) {
      const s = run(initialUi(), nav("new"), ...Array.from({ length: Math.floor(rnd() * 8) }, () => pick(rnd, KEEP)));
      expect(s.setupKept).toBe(true);
      expect(s.rerun).toBeNull();
    }
  });

  it("started, open, open-result, open-session, navigate(history) reset everything before them", () => {
    const rnd = mulberry32(2026);
    for (let i = 0; i < 500; i++) {
      const before = Array.from({ length: Math.floor(rnd() * 8) }, () => pick(rnd, ALL));
      const s = run(initialUi(), ...before, { type: "rerun", view }, ...Array.from({ length: Math.floor(rnd() * 4) }, () => pick(rnd, KEEP)), pick(rnd, DROP));
      expect(s.rerun).toBeNull();
      expect(s.setupKept).toBe(false);
    }
  });

  it("arbitrary sequence: setupKept/rerun are determined by the last resetting or enabling action", () => {
    const rnd = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const seq = Array.from({ length: Math.floor(rnd() * 12) }, () => pick(rnd, ALL));
      let kept = false, rerun = false;
      for (const a of seq) {
        if (a.type === "rerun") { kept = true; rerun = true; }
        else if (a.type === "navigate" && a.section === "new") kept = true;
        else if (a.type === "navigate" && a.section === "settings") { /* без изменений */ }
        else { kept = false; rerun = false; }
      }
      const s = run(initialUi(), ...seq);
      expect(s.setupKept).toBe(kept);
      expect(s.rerun !== null).toBe(rerun);
    }
  });

  it("bounds: empty chain, only settings, rerun right after history, repeated navigate(new)", () => {
    expect(run(initialUi()).setupKept).toBe(false);
    expect(run(initialUi(), nav("settings")).setupKept).toBe(false);
    const r = run(initialUi(), nav("history"), { type: "rerun", view });
    expect(r.rerun).toBe(view);
    expect(run(r, nav("new"), nav("new"), nav("new")).rerun).toBe(view);
    expect(run(initialUi(), nav("new"), nav("new")).setupKept).toBe(true);
  });
});
