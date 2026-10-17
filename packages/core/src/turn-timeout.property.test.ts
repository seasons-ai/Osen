import { describe, expect, it } from "vitest";
import { createSession, turnTimerMs } from "./engine.ts";
import { MAX_TURN_TIMEOUT_SEC } from "./protocol/schema.ts";
import { RegistrySchema } from "./registry/config.ts";
import { TemplateSchema } from "./templates/schema.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOUNDARY = [0, 1, 2147482, 2147483, 2147484, 5000000, Number.MAX_SAFE_INTEGER];
const SEEDS = 300;
const values = (): number[] => {
  const out = [...BOUNDARY];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = mulberry32(seed);
    out.push(Math.floor(r() * (seed % 2 ? 4294967296 : MAX_TURN_TIMEOUT_SEC + 5)));
  }
  return out;
};

const part = { name: "n", providerId: "scripted", model: "m", role: null };
const sessionOk = (n: number) => {
  try {
    createSession({ topic: "Т", framing: "", origin: "cli", limits: { maxRounds: 3, turnTimeoutSec: n, contextChars: 1000 }, participants: [part, part] }, { maxParticipants: 8 });
    return true;
  } catch {
    return false;
  }
};
const registryOk = (n: number) =>
  RegistrySchema.safeParse({ providers: [], defaults: { maxRounds: 1, turnTimeoutSec: n, contextChars: 1, maxParticipants: 2, participants: [] } }).success;
const templateOk = (n: number) =>
  TemplateSchema.safeParse({ id: "a", title: "T", category: "c", description: "d", exampleTopic: "e", framing: "f", limits: { turnTimeoutSec: n } }).success;

describe("Session composition: turnTimeoutSec", () => {
  it("createSession, config.json and the template accept n if and only if 1 ≤ n ≤ MAX", () => {
    for (const n of values()) {
      const want = n >= 1 && n <= MAX_TURN_TIMEOUT_SEC;
      expect(sessionOk(n), `session ${n}`).toBe(want);
      expect(registryOk(n), `registry ${n}`).toBe(want);
      expect(templateOk(n), `template ${n}`).toBe(want);
    }
  });

  it("turnTimerMs(n) for n ≥ 1 is in [1000, 2147483647] and equals n * 1000 when n ≤ MAX", () => {
    for (const n of values().filter((v) => v >= 1)) {
      const ms = turnTimerMs(n);
      expect(ms, `n ${n}`).toBeGreaterThanOrEqual(1000);
      expect(ms, `n ${n}`).toBeLessThanOrEqual(2147483647);
      if (n <= MAX_TURN_TIMEOUT_SEC) expect(ms, `n ${n}`).toBe(n * 1000);
    }
  });
});
