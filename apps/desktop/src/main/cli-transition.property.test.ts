import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderStatus } from "@model-council/core";
import type { AgentPins } from "../../../../packages/core/src/cli-agents/pins.ts";
import type { VerifiedEntry } from "../../../../packages/core/src/cli-agents/verified-record.ts";
import { computeTransition, createCliTransition } from "./cli-transition.ts";
import type { LastCheck } from "./cli-transition.ts";
import { installVersions, pinsBytes, record } from "./cli-transition.testutil.ts";
import type { CliSource } from "../shared/settings.ts";

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-20T12:00:00Z");
const ACTIVE = "5.0.0";
// 10.0.0 sits next to 5.x so that a string comparison would order it wrong
const VERSIONS = ["4.9.0", "5.0.0", "5.0.1", "5.1.0", "5.10.0", "6.0.0", "10.0.0"];
const num = (v: string) => v.split(".").map(Number);
const newer = (v: string) => { const [a, b] = [num(v), num(ACTIVE)]; return a[0]! !== b[0]! ? a[0]! > b[0]! : a[1]! !== b[1]! ? a[1]! > b[1]! : a[2]! > b[2]!; };

interface Case { seed: number; period: number; source: CliSource | null; age: number | null; entries: VerifiedEntry[]; installed: string[]; label: string }

function gen(seed: number): Case {
  const r = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const period = 1 + Math.floor(r() * 365);
  const age = pick([0, period, period + 1, period - 1, -2, null, Math.floor(r() * 400), Math.floor(r() * 3)]);
  const entries: VerifiedEntry[] = [];
  for (const v of VERSIONS) {
    const k = r();
    if (k < 0.25) continue;
    entries.push({ agent: "claude", version: v, level: k < 0.65 ? "real" : "interface", checkedAt: "2026-10-07", os: "darwin-arm64", osenVersion: "1.0.0" });
  }
  const installed = [ACTIVE, ...VERSIONS.filter((v) => v !== ACTIVE && r() < 0.5)];
  const source = pick<CliSource | null>(["pin", "pin", "pin", "path", "explicit", null]);
  return { seed, period, source, age, entries, installed, label: JSON.stringify({ seed, period, source, age, installed, entries: entries.map((e) => `${e.version}:${e.level}`) }) };
}

function pinsOf(c: Case, r: () => number): AgentPins {
  // the activation stamp has second precision; the offset stays below a day so that floor() gives exactly `age`
  const offset = Math.floor(r() * 86_399) * 1000;
  const activatedAt = c.age === null ? null : new Date(NOW - c.age * DAY - offset).toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    active: ACTIVE, previous: null, activatedAt,
    installed: c.installed.map((version) => ({ version, path: `bin/${version}`, source: "x", sha256: "0".repeat(64), installedAt: "2026-01-01T00:00:00Z" })),
  };
}

const compute = (c: Case, r: () => number, lastCheck: LastCheck | null = null) =>
  computeTransition({ agent: "claude", now: new Date(NOW), periodDays: c.period, source: c.source, level: "real", checkedAt: "2026-10-07", pins: pinsOf(c, r), record: c.entries, lastCheck });

describe("Requirement: Напоминание о плановом переходе и о кандидате (property)", () => {
  it("due only for a pin older than the period with a newer real version; target only for an installed real one (seeded, 3000 cases)", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const c = gen(seed);
      const t = compute(c, mulberry32(seed + 7));
      const newerReal = c.entries.filter((e) => e.level === "real" && newer(e.version));
      const expectDue = c.source === "pin" && c.age !== null && c.age > c.period && newerReal.length > 0;
      expect(t.due !== null, c.label).toBe(expectDue);
      if (t.due) {
        expect(t.due.ageDays, c.label).toBe(c.age);
        const top = [...newerReal].sort((x, y) => { const [p, q] = [num(x.version), num(y.version)]; return q[0]! - p[0]! || q[1]! - p[1]! || q[2]! - p[2]!; })[0]!;
        expect(t.due.to, c.label).toBe(top.version);
      }
      if (t.target) {
        expect(c.source, c.label).toBe("pin");
        expect(newerReal.some((e) => e.version === t.target!.version) && c.installed.includes(t.target.version), c.label).toBe(true);
      } else if (c.source === "pin") {
        expect(newerReal.some((e) => c.installed.includes(e.version)), c.label).toBe(false);
      }
      if (t.install) {
        expect(c.installed, c.label).not.toContain(t.install.version);
        expect(t.install.command, c.label).toBe(`council cli install claude --version ${t.install.version}`);
      }
      // anything that is not a Osen pin never gets reminders or buttons
      if (c.source !== "pin") expect(t, c.label).toMatchObject({ due: null, target: null, install: null, candidates: [], violations: [], check: null });
      // an interface-only record never produces a button or a due reminder
      if (c.source === "pin" && newerReal.length === 0) expect([t.due, t.target, t.install], c.label).toEqual([null, null, null]);
      // candidates are exactly the newer interface-only entries
      if (c.source === "pin") {
        expect(t.candidates.map((x) => x.version).sort(), c.label).toEqual(c.entries.filter((e) => e.level === "interface" && newer(e.version)).map((e) => e.version).sort());
      }
    }
  });

  it("computing against a real data folder never writes pins.json or creates other files (seeded, 60 cases)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-prop-"));
    try {
      record(dir, "claude", ACTIVE, "real");
      record(dir, "claude", "5.1.0", "real");
      await installVersions(dir, "claude", [{ version: ACTIVE }, { version: "5.1.0" }], () => new Date(NOW - 50 * DAY));
      const before = pinsBytes(dir);
      const names = readdirSync(dir).sort();
      const t = createCliTransition({ dataDir: dir, logger: { info() {}, error() {} }, now: () => new Date(NOW), running: () => false, onChecked() {}, candidateDeps: () => inertTransitionDeps() });
      for (let seed = 1; seed <= 60; seed++) {
        const c = gen(seed);
        const status: ProviderStatus = { id: "claude", kind: "cli", label: "c", available: true, models: [], modelsConfirmed: false, ...(c.source ? { source: c.source } : {}) };
        t.forProvider("claude", status);
        t.settingsView();
        compute(c, mulberry32(seed));
        expect(pinsBytes(dir), c.label).toBe(before);
        expect(readdirSync(dir).sort(), c.label).toEqual(names);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function inertTransitionDeps() {
  return { releases: { list: async () => [] }, source: { fetch: async (): Promise<never> => { throw new Error("none"); } } };
}
