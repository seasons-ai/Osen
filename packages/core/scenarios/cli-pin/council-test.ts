#!/usr/bin/env node
// Stand service entry: like council.ts, but with a substitute package source and a substitute verified-versions record.
// The production council.ts entry never passes either; this file lives only in the scenarios folder.
// CLI_PIN_STAND = JSON {log, counter, mode: "ok" | "error" | "wrong-version"}.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../../src/cli.ts";
import type { PackageSource } from "../../src/cli-agents/pins.ts";
import type { VerifiedEntry, VerifiedRecord } from "../../src/cli-agents/verified-record.ts";
import { loadEnv } from "../../src/store/env.ts";
import { applyProcessLanguage } from "../../src/store/preferences.ts";
import { writeStub } from "./stub.ts";

const standEnv = loadEnv(process.env, process.cwd());
applyProcessLanguage(standEnv); // like council.ts: the language is set before main
const raw = process.env.CLI_PIN_STAND;
if (!raw) {
  console.error("The CLI_PIN_STAND variable is not set (JSON with log, counter, mode): this is the stand service entry.");
  process.exit(2);
}
const stand = JSON.parse(raw) as { log: string; counter: string; mode: "ok" | "error" | "wrong-version" };

const base = { checkedAt: "2026-10-20", os: "darwin-arm64", osenVersion: "1.0.0" };
const record: VerifiedRecord = {
  entries: [
    { agent: "claude", version: "1.0.0", level: "real", modelCalls: 2, ...base },
    { agent: "claude", version: "1.1.0", level: "real", modelCalls: 2, ...base },
    { agent: "claude", version: "2.0.0", level: "interface", ...base },
  ] satisfies VerifiedEntry[],
};

const source: PackageSource = {
  async fetch(agent, version, dir) {
    appendFileSync(stand.log, `${JSON.stringify({ agent, version, dir })}\n`);
    if (stand.mode === "error") throw new Error("substitute source failure");
    const bin = join(dir, "node_modules", "pkg", "bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, agent);
    mkdirSync(dirname(stand.counter), { recursive: true });
    writeStub(exe, { version: stand.mode === "wrong-version" ? "9.9.9" : version, counter: `${stand.counter}.${agent}.${version}` });
    return { executable: exe, source: `stand:${agent}@${version}` };
  },
};

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), {
  stdout: console.log, stderr: console.error, env: standEnv, signal: controller.signal,
  chunk: (t) => process.stderr.write(t), cliPin: { source, record },
});
