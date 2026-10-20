import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import {
  BUILTIN_RECORD,
  VERIFIED_FILE,
  addLocalEntry,
  loadVerifiedRecord,
  lookupVerified,
  parseVerifiedRecord,
  type VerifiedEntry
} from "./verified-record.ts";

const real = (agent: "claude" | "codex", version: string, checkedAt = "2026-10-20"): VerifiedEntry => ({
  agent, version, level: "real", checkedAt, os: "linux-x64", osenVersion: "1.0.0", modelCalls: 2
});
const iface = (agent: "claude" | "codex", version: string, checkedAt = "2026-10-20"): VerifiedEntry => ({
  agent, version, level: "interface", checkedAt, os: "linux-x64", osenVersion: "1.0.0"
});

let dir: string;
const file = () => join(dir, VERIFIED_FILE);
const write = (entries: unknown[], extra: object = {}) => writeFileSync(file(), JSON.stringify({ schemaVersion: 1, entries, ...extra }));

beforeEach(() => {
  setProcessLanguage("en");
  dir = mkdtempSync(join(tmpdir(), "verified-record-"));
});
afterEach(() => {
  setProcessLanguage("en");
  chmodSync(dir, 0o755);
  try { chmodSync(file(), 0o644); } catch { /* absent */ }
  rmSync(dir, { recursive: true, force: true });
});

describe("Verified-versions record", () => {
  it("built-in record applies without a local file", () => {
    const r = loadVerifiedRecord(dir);
    expect(r.rejected).toBeUndefined();
    expect(r.entries).toEqual([...BUILTIN_RECORD]);
    expect(loadVerifiedRecord().entries).toEqual([...BUILTIN_RECORD]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("built-in record is consistent", () => {
    expect(BUILTIN_RECORD).toHaveLength(2);
    expect(lookupVerified(loadVerifiedRecord(), "claude", "2.1.288")).toMatchObject({ level: "real", modelCalls: 3 });
    expect(lookupVerified(loadVerifiedRecord(), "codex", "0.159.2")).toMatchObject({ level: "interface" });
    expect(lookupVerified(loadVerifiedRecord(), "codex", "9.9.9")).toBeUndefined();
    expect(new Set(BUILTIN_RECORD.map((e) => `${e.agent}@${e.version}`)).size).toBe(BUILTIN_RECORD.length);
    for (const e of BUILTIN_RECORD) expect(e.level === "real").toBe(e.modelCalls !== undefined);
    expect(parseVerifiedRecord({ schemaVersion: 1, entries: BUILTIN_RECORD }, "x.json").ok).toBe(true);
  });

  it("local entry raises the level of a built-in one", () => {
    write([real("codex", "0.159.2", "2026-10-21")]);
    expect(lookupVerified(loadVerifiedRecord(dir), "codex", "0.159.2")).toMatchObject({ level: "real", os: "linux-x64", modelCalls: 2 });
  });

  it("local entry does not lower a built-in one", () => {
    write([iface("claude", "2.1.288", "2026-12-01")]);
    expect(lookupVerified(loadVerifiedRecord(dir), "claude", "2.1.288")).toMatchObject({ level: "real", os: "darwin-arm64", modelCalls: 3 });
  });

  it("an invalid element rejects the whole file", () => {
    const bad = { agent: "codex", version: "1.0.0", level: "real", checkedAt: "2026-10-20", os: "x", osenVersion: "1" };
    write([real("codex", "0.159.2"), bad]);
    const before = readFileSync(file(), "utf8");
    const r = loadVerifiedRecord(dir);
    expect(r.entries).toEqual([...BUILTIN_RECORD]);
    expect(r.rejected).toContain("cli-verified.json");
    expect(r.rejected).toContain("entries.1.modelCalls");
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it.each([
    ["root field", () => write([], { extra: 1 })],
    ["element field", () => write([{ ...iface("codex", "1.0.0"), extra: 1 }])],
    ["interface with modelCalls", () => write([{ ...iface("codex", "1.0.0"), modelCalls: 1 }])],
    ["bad version", () => write([iface("codex", "1.0")])],
    ["duplicate pair", () => write([iface("codex", "1.0.0"), real("codex", "1.0.0")])],
    ["not JSON", () => writeFileSync(file(), "{ nope")]
  ])("%s: rejected, built-in applies", (_n, setup) => {
    setup();
    const r = loadVerifiedRecord(dir);
    expect(r.entries).toEqual([...BUILTIN_RECORD]);
    expect(r.rejected).toContain("cli-verified.json");
    expect(r.rejected).not.toContain(dir);
  });

  it.skipIf(process.getuid?.() === 0)("an unreadable file is rejected with the error code and no path", () => {
    write([]);
    chmodSync(file(), 0o000);
    const r = loadVerifiedRecord(dir);
    expect(r.entries).toEqual([...BUILTIN_RECORD]);
    expect(r.rejected).toContain("EACCES");
    expect(r.rejected).not.toContain(dir);
  });

  it("the reason is worded in the process language and hides sha256", () => {
    const sha = "a".repeat(64);
    write([{ ...real("codex", "1.0.0"), sha256: sha, modelCalls: 0 }]);
    const en = loadVerifiedRecord(dir).rejected!;
    setProcessLanguage("ru");
    const ru = loadVerifiedRecord(dir).rejected!;
    expect(en).toMatch(/was rejected/);
    expect(ru).toMatch(/отклонён/);
    expect(ru).toContain("entries.0.modelCalls");
    expect(en + ru).not.toContain(sha);
  });

  it("a malformed sha256 is named by its field, never by its value", () => {
    const bad = "z".repeat(64);
    write([{ ...real("codex", "1.0.0"), sha256: bad }]);
    const reason = loadVerifiedRecord(dir).rejected!;
    expect(reason).toContain("entries.0.sha256");
    expect(reason).not.toContain(bad);
  });

  it("addLocalEntry creates the file from the first entry", () => {
    expect(addLocalEntry(dir, iface("codex", "1.0.0"))).toEqual({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ schemaVersion: 1, entries: [iface("codex", "1.0.0")] });
    expect(readFileSync(file(), "utf8").endsWith("}\n")).toBe(true);
    expect(readdirSync(dir)).toEqual([VERIFIED_FILE]);
  });

  it("addLocalEntry does not overwrite a damaged file", () => {
    writeFileSync(file(), "{ damaged");
    const res = addLocalEntry(dir, iface("codex", "1.0.0"));
    expect(res.ok).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe("{ damaged");
    expect(addLocalEntry(dir, { ...iface("codex", "1.0.0"), version: "x" }).ok).toBe(false);
  });

  it("addLocalEntry raises a level once and never duplicates", () => {
    addLocalEntry(dir, iface("codex", "1.0.0"));
    expect(addLocalEntry(dir, iface("codex", "1.0.0"))).toEqual({ ok: true, changed: false });
    expect(addLocalEntry(dir, real("codex", "1.0.0"))).toEqual({ ok: true, changed: true });
    expect(addLocalEntry(dir, iface("codex", "1.0.0"))).toEqual({ ok: true, changed: false });
    expect(JSON.parse(readFileSync(file(), "utf8")).entries).toEqual([real("codex", "1.0.0")]);
  });
});
