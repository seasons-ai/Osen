import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { installPin, rollbackPin, usePin, readPins, type PackageSource } from "./pins.ts";
import type { VerifiedEntry, VerifiedRecord } from "./verified-record.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = 200;
const real = (version: string): VerifiedEntry => ({ agent: "claude", version, level: "real", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 1 });
const iface = (version: string): VerifiedEntry => ({ agent: "claude", version, level: "interface", checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0" });
const record: VerifiedRecord = { entries: [real("1.0.0"), real("1.1.0"), real("1.2.0"), iface("2.0.0"), iface("2.1.0")] };
const VERSIONS = ["1.0.0", "1.1.0", "1.2.0", "2.0.0", "2.1.0", "9.9.9"]; // 9.9.9 is not recorded

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

describe("Переключение и откат / Установка закреплённой версии: random command sequences", () => {
  it("keep the pin invariants after every step", async () => {
    setProcessLanguage("en");
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = mulberry32(seed);
      const dir = mkdtempSync(join(tmpdir(), "pins-prop-"));
      try {
        mkdirSync(join(dir, "sessions"));
        writeFileSync(join(dir, "sessions", "s.jsonl"), `{"seed":${seed}}\n`);
        writeFileSync(join(dir, "config.json"), "{}");
        let sourceCalls = 0;
        const source: PackageSource = {
          async fetch(agent, version, d) {
            sourceCalls++;
            const exe = join(d, "bin", agent);
            mkdirSync(join(d, "bin"), { recursive: true });
            writeFileSync(exe, `#!/bin/sh\necho ${version}\n`);
            chmodSync(exe, 0o755);
            return { executable: exe, source: "fake" };
          }
        };
        const deps = { source, record, readVersion: async (p: string) => readFileSync(p, "utf8").split("\n")[1]!.replace("echo ", "") };
        const successes = new Set<string>();
        const trace: string[] = [];
        for (let step = 0, n = 1 + Math.floor(r() * 30); step < n; step++) {
          const op = pick(r, ["install", "candidate", "use", "rollback"] as const);
          const v = pick(r, VERSIONS);
          trace.push(op === "rollback" ? op : `${op} ${v}`);
          if (op === "install" || op === "candidate") {
            const res = await installPin(dir, "claude", { version: v, candidate: op === "candidate" }, deps);
            if (res.ok && !res.text.includes("already installed")) successes.add(v);
          } else if (op === "use") usePin(dir, "claude", v, { record });
          else rollbackPin(dir, "claude", {});

          const ctx = `seed ${seed}: ${trace.join("; ")}`;
          const s = readPins(dir);
          if (s.state === "loaded") {
            const a = s.pins.agents.claude!;
            const level = (x: string) => record.entries.find((e) => e.version === x)?.level;
            if (a.active !== null) {
              expect(a.installed.some((i) => i.version === a.active), ctx).toBe(true);
              expect(level(a.active), ctx).toBe("real");
            }
            if (a.active !== null && a.previous !== null) expect(a.previous, ctx).not.toBe(a.active);
            expect(a.installed.length, ctx).toBe(successes.size);
          } else expect(successes.size, ctx).toBe(0);
          expect(sourceCalls, ctx).toBe(successes.size);
          expect(readFileSync(join(dir, "sessions", "s.jsonl"), "utf8"), ctx).toBe(`{"seed":${seed}}\n`);
          expect(readFileSync(join(dir, "config.json"), "utf8"), ctx).toBe("{}");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
