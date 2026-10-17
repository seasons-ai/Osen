import { describe, expect, it } from "vitest";
import { splitName } from "./session-ui.tsx";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Core rule (participantName in cli.ts, rosterNames in shared/setup.ts): model "default" without a suffix, a repeat — a tail " #N" after the brackets.
const build = (label: string, model: string, n: number) => `${label}${model === "default" ? "" : ` (${model})`}${n > 1 ? ` #${n}` : ""}`;
// Reverse build of the label "Name (model)" from two values.
const join = (bare: string, model: string) => {
  if (model === "default") return bare;
  const m = / #\d+$/.exec(bare);
  return m ? `${bare.slice(0, m.index)} (${model})${m[0]}` : `${bare} (${model})`;
};

const LABELS = ["Claude Code", "Codex", "OpenRouter", "Участник 1", "Агент (ru)", "Gemini CLI (beta)", "x"];
const MODELS = ["sonnet", "gpt-5.4-mini", "default", "", "qwen/qwen3:free", "gpt (beta)", "a b", "(", ")", "m) #2 (m"];

describe("parsing and building a participant name are mutual inverses", () => {
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))("seed %i", (seed) => {
    const rnd = mulberry32(seed);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    for (let k = 0; k < 50; k++) {
      const label = pick(LABELS), model = pick(MODELS), n = 1 + Math.floor(rnd() * 3);
      const name = build(label, model, n);
      const bare = `${label}${n > 1 ? ` #${n}` : ""}`;
      // A name built by the core: the model suffix is removed, the #N tail is kept, building returns the original name.
      expect(splitName(name, model), name).toEqual({ name: bare, model });
      expect(join(splitName(name, model).name, model), name).toBe(name);
      // A name without the suffix of the recorded model (set by the owner or the model replaced on continuation) — whole.
      const other = pick(MODELS.filter((m) => m !== model && m !== "default" && !name.includes(` (${m})`)));
      expect(splitName(name, other), `${name} / ${other}`).toEqual({ name, model: other });
      expect(splitName(bare, model === "default" ? "sonnet" : model).name, bare).toBe(bare);
    }
  });
});
