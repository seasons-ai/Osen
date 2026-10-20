import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { ACCEPTANCE_CALL_BOUND, PROBES, runAcceptance } from "./acceptance.ts";
import type { AcceptancePlan, ProbeId, ProbeOutcome, ProbeRunner } from "./acceptance.ts";

// Seeded PRNG (mulberry32): the same seed gives the same cases on every run; no fast-check.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = "pass" | "fail" | "error" | "limit";
interface Step { kind: Kind; calls: number }

const CASES = 400;
const SEED = 181;
const NOW = new Date("2026-10-20T12:00:00Z");

// Edge cases first, then random ones. Passing probes spend at least one call: a real pass always does.
function generate(rand: () => number, index: number): Step[] {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const callsFor = (kind: Kind): number => (kind === "pass" ? (rand() < 0.8 ? 1 : 2) : pick([0, 1, 2]));
  const kindFor = (): Kind => (rand() < 0.7 ? "pass" : pick<Kind>(["fail", "error", "limit"]));
  const steps: Step[] = PROBES.map(() => {
    const kind = kindFor();
    return { kind, calls: callsFor(kind) };
  });
  if (index === 0) return steps.map((_, i) => (i === 0 ? { kind: "fail", calls: 1 } : { kind: "pass", calls: 1 }));
  if (index === 1) return steps.map((_, i) => ({ kind: i === PROBES.length - 1 ? "limit" : "pass", calls: 1 }));
  if (index === 2) return steps.map(() => ({ kind: "pass", calls: 1 }));
  if (index === 3) return steps.map((_, i) => ({ kind: "pass", calls: i === 3 ? 2 : 1 })); // all pass, total 8
  return steps;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  setProcessLanguage("en");
});

const plan = (): AcceptancePlan => ({
  agent: "codex", version: "0.159.2", path: "/nonexistent/codex", sha256: "b".repeat(64),
  configDir: "/nonexistent/config", model: "default", probes: PROBES, bound: ACCEPTANCE_CALL_BOUND,
});

describe("Requirement «Результат приёмки и запись real» (acceptance result and the real record)", () => {
  it(`writes real iff all ${PROBES.length} probes pass and calls <= the bound, over ${CASES} seeded cases`, async () => {
    setProcessLanguage("en");
    const rand = mulberry32(SEED);
    let recorded = 0;
    let overshootCases = 0;
    for (let index = 0; index < CASES; index++) {
      const dir = mkdtempSync(join(tmpdir(), "accept-prop-"));
      roots.push(dir);
      const script = generate(rand, index);
      const invoked: number[] = [];
      const runner: ProbeRunner = async (probe: ProbeId) => {
        const i = PROBES.indexOf(probe);
        invoked.push(i);
        const s = script[i]!;
        if (s.kind === "error") throw new Error(`boom ${index}`);
        if (s.kind === "pass") return { ok: true, calls: s.calls, raw: undefined };
        return { ok: false, reason: s.kind === "limit" ? "limit reached" : `fail ${i}`, calls: s.calls };
      };
      const seen: ProbeOutcome[] = [];
      const out = await runAcceptance(dir, plan(), {
        env: {}, language: "en", now: () => NOW, osenVersion: "0.9.0", onProbe: (o) => seen.push(o),
      }, { runProbe: runner, inspect: async () => ({ flags: new Set() }) });

      const firstFail = script.findIndex((s) => s.kind !== "pass");
      const total = script.reduce((sum, s) => sum + s.calls, 0);
      const allPass = firstFail === -1;
      const expectRecord = allPass && total <= ACCEPTANCE_CALL_BOUND;
      if (allPass && total > ACCEPTANCE_CALL_BOUND) overshootCases++;

      // the runner is never invoked after the first failing probe
      const lastAllowed = firstFail === -1 ? PROBES.length - 1 : firstFail;
      expect(invoked.every((i) => i <= lastAllowed), `case ${index}`).toBe(true);
      expect(invoked).toEqual(invoked.map((_, k) => k)); // a prefix of the list

      // the record exists exactly when all pass and the total is within the bound
      const file = join(dir, "cli-verified.json");
      expect(existsSync(file), `case ${index}`).toBe(expectRecord);
      expect(out.recorded, `case ${index}`).toBe(expectRecord);
      if (expectRecord) {
        recorded++;
        const entries = JSON.parse(readFileSync(file, "utf8")).entries;
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ level: "real", modelCalls: out.calls });
        expect(out.code, `case ${index}`).toBe(0);
      } else {
        expect(out.code, `case ${index}`).toBe(out.interrupted ? 1 : 5);
      }

      // a recorded run never reports more calls than the bound; an overshoot is a failed probe that names the bound
      if (expectRecord) expect(out.calls, `case ${index}`).toBeLessThanOrEqual(ACCEPTANCE_CALL_BOUND);
      if (allPass && !expectRecord) expect(seen.at(-1)?.reason ?? "", `case ${index}`).toContain("upper bound");
      if (!allPass) expect(seen.at(-1)?.ok, `case ${index}`).toBe(false);
    }
    // the generator covers both outcomes and the forced overshoot case
    expect(recorded).toBeGreaterThan(0);
    expect(recorded).toBeLessThan(CASES);
    expect(overshootCases).toBeGreaterThan(0);
  }, 120_000);
});
