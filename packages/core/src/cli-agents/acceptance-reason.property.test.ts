import { describe, expect, it } from "vitest";
import { describeOutputError, OutputError } from "./process.ts";
import type { OutputFailure } from "./process.ts";

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

const ENGLISH = ["exited with", "no answer within", "output is larger", "on signal", "bytes"];
const CASES = 500;

const START: OutputFailure[] = [
  { code: "exit", command: "/bin/x --help", exitCode: 3, signal: null, stderr: "" },
  { code: "exit", command: "/bin/x --help", exitCode: 1, signal: null, stderr: "ошибка ✓\nвторая строка" },
  { code: "exit", command: "/bin/x", exitCode: null, signal: "SIGTERM", stderr: "boom" },
  { code: "timeout", ms: 0 },
  { code: "timeout", ms: 1 },
  { code: "too_large", maxBytes: 0 },
  { code: "too_large", maxBytes: 1 },
  { code: "too_large", maxBytes: 4 * 1024 * 1024 },
];

function generate(rand: () => number, index: number): OutputFailure {
  if (index < START.length) return START[index]!;
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const stderr = pick(["", "boom", "  padded  \n", "строка\nещё", "a: b; c", "💥 emoji"]);
  const kind = pick(["too_large", "timeout", "exit"] as const);
  if (kind === "too_large") return { code: "too_large", maxBytes: pick([0, 1, 63, 64, 65, 1024, Math.floor(rand() * 1e9)]) };
  if (kind === "timeout") return { code: "timeout", ms: pick([0, 1, 300, 10_000, Math.floor(rand() * 1e7)]) };
  const bySignal = rand() < 0.5;
  return { code: "exit", command: `/p/${Math.floor(rand() * 1e6)} --help`, exitCode: bySignal ? null : Math.floor(rand() * 256), signal: bySignal ? pick(["SIGTERM", "SIGKILL", "SIGHUP"]) : null, stderr };
}

describe("Сообщения ядра на выбранном языке: причина сбоя чтения вывода CLI", () => {
  it("ru has no English frame; en and ru carry the same substituted values", () => {
    const rand = mulberry32(207);
    for (let i = 0; i < CASES; i++) {
      const f = generate(rand, i);
      const ru = describeOutputError(new OutputError(f, "x"), "ru");
      const en = describeOutputError(new OutputError(f, "x"), "en");
      const ctx = JSON.stringify(f);
      for (const word of ENGLISH) expect(ru, ctx).not.toContain(word);
      expect(ru, ctx).toMatch(/вывод больше|нет ответа за|завершился (с кодом|по сигналу)/);
      const values: string[] = f.code === "too_large" ? [String(f.maxBytes)] : f.code === "timeout" ? [String(f.ms)] : [f.command, String(f.exitCode ?? f.signal)];
      for (const v of values) { expect(ru, ctx).toContain(v); expect(en, ctx).toContain(v); }
      if (f.code === "exit" && f.stderr.trim()) {
        expect(ru, ctx).toContain(f.stderr.trim());
        expect(en, ctx).toContain(f.stderr.trim());
      }
      if (f.code === "exit" && !f.stderr.trim()) {
        expect(ru, ctx).not.toMatch(/:\s*$/);
        expect(en, ctx).not.toMatch(/:\s*$/);
      }
    }
  });
  it("a foreign error keeps its message, a non-error is stringified", () => {
    expect(describeOutputError(new Error("spawn ENOENT"), "ru")).toBe("spawn ENOENT");
    expect(describeOutputError("plain", "ru")).toBe("plain");
  });
});
