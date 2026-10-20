#!/usr/bin/env node
// Stand service entry: like council.ts, but `cli install` takes a substitute package source (stub CLIs, no network) and a substitute record.
// The production council.ts entry never passes either; this file lives only in the scenarios folder.
// LAUNCH_GUARD_STAND = JSON {counters, side}: folders for the stubs' launch marks and side files.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../../src/cli.ts";
import type { PackageSource } from "../../src/cli-agents/pins.ts";
import type { VerifiedEntry, VerifiedRecord } from "../../src/cli-agents/verified-record.ts";
import { loadEnv } from "../../src/store/env.ts";
import { applyProcessLanguage } from "../../src/store/preferences.ts";
import { writeStub } from "./stub.ts";

const standEnv = loadEnv(process.env, process.cwd());
applyProcessLanguage(standEnv);
const raw = process.env.LAUNCH_GUARD_STAND;
if (!raw) {
  console.error("The LAUNCH_GUARD_STAND variable is not set (JSON with counters and side): this is the stand service entry.");
  process.exit(2);
}
const stand = JSON.parse(raw) as { counters: string; side: string };

const base = { checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0", modelCalls: 2 };
const record: VerifiedRecord = {
  entries: [
    { agent: "claude", version: "1.0.0", level: "real", ...base },
    { agent: "codex", version: "3.0.0", level: "real", ...base },
  ] satisfies VerifiedEntry[],
};

const source: PackageSource = {
  async fetch(agent, version, dir) {
    const bin = join(dir, "node_modules", "pkg", "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(dirname(stand.counters), { recursive: true });
    const exe = join(bin, agent);
    writeStub(exe, { agent, version, mark: join(stand.counters, `pin.${agent}`), side: join(stand.side, agent) });
    return { executable: exe, source: `stand:${agent}@${version}` };
  },
};

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), {
  stdout: console.log, stderr: console.error, env: standEnv, signal: controller.signal,
  chunk: (t) => process.stderr.write(t), cliPin: { source, record },
});
