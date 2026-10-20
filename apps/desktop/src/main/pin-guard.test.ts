import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_TEMPLATES_DIR, initialRegistry, inspectProvider, listSessions, loadTemplates, resetDiscoveryCache, resetGuardCache, runStoredSession, writeRegistry } from "@model-council/core";
import type { Logger } from "@model-council/core";
import { setProcessLanguage } from "@model-council/core/i18n";
import { addLocalEntry } from "../../../../packages/core/src/cli-agents/verified-record.ts";
import { installStub, realEntry, runs, stubScript, tamper } from "../../../../packages/core/src/cli-agents/launch-guard.fixture.ts";
import { createLauncher, LaunchError } from "./launcher.ts";
import { inertTransition } from "./cli-transition.testutil.ts";
import { createSettings } from "./settings.ts";

const R = "Причина несовпадения закрепления в списке провайдеров";
const V = "9.1.0"; // not in the built-in record: only the local record decides
const FIX = join(import.meta.dirname, "../../../../packages/core/src/cli-agents/fixtures");
const helpText = readFileSync(join(FIX, "claude-2.1.288-help.txt"), "utf8");
const logger: Logger = { info: () => {}, error: () => {} };

let root: string;
let data: string;
beforeEach(() => {
  setProcessLanguage("ru");
  resetDiscoveryCache();
  resetGuardCache();
  root = mkdtempSync(join(tmpdir(), "desktop-pin-guard-"));
  data = join(root, "data");
  mkdirSync(join(root, "bin")); // no CLI on PATH: a PATH binary can never be what runs
  chmodSync(join(root, "bin"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const env = () => ({ PATH: join(root, "bin"), SHELL: "/usr/bin/false", COUNCIL_DEV: "1" });
// the real locate and the real guard; only what would run the CLI for help and models is replaced
const inspect: typeof inspectProvider = (p, o) =>
  inspectProvider(p, { ...o, deps: { readHelp: async () => helpText, readFeatures: async () => "", listModels: async () => ({ models: [], confirmed: false }) } as never });

async function pinned(): Promise<string> {
  const binary = await installStub(data, V, { entries: [realEntry(V)] });
  expect(addLocalEntry(data, realEntry(V)).ok).toBe(true);
  writeRegistry(data, initialRegistry(["claude"]));
  return binary;
}

describe(R, () => {
  it(`${R}: the providers list shows a tampered pinned provider unavailable with the reason, and available again after the binary is restored`, async () => {
    const binary = await pinned();
    const api = createSettings({ dataDir: data, env: env(), reloadEnv: () => {}, logger, inspect, transition: inertTransition(data, logger) });
    expect((await api.view()).providers.find((p) => p.id === "claude")).toMatchObject({ available: true, reason: null, version: V, path: binary });

    tamper(binary);
    const bad = (await api.recheck()).providers.find((p) => p.id === "claude")!;
    expect(bad.available).toBe(false);
    expect(bad.reason).toContain("контрольная сумма не совпала");
    expect(bad.reason).toContain(binary);
    expect(bad.reason).toContain(V);
    expect(runs(binary)).toBe(1); // the --version probe of the first, matching inspection only

    writeFileSync(binary, stubScript(V)); // the original content again
    const good = (await api.recheck()).providers.find((p) => p.id === "claude")!;
    expect(good).toMatchObject({ available: true, reason: null, version: V });
  });

  it(`${R}: the launcher refuses a start with a tampered pinned participant and creates no session`, async () => {
    const binary = await pinned();
    tamper(binary);
    const run = vi.fn<typeof runStoredSession>();
    const launcher = createLauncher({
      dataDir: data, env: env(), logger, registry: () => initialRegistry(["claude"]),
      catalog: () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: join(data, "templates") }),
      scenarioPath: () => null, inspect, run,
    });
    const e = await launcher.start({ templateId: null, topic: "Тема", participants: [{ providerId: "claude", model: "default", role: null }, { providerId: "claude", model: "default", role: null }], maxRounds: 3 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LaunchError);
    expect((e as Error).message).toContain("Claude Code");
    expect((e as Error).message).toContain("контрольная сумма не совпала");
    expect(listSessions(data)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(runs(binary)).toBe(0);
  });
});
