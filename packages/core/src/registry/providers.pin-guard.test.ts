import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDiscoveryCache } from "../cli-agents/discovery.ts";
import { resetGuardCache } from "../cli-agents/launch-guard.ts";
import { ifaceEntry, installStub, realEntry, runs, tamper } from "../cli-agents/launch-guard.fixture.ts";
import { addLocalEntry } from "../cli-agents/verified-record.ts";
import { setProcessLanguage } from "../i18n/process-language.ts";
import type { CliProvider } from "./config.ts";
import { inspectProvider } from "./providers.ts";

const R = "Проверка закреплённой установки перед запуском";
const V = "9.1.0"; // not in the built-in record, so only the local record decides
const helpText = readFileSync(resolve(import.meta.dirname, "../cli-agents/fixtures/claude-2.1.288-help.txt"), "utf8");
const claude: CliProvider = { id: "claude", kind: "cli", label: "Claude Code", agent: "claude", models: [] };

let root: string;
let data: string;
let helpCalls: number;
let pathRuns: string;
const deps = () => ({
  listModels: async () => ({ models: [], confirmed: false }),
  readHelp: async () => { helpCalls++; return helpText; },
});
const env = () => ({ PATH: join(root, "bin"), SHELL: "/usr/bin/false" });
const inspect = (extra: { provider?: CliProvider; deps?: object } = {}) =>
  inspectProvider(extra.provider ?? claude, { env: env(), dataDir: data, deps: { ...deps(), ...extra.deps } });

beforeEach(() => {
  setProcessLanguage("en");
  resetDiscoveryCache();
  resetGuardCache();
  root = mkdtempSync(join(tmpdir(), "pin-guard-"));
  data = join(root, "data");
  helpCalls = 0;
  mkdirSync(join(root, "bin"));
  pathRuns = join(root, "path-runs");
  writeFileSync(join(root, "bin", "claude"), `#!/bin/sh\necho x >> '${pathRuns}'\necho '2.1.288 (Claude Code)'\n`);
  chmodSync(join(root, "bin", "claude"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const pathBinaryRan = () => { try { return readFileSync(pathRuns, "utf8").length > 0; } catch { return false; } };
async function pin(): Promise<string> {
  const path = await installStub(data, V, { entries: [realEntry(V)] });
  expect(addLocalEntry(data, realEntry(V)).ok).toBe(true);
  return path;
}

describe(R, () => {
  it(`${R}: matching pin is available without version warnings`, async () => {
    await pin();
    const r = await inspect();
    expect(r.status).toMatchObject({ available: true, version: V, verified: { level: "real" } });
    expect(r.status.warning).toBeUndefined();
    expect(r.runtime).toMatchObject({ pinned: true, pinDataDir: data });
    expect(pathBinaryRan()).toBe(false);
  });

  it(`${R}: binary replaced after install: unavailable, no help read, PATH claude not run`, async () => {
    const path = await pin();
    tamper(path);
    const r = await inspect();
    expect(r.status.available).toBe(false);
    expect(r.status.reason).toMatch(/checksum.*expected/);
    expect(r.runtime).toBeUndefined();
    expect(helpCalls).toBe(0);
    expect(runs(path)).toBe(0);
    expect(pathBinaryRan()).toBe(false);
  });

  it(`${R}: real locateCli sees a binary modified between two inspections (cache key)`, async () => {
    const path = await pin();
    expect((await inspect()).status.available).toBe(true);
    tamper(path);
    const second = await inspect();
    expect(second.status.available).toBe(false);
    expect(second.status.reason).toContain("checksum");
  });

  it(`${R}: deleted binary names the pin path`, async () => {
    const path = await pin();
    rmSync(path);
    const r = await inspect();
    expect(r.status.available).toBe(false);
    expect(r.status.reason).toContain(path);
    expect(pathBinaryRan()).toBe(false);
  });

  it(`${R}: interface-only and absent record levels are refused`, async () => {
    await pin();
    rmSync(join(data, "cli-verified.json"));
    expect(addLocalEntry(data, ifaceEntry(V)).ok).toBe(true);
    resetDiscoveryCache();
    const r = await inspect();
    expect(r.status.available).toBe(false);
    expect(r.status.reason).toContain("real acceptance of this version is not recorded");
    rmSync(join(data, "cli-verified.json"));
    resetDiscoveryCache();
    expect((await inspect()).status.reason).toContain("real acceptance of this version is not recorded");
    expect(helpCalls).toBe(0);
  });

  it(`${R}: isolation is still checked when the pin matches`, async () => {
    await pin();
    const r = await inspect({ deps: { readHelp: async () => helpText.replaceAll("--tools", "--tool-list") } });
    expect(r.status.available).toBe(false);
    expect(r.status.reason).toContain("--tools");
  });

  it(`${R}: without a pin or with an explicit path the old behavior stays (version outside the record is a warning)`, async () => {
    const noPin = await inspect();
    expect(noPin.status).toMatchObject({ available: true, version: "2.1.288" });
    await pin();
    const other = join(root, "other");
    writeFileSync(other, "#!/bin/sh\necho '9.9.9 (Claude Code)'\n");
    chmodSync(other, 0o755);
    const explicit = await inspect({ provider: { ...claude, path: other } });
    expect(explicit.status).toMatchObject({ available: true, version: "9.9.9", path: other });
    expect(explicit.status.warning).toBeDefined();
    expect(explicit.runtime?.pinDataDir).toBeUndefined();
  });
});
