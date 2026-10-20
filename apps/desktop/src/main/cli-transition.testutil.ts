import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@model-council/core";
import { installPin, pinsPath } from "../../../../packages/core/src/cli-agents/pins.ts";
import type { PackageSource } from "../../../../packages/core/src/cli-agents/pins.ts";
import { addLocalEntry, loadVerifiedRecord } from "../../../../packages/core/src/cli-agents/verified-record.ts";
import { createCliTransition } from "./cli-transition.ts";
import type { CliTransitionApi, CliTransitionDeps } from "./cli-transition.ts";

// A transition module for tests that do not care about it: no candidate source, no running session.
export function inertTransition(dataDir: string, logger: Logger, over: Partial<CliTransitionDeps> = {}): CliTransitionApi {
  return createCliTransition({
    dataDir, logger, running: () => false, onChecked: () => {},
    candidateDeps: () => ({ releases: { list: async () => [] }, source: { fetch: async () => { throw new Error("no package source in this test"); } } }),
    ...over,
  });
}

/** Package source that "installs" a shell script printing the requested version. */
export const fakeVersionSource: PackageSource = {
  async fetch(agent, version, dir) {
    const exe = join(dir, "node_modules", "pkg", "bin", agent);
    mkdirSync(join(dir, "node_modules", "pkg", "bin"), { recursive: true });
    writeFileSync(exe, `#!/bin/sh\necho "${version} (fake)"\n`);
    chmodSync(exe, 0o755);
    return { executable: exe, source: `fake:${agent}@${version}` };
  },
};

/** Adds an entry to the local verified record (the way 175/180/181 do), so that pins are made by 176 itself. */
export function record(dataDir: string, agent: "claude" | "codex", version: string, level: "real" | "interface", checkedAt = "2026-10-07"): void {
  const r = addLocalEntry(dataDir, { agent, version, level, checkedAt, os: "darwin-arm64", osenVersion: "1.0.0", ...(level === "real" ? { modelCalls: 2 } : {}) });
  if (!r.ok) throw new Error(r.reason);
}

/** Installs versions through 176; the first `real` one becomes active at `now`. */
export async function installVersions(dataDir: string, agent: "claude" | "codex", versions: { version: string; candidate?: boolean }[], now: () => Date): Promise<void> {
  for (const v of versions) {
    const r = await installPin(dataDir, agent, { version: v.version, ...(v.candidate ? { candidate: true } : {}) }, { source: fakeVersionSource, record: loadVerifiedRecord(dataDir), now });
    if (!r.ok) throw new Error(r.text);
  }
}

export const pinsBytes = (dataDir: string): string => readFileSync(pinsPath(dataDir), "utf8");
