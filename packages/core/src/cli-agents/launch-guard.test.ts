import { chmodSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { checkPinnedLaunch, pinBinaryState, resetGuardCache } from "./launch-guard.ts";
import { ifaceEntry, installStub, realEntry, runs, tamper } from "./launch-guard.fixture.ts";
import { activePin } from "./pins.ts";
import type { VerifiedRecord } from "./verified-record.ts";

const R = "Проверка закреплённой установки перед запуском";
const record: VerifiedRecord = { entries: [realEntry("1.0.0"), realEntry("1.1.0"), ifaceEntry("2.0.0")] };
let dir: string;
beforeEach(() => {
  setProcessLanguage("en");
  resetGuardCache();
  dir = mkdtempSync(join(tmpdir(), "guard-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function pinned(version = "1.0.0") {
  const path = await installStub(dir, version, record);
  const a = activePin(dir, "claude");
  if (a.state !== "pin") throw new Error("no pin");
  const input = (over: object = {}) => ({ agent: "claude" as const, pin: a, launchPath: path, record, env: {}, ...over });
  return { path, a, input };
}

describe(R, () => {
  it(`${R}: pin matches`, async () => {
    const { path, input } = await pinned();
    const r = await checkPinnedLaunch(input());
    expect(r).toEqual({ ok: true, version: "1.0.0", level: "real", checkedAt: "2026-10-20" });
    expect(runs(path)).toBe(1); // only the --version probe
  });

  it(`${R}: binary replaced after install`, async () => {
    const { path, a, input } = await pinned();
    tamper(path);
    const r = await checkPinnedLaunch(input());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain(a.sha256);
      expect(r.reason).toMatch(/checksum.*is [0-9a-f]{64}, expected [0-9a-f]{64}/);
      expect(r.reason).toContain(path);
    }
    expect(runs(path)).toBe(0); // not even --version ran
  });

  it(`${R}: binary version does not match`, async () => {
    const { path, input } = await pinned();
    // a self-updated binary that reports another version (the sum is still the installed one)
    const r = await checkPinnedLaunch(input(), { readVersion: async () => "1.0.1 (Claude Code)" });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) {
      expect(r.reason).toMatch(/reports version 1\.0\.1, expected 1\.0\.0/);
      expect(r.reason).toContain(path);
    }
    // a suffix after the number is not a mismatch
    expect(await checkPinnedLaunch(input(), { readVersion: async () => "1.0.0-beta" })).toMatchObject({ ok: true });
  });

  it(`${R}: binary deleted`, async () => {
    const { path, input } = await pinned();
    rmSync(path);
    const r = await checkPinnedLaunch(input());
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain(path);
  });

  it(`${R}: record level is not real (interface and absent)`, async () => {
    const { path, input } = await pinned();
    for (const [entries, level] of [[[ifaceEntry("1.0.0")], "interface"], [[], "none"]] as const) {
      const r = await checkPinnedLaunch(input({ record: { entries } }));
      expect(r).toMatchObject({ ok: false });
      if (!r.ok) {
        expect(r.reason).toContain("real acceptance of this version is not recorded");
        expect(r.reason).toContain(`record level: ${level}`);
      }
    }
    expect(runs(path)).toBe(0);
  });

  it(`${R}: launch path differs from the active install`, async () => {
    const { path, input } = await pinned();
    const r = await checkPinnedLaunch(input({ launchPath: "/elsewhere/claude" }));
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain(path), expect(r.reason).toContain("/elsewhere/claude");
    expect(runs(path)).toBe(0);
  });

  it(`${R}: failing --version is a version mismatch carrying the error text`, async () => {
    const { input } = await pinned();
    const r = await checkPinnedLaunch(input(), { readVersion: async () => { throw new Error("boom exit 3"); } });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/could not be read \(boom exit 3\), expected 1\.0\.0/);
    const none = await checkPinnedLaunch(input(), { readVersion: async () => "hello" });
    expect(none).toMatchObject({ ok: false });
  });

  it(`${R}: reason is in the interface language`, async () => {
    const { path, input } = await pinned();
    setProcessLanguage("ru");
    const level = await checkPinnedLaunch(input({ record: { entries: [] } }));
    expect(level).toMatchObject({ ok: false });
    if (!level.ok) expect(level.reason).toContain("реальная приёмка версии не записана");
    tamper(path);
    const sum = await checkPinnedLaunch(input());
    if (!sum.ok) expect(sum.reason).toContain("контрольная сумма");
    else expect.unreachable();
  });

  it(`${R}: a symlink to the binary is followed`, async () => {
    const { path, input } = await pinned();
    const link = join(dir, "link");
    symlinkSync(path, link);
    expect(await checkPinnedLaunch(input({ pin: { ...(await pinnedPin()), path: link }, launchPath: link }))).toMatchObject({ ok: true });
    tamper(path);
    expect(await checkPinnedLaunch(input({ pin: { ...(await pinnedPin()), path: link }, launchPath: link }))).toMatchObject({ ok: false });
    async function pinnedPin() {
      const a = activePin(dir, "claude");
      if (a.state !== "pin") throw new Error("no pin");
      return a;
    }
  });
});

describe(`${R}: checksum cache`, () => {
  it(`${R}: an unchanged file is hashed once, a rewritten one again`, async () => {
    const { path, input } = await pinned();
    let hashes = 0;
    const hash = async () => { hashes++; return input().pin.sha256; };
    await checkPinnedLaunch(input(), { hash });
    await checkPinnedLaunch(input(), { hash });
    expect(hashes).toBe(1);
    tamper(path);
    const r = await checkPinnedLaunch(input(), { hash: async () => { hashes++; return "f".repeat(64); } });
    expect(hashes).toBe(2);
    expect(r).toMatchObject({ ok: false });
  });

  it(`${R}: same size rewrite with a new mtime is hashed again`, async () => {
    const { path, input } = await pinned();
    let hashes = 0;
    const hash = async () => { hashes++; return input().pin.sha256; };
    await checkPinnedLaunch(input(), { hash });
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await checkPinnedLaunch(input(), { hash });
    expect(hashes).toBe(2);
  });

  it(`${R}: pinBinaryState follows the pin and the binary file`, async () => {
    expect(pinBinaryState(dir, "claude")).toBe("none");
    const { path } = await pinned();
    const before = pinBinaryState(dir, "claude");
    expect(before).toMatch(/^\d+:/);
    tamper(path);
    expect(pinBinaryState(dir, "claude")).not.toBe(before);
    rmSync(path);
    expect(pinBinaryState(dir, "claude")).toBe("missing");
    writeFileSync(join(dir, "cli", "pins.json"), "{ nope");
    expect(pinBinaryState(dir, "claude")).toBe("rejected");
  });
});
