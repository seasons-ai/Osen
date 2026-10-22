import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import type { CliProvider } from "../registry/config.ts";
import { inspectProvider } from "../registry/providers.ts";
import { locateCli, resetDiscoveryCache } from "./discovery.ts";
import { ifaceEntry, realEntry } from "./launch-guard.fixture.ts";
import { checkPinFile, checkPinnedLaunch, resetGuardCache } from "./launch-guard.ts";
import { installedPath } from "./pins.ts";
import type { VerifiedEntry } from "./verified-record.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEEDS = 250;
const R = "Проверка закреплённой установки перед запуском";
const helpOk = readFileSync(resolve(import.meta.dirname, "fixtures/claude-2.1.288-help.txt"), "utf8");
const helpNoTools = helpOk.replaceAll("--tools", "--tool-list");
const claude: CliProvider = { id: "claude", kind: "cli", label: "Claude Code", agent: "claude", models: [] };
const V = "1.0.0";
const SHA = "a".repeat(64);
const WRONG = "b".repeat(64);

// what the stub binary answers to --version, and whether the guard accepts it
const VERSION_OUTPUTS: { out: string | Error; ok: boolean }[] = [
  { out: "1.0.0", ok: true },
  { out: "1.0.0 (Claude Code)", ok: true },
  { out: "1.0.0-beta", ok: true },
  { out: "Claude Code v1.0.0\n", ok: true },
  { out: "1.0.1", ok: false },
  { out: "2.1.0 (Claude Code)", ok: false },
  { out: "no number", ok: false },
  { out: new Error("exit 3"), ok: false },
];
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

function recordFor(r: () => number): { entries: VerifiedEntry[]; level: "real" | "interface" | "none" } {
  const kind = pick(r, ["real", "interface", "absent", "empty", "dupRealFirst", "dupIfaceFirst"] as const);
  const other = realEntry("1.0.1");
  switch (kind) {
    case "real": return { entries: [other, realEntry(V)], level: "real" };
    case "interface": return { entries: [ifaceEntry(V)], level: "interface" };
    case "absent": return { entries: [other], level: "none" };
    case "empty": return { entries: [], level: "none" };
    case "dupRealFirst": return { entries: [realEntry(V), ifaceEntry(V)], level: "real" };
    case "dupIfaceFirst": return { entries: [ifaceEntry(V), realEntry(V)], level: "interface" };
  }
}

function writePins(dataDir: string, withPin: boolean): string {
  mkdirSync(join(dataDir, "cli"), { recursive: true });
  const install = { version: V, path: "bin/claude", source: "fake", sha256: SHA, installedAt: "2026-10-20T00:00:00Z" };
  const agents = withPin ? { claude: { installed: [install], active: V, previous: null, activatedAt: "2026-10-20T00:00:00Z" } } : {};
  writeFileSync(join(dataDir, "cli", "pins.json"), JSON.stringify({ schemaVersion: 1, agents }));
  return installedPath(dataDir, "claude", install);
}

describe(R, () => {
  it(`${R}: random pin states decide availability and never fall back to PATH`, async () => {
    setProcessLanguage("en");
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = mulberry32(seed);
      const dataDir = mkdtempSync(join(tmpdir(), "guard-prop-"));
      try {
        resetDiscoveryCache();
        resetGuardCache();
        const withPin = r() < 0.75;
        const explicit = r() < 0.2;
        const pinPath = writePins(dataDir, withPin);
        const exists = r() < 0.85;
        const shaOk = r() < 0.7;
        const ver = pick(r, VERSION_OUTPUTS);
        const rec = recordFor(r);
        const flagsOk = r() < 0.8;
        const c = { fileId: 0, hash: 0, version: 0, help: 0, pathRun: 0 };
        const deps = {
          listModels: async () => ({ models: [], confirmed: false }),
          readHelp: async () => (c.help++, flagsOk ? helpOk : helpNoTools),
          locate: (agent: "claude" | "codex", o: Parameters<typeof locateCli>[1]) =>
            locateCli(agent, {
              ...o,
              deps: {
                isExecutable: (p: string) => p !== pinPath || exists,
                loginShellPath: async () => undefined,
                runVersion: async () => (c.pathRun++, "2.1.288 (Claude Code)"),
                record: { entries: rec.entries },
                guard: {
                  fileId: (p: string) => (c.fileId++, p === pinPath && exists ? "1:1:1" : undefined),
                  hash: async () => (c.hash++, shaOk ? SHA : WRONG),
                  readVersion: async () => { c.version++; if (ver.out instanceof Error) throw ver.out; return ver.out; },
                },
              },
            }),
        };
        const res = await inspectProvider(explicit ? { ...claude, path: "/explicit/claude" } : claude, { env: { PATH: "/usr/bin" }, dataDir, deps });
        const where = `seed ${seed}`;
        if (!withPin || explicit) {
          // old behavior: the guard is not involved, availability depends on the help only
          expect(c, where).toMatchObject({ fileId: 0, hash: 0, version: 0 });
          expect(res.status.available, where).toBe(flagsOk);
          expect(c.pathRun, where).toBe(1);
          continue;
        }
        const guardOk = exists && shaOk && rec.level === "real" && ver.ok;
        expect(res.status.available, where).toBe(guardOk && flagsOk);
        expect(c.pathRun, where).toBe(0); // the PATH binary is never probed under a pin
        expect(c.help, where).toBe(guardOk ? 1 : 0);
        expect(c.hash, where).toBe(exists ? 1 : 0);
        expect(c.version, where).toBe(exists && shaOk && rec.level === "real" ? 1 : 0);
        if (!guardOk) expect(res.runtime, where).toBeUndefined();
        if (guardOk) expect(res.status.path, where).toBe(pinPath);
        if (!guardOk) expect(res.status.reason, where).toBeTruthy();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it(`${R}: launch path mismatch is refused before any file access`, async () => {
    setProcessLanguage("en");
    for (let seed = 1; seed <= 200; seed++) {
      const r = mulberry32(seed);
      resetGuardCache();
      let touched = 0;
      const same = r() < 0.5;
      const pinPath = `/data/cli/claude/${V}/bin/claude`;
      const res = await checkPinnedLaunch(
        { agent: "claude", pin: { path: pinPath, version: V, sha256: SHA }, launchPath: same ? pinPath : pick(r, ["/usr/bin/claude", `${pinPath}/`, "bin/claude", ""]), record: { entries: [realEntry(V)] }, env: {} },
        { fileId: () => (touched++, "1:1:1"), hash: async () => SHA, readVersion: async () => V },
      );
      expect(res.ok, `seed ${seed}`).toBe(same);
      if (!same) expect(touched, `seed ${seed}`).toBe(0);
    }
  });

  it(`${R}: in-place rewrite with restored mtime never passes the check`, async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = mulberry32(seed);
      resetGuardCache();
      const dataDir = mkdtempSync(join(tmpdir(), "guard-prop-"));
      try {
        const file = join(dataDir, "claude");
        const size = 8 + Math.floor(r() * 64);
        const original = Buffer.alloc(size, 0x61);
        writeFileSync(file, original, { mode: 0o755 });
        utimesSync(file, 1_700_000_000, 1_700_000_000); // whole-second mtime: restorable exactly
        const sum = createHash("sha256").update(original).digest("hex");
        expect(await checkPinFile(file, sum), `seed ${seed}`).toEqual({ ok: true });
        for (let step = 0; step < 4; step++) {
          const same = r() < 0.3;
          const content = same ? original : Buffer.alloc(size, 0x62 + Math.floor(r() * 20));
          writeFileSync(file, content);
          if (r() < 0.8) utimesSync(file, 1_700_000_000, 1_700_000_000); // restored mtime
          await new Promise((res) => setTimeout(res, 5));
          const res = await checkPinFile(file, sum);
          const actual = createHash("sha256").update(content).digest("hex");
          expect(res.ok, `seed ${seed} step ${step}`).toBe(actual === sum);
        }
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  });
});
