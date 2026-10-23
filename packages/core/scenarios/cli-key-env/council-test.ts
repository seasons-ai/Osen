#!/usr/bin/env node
// Stand service entry: like council.ts, but `cli install` and `cli candidates` take a substitute package source and release source
// (codex 9.9.9 acceptance stub wrapped by a launch logger). The production council.ts entry never passes them.
// CLI_KEY_ENV_STAND = JSON {log}: the file the wrapper appends launch records to.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import { writeAcceptanceStub } from "../../src/cli-agents/acceptance-stub.fixture.ts";
import type { ReleaseSource } from "../../src/cli-agents/candidates.ts";
import type { PackageSource } from "../../src/cli-agents/pins.ts";
import { loadEnv } from "../../src/store/env.ts";
import { applyProcessLanguage } from "../../src/store/preferences.ts";
import { writeLoggingWrapper } from "./stubs.ts";

const standEnv = loadEnv(process.env, process.cwd());
applyProcessLanguage(standEnv);
const stand = JSON.parse(process.env.CLI_KEY_ENV_STAND ?? "null") as { log: string } | null;
if (!stand) {
  console.error("The CLI_KEY_ENV_STAND variable is not set (JSON with log): this is the stand service entry.");
  process.exit(2);
}
const fixtures = join(import.meta.dirname, "../../src/cli-agents/fixtures");
const fx = (name: string) => readFileSync(join(fixtures, name), "utf8");

const releases: ReleaseSource = { async list(agent) { return agent === "codex" ? ["9.9.9"] : []; } };
const source: PackageSource = {
  async fetch(agent, version, dir) {
    if (agent !== "codex" || version !== "9.9.9") throw new Error(`the stand provides only codex 9.9.9, not ${agent} ${version}`);
    const bin = join(dir, "node_modules", "pkg", "bin");
    mkdirSync(bin, { recursive: true });
    const real = writeAcceptanceStub(bin, { version: `codex-cli ${version}`, help: fx("codex-0.159.2-exec-help.txt"), features: fx("codex-0.159.2-features.txt") });
    const exe = join(bin, agent);
    writeLoggingWrapper(exe, real, agent, stand.log);
    return { executable: exe, source: `stand:${agent}@${version}` };
  },
};

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), {
  stdout: console.log, stderr: console.error, env: standEnv, signal: controller.signal,
  chunk: (t) => process.stderr.write(t), appVersion: "0.0.0-stand", cliPin: { releases, source },
});
