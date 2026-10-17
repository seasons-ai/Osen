import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODEX_ISOLATION_FEATURES, planLaunch } from "./args.ts";
import { declaredFlags, parseCodexFeatures } from "./flags.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const helpFlags = [...declaredFlags(fx("codex-0.159.2-exec-help.txt"))];
const listed = [...parseCodexFeatures(fx("codex-0.159.2-features.txt"))];
// Flags without which Codex isolation is not confirmed; the list is set by the requirement, not taken from args.ts.
const REQUIRED = ["--sandbox", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json", "--disable"];

describe("Confirmed flags: Codex isolation (property, 500 cases)", () => {
  it("ok ⇔ all required flags declared and the list contains all isolation capabilities; with ok — --disable for each", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rnd = mulberry32(seed);
      const pick = <T>(xs: readonly T[], p: number) => xs.filter(() => rnd() >= p);
      // Help flags: often the full help, otherwise a random subset.
      const flags = new Set(rnd() < 0.4 ? helpFlags : pick(helpFlags, rnd() * 0.3));
      // List: unread, empty, full, full with extra names, a random subset.
      const kind = Math.floor(rnd() * 5);
      const features = kind === 0 ? undefined
        : kind === 1 ? new Set<string>()
        : kind === 2 ? new Set(listed)
        : kind === 3 ? new Set([...listed, "extra_a", "extra_b"])
        : new Set(pick(listed, rnd() * 0.2));
      const model = rnd() < 0.5 ? "default" : "gpt-x";
      const schema = rnd() < 0.5 ? { json: "{}", file: "/tmp/s.json" } : undefined;
      const p = planLaunch({ agent: "codex", flags, version: "0.159.2", model, language: "ru", features, ...(schema ? { schema } : {}) });
      const expected = REQUIRED.every((f) => flags.has(f))
        && features !== undefined && CODEX_ISOLATION_FEATURES.every((f) => features.has(f))
        && (model === "default" || flags.has("--model"));
      expect(p.ok, `seed ${seed}`).toBe(expected);
      if (p.ok) {
        for (const f of CODEX_ISOLATION_FEATURES) {
          const i = p.args.findIndex((a, j) => a === f && p.args[j - 1] === "--disable");
          expect(i, `seed ${seed}: ${f}`).toBeGreaterThan(0);
        }
        expect(p.args.slice(1, 3), `seed ${seed}`).toEqual(["--sandbox", "read-only"]);
      } else expect(p.reason.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });
});
