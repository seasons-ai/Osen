#!/usr/bin/env node
// Stand service entry for `council cli accept`: like council.ts, but with a substitute package source that installs the acceptance stub as codex 9.9.9.
// The production council.ts entry never passes the source; this file lives only in the scenarios folder.
// Stub modes and the turn log are read by the stub from its environment (STUB_MODE, STUB_LOG, STUB_STATE, STUB_PIDFILE).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import { writeAcceptanceStub } from "../../src/cli-agents/acceptance-stub.fixture.ts";
import type { PackageSource } from "../../src/cli-agents/pins.ts";
import { loadEnv } from "../../src/store/env.ts";
import { applyProcessLanguage } from "../../src/store/preferences.ts";

const standEnv = loadEnv(process.env, process.cwd());
applyProcessLanguage(standEnv); // like council.ts: the language is set before main
const fixtures = join(import.meta.dirname, "../../src/cli-agents/fixtures");
const fx = (name: string) => readFileSync(join(fixtures, name), "utf8");

// Only codex 9.9.9 is provided: the help and feature list are the real 0.159.2 texts, so inspection passes.
const source: PackageSource = {
  async fetch(agent, version, dir) {
    if (agent !== "codex" || version !== "9.9.9") throw new Error(`the stand provides only codex 9.9.9, not ${agent} ${version}`);
    const bin = join(dir, "node_modules", "pkg", "bin");
    mkdirSync(bin, { recursive: true });
    const exe = writeAcceptanceStub(bin, { version: `codex-cli ${version}`, help: fx("codex-0.159.2-exec-help.txt"), features: fx("codex-0.159.2-features.txt") });
    return { executable: exe, source: `stand:${agent}@${version}` };
  },
};

// No substitute record: the data folder's cli-verified.json is read, so the real entry written by accept is seen by `cli list`.
const osenVersion = (JSON.parse(readFileSync(join(import.meta.dirname, "../../../../package.json"), "utf8")) as { version: string }).version;

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), {
  stdout: console.log, stderr: console.error, env: standEnv, signal: controller.signal, appVersion: osenVersion,
  chunk: (t) => process.stderr.write(t), cliPin: { source },
});
