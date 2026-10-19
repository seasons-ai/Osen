import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LightTheme, ThemeMode } from "../shared/bridge.ts";
import { APPEARANCE_FILE, AppearanceRejectedError, createAppearanceState, readAppearance } from "./appearance.ts";

// Own seeded generator: fast-check is not a dependency of this repository.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const MODES: ThemeMode[] = ["dark", "light", "system"];
const LIGHTS: LightTheme[] = ["tuman", "len", "inei", "pergament"];
const BAD_MODES = ["blue", "", "DARK", 1, null];
const BAD_LIGHTS = ["osen", "sakura", 0, null];
const BAD_INPUTS = [null, [], "light", 7];

type Step = { kind: "set"; input: unknown } | { kind: "lock" } | { kind: "unlock" };

function genSteps(rnd: () => number): Step[] {
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const n = Math.floor(rnd() * 31);
  return Array.from({ length: n }, (): Step => {
    switch (Math.floor(rnd() * 8)) {
      case 0: return { kind: "set", input: { mode: pick(MODES) } };
      case 1: return { kind: "set", input: { lightTheme: pick(LIGHTS) } };
      case 2: return { kind: "set", input: { mode: pick(MODES), lightTheme: pick(LIGHTS) } };
      case 3: return { kind: "set", input: { mode: pick(BAD_MODES) } };
      case 4: return { kind: "set", input: { lightTheme: pick(BAD_LIGHTS) } };
      case 5: return { kind: "set", input: pick(BAD_INPUTS) };
      case 6: return { kind: "lock" };
      default: return { kind: "unlock" };
    }
  });
}

function run(steps: Step[]): void {
  const dataDir = mkdtempSync(join(tmpdir(), "appearance-prop-"));
  const file = join(dataDir, APPEARANCE_FILE);
  try {
    const state = createAppearanceState({ dataDir, systemDark: () => false, send: () => {}, logger: { info: () => {}, error: () => {} } });
    let model = { mode: "dark" as ThemeMode, lightTheme: "tuman" as LightTheme };
    let locked = false;
    for (const s of steps) {
      if (s.kind === "lock") { if (existsSync(file)) { chmodSync(file, 0o444); locked = true; } continue; }
      if (s.kind === "unlock") { if (existsSync(file)) chmodSync(file, 0o644); locked = false; continue; }
      const input = s.input as Record<string, unknown> | null;
      const valid = typeof input === "object" && input !== null && !Array.isArray(input)
        && (input.mode === undefined || MODES.includes(input.mode as ThemeMode))
        && (input.lightTheme === undefined || LIGHTS.includes(input.lightTheme as LightTheme));
      if (valid && !locked) {
        const before = model.lightTheme;
        const v = state.set(input);
        model = { mode: (input.mode as ThemeMode | undefined) ?? model.mode, lightTheme: (input.lightTheme as LightTheme | undefined) ?? model.lightTheme };
        if (input.lightTheme === undefined) expect(v.lightTheme).toBe(before);
      } else {
        expect(() => state.set(input)).toThrow(AppearanceRejectedError);
      }
      expect(state.view()).toMatchObject(model);
      if (existsSync(file)) expect(readAppearance(dataDir)).toEqual({ ...model, warning: null });
    }
  } finally {
    try { chmodSync(file, 0o644); } catch { /* no file */ }
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("Хранение выбора темы: property", () => {
  it("Хранение выбора темы: the stored choice equals the last accepted one", () => {
    if (process.getuid?.() === 0) return;
    for (let seed = 1; seed <= 100; seed++) run(genSteps(mulberry32(seed)));
  });
});
