import { describe, expect, it } from "vitest";
import { getProcessLanguage, setProcessLanguage } from "../i18n/process-language.ts";
import { CODEX_ISOLATION_FEATURES, REQUIRED_FLAGS, planLaunch } from "./args.ts";
import { checkCandidate } from "./candidates.ts";
import { declaredFlags, parseCodexFeatures } from "./flags.ts";
import { CLI_AGENTS, DEFAULT_MODEL } from "./types.ts";
import type { CliAgent } from "./types.ts";

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
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const shuffle = <T>(r: () => number, xs: readonly T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};
const subset = <T>(r: () => number, xs: readonly T[], keep: number): T[] => xs.filter(() => r() < keep);
const PROSE = ["Usage: tool [options]", "", "Run the thing quietly.", "      A description line mentioning --model but not declaring it.", "Options:", "  not-a-flag description", "\t--tabbed-text"];

interface Case { agent: CliAgent; help: string | undefined; features: string | undefined; declared: string[] }

function makeCase(seed: number): Case {
  const r = mulberry32(seed);
  const agent = pick(r, CLI_AGENTS);
  const mode = seed % 10; // explicit edge cases first
  const all = [...REQUIRED_FLAGS[agent], "--model", "--config"];
  const keep = mode === 0 ? 0 : mode === 1 ? 1 : 0.5 + r() * 0.5;
  const declared = [...subset(r, all, keep), ...Array.from({ length: Math.floor(r() * 4) }, (_, i) => `--foo-${i}`)];
  const lines: string[] = declared.map((f) => `  ${f} <value>\n          Description of ${f}.`);
  for (let i = Math.floor(r() * 5); i > 0; i--) lines.push(pick(r, PROSE));
  const help = mode === 2 ? "" : r() < 0.05 ? undefined : shuffle(r, lines).join("\n");
  let features: string | undefined;
  if (agent === "codex") {
    const fk = mode === 3 ? 0 : mode === 4 ? 1 : 0.6 + r() * 0.4;
    const present = subset(r, CODEX_ISOLATION_FEATURES, fk);
    const rows = [
      ...present.map((n) => `${n.padEnd(30)} stable             ${r() < 0.5}`),
      ...(r() < 0.3 && present.length ? [`${pick(r, present).padEnd(30)} removed            false`] : []), // a removed row must not count
      ...Array.from({ length: Math.floor(r() * 3) }, (_, i) => `unknown_feature_${i}`.padEnd(30) + " experimental       false"),
    ];
    // A "removed" row of a capability that is otherwise absent hides it: never add one for a present name.
    features = r() < 0.08 ? undefined : shuffle(r, rows.filter((row, _i, a) => !row.includes(" removed ") || !a.some((o) => o !== row && o.startsWith(row.split(" ")[0]!)))).join("\n");
  }
  return { agent, help, features, declared };
}

const oracle = (c: Case, version: string): boolean => {
  if (c.help === undefined) return false;
  const flags = declaredFlags(c.help);
  const features = c.features === undefined ? undefined : parseCodexFeatures(c.features);
  const plan = planLaunch({ agent: c.agent, flags, version, model: DEFAULT_MODEL, language: getProcessLanguage(), features, pinned: true });
  return plan.ok && flags.has("--model");
};

describe("Проверка кандидата по возможностям: random help and features", () => {
  it("violations are empty exactly when planLaunch(pinned) accepts and --model is declared", () => {
    setProcessLanguage("en");
    let empty = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const c = makeCase(seed);
      const { violations } = checkCandidate({ agent: c.agent, versionOutput: "1.2.3", help: c.help, features: c.features });
      const accepted = oracle(c, "1.2.3");
      expect(violations.length === 0, `seed ${seed}`).toBe(accepted);
      if (accepted) empty++;
    }
    expect(empty).toBeGreaterThan(10); // the generator reaches both outcomes
    expect(empty).toBeLessThan(SEEDS - 10);
  });

  it("line order and unrelated lines do not change the violations set", () => {
    setProcessLanguage("en");
    for (let seed = 1; seed <= SEEDS; seed++) {
      const c = makeCase(seed);
      if (c.help === undefined) continue;
      const r = mulberry32(seed + 10_000);
      const lines = c.help.split("\n");
      const noisy = shuffle(r, [...lines, ...Array.from({ length: 5 }, () => pick(r, PROSE.filter((p) => !p.startsWith("\t")))), "", ""]);
      const norm = (help: string) => checkCandidate({ agent: c.agent, versionOutput: "1.2.3", help, features: c.features }).violations.map((v) => `${v.code}:${v.name}`).sort();
      expect(norm(noisy.join("\n")), `seed ${seed}`).toEqual(norm(c.help));
    }
  });

  it("no violations means a parsed version; an unparsed version is always named", () => {
    setProcessLanguage("en");
    for (let seed = 1; seed <= 50; seed++) {
      const c = makeCase(seed);
      const { violations, version } = checkCandidate({ agent: c.agent, versionOutput: "no number here", help: c.help, features: c.features });
      expect(version).toBeUndefined();
      expect(violations).toContainEqual({ code: "version_unparsed", name: "--version" });
    }
  });
});
