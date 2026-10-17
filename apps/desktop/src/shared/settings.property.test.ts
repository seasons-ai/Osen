import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { DEFAULTS_BOUNDS, checkDefaults, checkProviderInput } from "./settings.ts";
import type { DefaultsValues, ProviderInput } from "./settings.ts";

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
const IDS = ["a", "b"];
const NUM_KEYS = ["maxRounds", "turnTimeoutSec", "contextChars", "materialsChars", "maxParticipants"] as const;

const gen = (rnd: () => number) => {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const input = (): ProviderInput => ({
    id: null,
    label: pick(["", "   ", "x", "Локальный"]),
    baseUrl: pick(["", "   ", "ftp://x", "не адрес", "http://a", "https://a.example/v1", " http://a "]),
    apiKeyEnv: pick(["", "KEY", "_K1", "1K", "k", "A B"]),
  });
  const num = (key: (typeof NUM_KEYS)[number]) => {
    const { min, max } = DEFAULTS_BOUNDS[key];
    return pick([min - 1, min, Math.floor((min + max) / 2), max, max + 1, 1.5, NaN]);
  };
  const entry = () => ({ providerId: pick(["a", "b", "ghost"]), model: pick(["", "  ", "m"]) });
  const defaults = (): DefaultsValues => {
    const v: DefaultsValues = {
      maxRounds: 0, turnTimeoutSec: 0, contextChars: 0, materialsChars: 0, maxParticipants: 0,
      maxTotalTokens: pick([null, 0, 1, 1.5, -1, 5000, Number.MAX_SAFE_INTEGER + 2]),
      participants: Array.from({ length: Math.floor(rnd() * 10) }, entry),
    };
    for (const k of NUM_KEYS) v[k] = num(k);
    if (rnd() < 0.3) {
      // start from a valid value and corrupt one field
      Object.assign(v, { maxRounds: 3, turnTimeoutSec: 120, contextChars: 50_000, materialsChars: 60_000, maxParticipants: 4, maxTotalTokens: null, participants: [{ providerId: "a", model: "m" }, { providerId: "b", model: "m" }] });
      const w = defaults0(rnd);
      const k = pick([...NUM_KEYS, "maxTotalTokens", "participants"] as const);
      (v as unknown as Record<string, unknown>)[k] = (w as unknown as Record<string, unknown>)[k];
    }
    return v;
  };
  return { input, defaults };
};
// a second source of random values for corrupting a field, without recursion of the 30% branch
const defaults0 = (rnd: () => number): DefaultsValues => {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const v = { maxTotalTokens: pick([null, 0, 1, 1.5, -1, 5000, Number.MAX_SAFE_INTEGER + 2]), participants: Array.from({ length: Math.floor(rnd() * 10) }, () => ({ providerId: pick(["a", "b", "ghost"]), model: pick(["", "  ", "m"]) })) } as DefaultsValues;
  for (const k of NUM_KEYS) { const { min, max } = DEFAULTS_BOUNDS[k]; v[k] = pick([min - 1, min, Math.floor((min + max) / 2), max, max + 1, 1.5, NaN]); }
  return v;
};

const nulls = (e: object) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v === null]));

describe("Settings screen: main process refusals in the selected language", () => {
  afterEach(() => setProcessLanguage("ru"));

  it("Settings screen: main process refusals in the selected language — refusal conditions do not depend on the language", () => {
    const seenFail = new Set<string>();
    const seenOk = { provider: false, defaults: false };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const g = gen(mulberry32(seed));
      const pi = g.input();
      const dv = g.defaults();
      const run = () => ({ p: checkProviderInput(pi), d: checkDefaults(dv, IDS) });
      setProcessLanguage("en");
      const en = run();
      setProcessLanguage("ru");
      const ru = run();
      for (const key of ["p", "d"] as const) {
        const a = en[key] as unknown as Record<string, string | null>;
        const b = ru[key] as unknown as Record<string, string | null>;
        expect(nulls(a), `seed ${seed} ${key}`).toEqual(nulls(b));
        for (const k of Object.keys(a)) {
          if (a[k] !== null) {
            expect(a[k], `seed ${seed} ${key}.${k}`).not.toBe(b[k]);
            seenFail.add(`${key}.${k}`);
          }
        }
        if (Object.values(a).every((v) => v === null)) seenOk[key === "p" ? "provider" : "defaults"] = true;
      }
    }
    expect([...seenFail].sort()).toEqual([
      "d.contextChars", "d.maxParticipants", "d.maxRounds", "d.maxTotalTokens", "d.materialsChars", "d.participants", "d.turnTimeoutSec",
      "p.apiKeyEnv", "p.baseUrl", "p.label",
    ].sort());
    expect(seenOk).toEqual({ provider: true, defaults: true });
  });
});
