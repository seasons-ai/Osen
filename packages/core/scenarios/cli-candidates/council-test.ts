#!/usr/bin/env node
// Stand service entry: like council.ts, but with a substitute release source, a substitute package source and an optional
// substitute built-in record. The production council.ts entry never passes them; this file lives only in the scenarios folder.
// CLI_CANDIDATES_STAND = JSON {releases, counter, log, builtin?, slowInstallMs?}:
//   releases: path of a JSON file {claude: string[] | "error", codex: string[] | "error"}, read on every list()
//   counter: folder of the launch counters of the stubs; log: jsonl of source fetch calls
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli.ts";
import type { ReleaseSource } from "../../src/cli-agents/candidates.ts";
import type { PackageSource } from "../../src/cli-agents/pins.ts";
import { BUILTIN_RECORD } from "../../src/cli-agents/verified-record.ts";
import { loadEnv } from "../../src/store/env.ts";
import { applyProcessLanguage } from "../../src/store/preferences.ts";

const standEnv = loadEnv(process.env, process.cwd());
applyProcessLanguage(standEnv); // like council.ts: the language is set before main
const raw = process.env.CLI_CANDIDATES_STAND;
if (!raw) {
  console.error("The CLI_CANDIDATES_STAND variable is not set (JSON with releases, counter, log): this is the stand service entry.");
  process.exit(2);
}
const stand = JSON.parse(raw) as { releases: string; counter: string; log: string; builtin?: "claude-only"; slowInstallMs?: number };

const stubs = join(import.meta.dirname, "stubs");
const fixtures = join(import.meta.dirname, "../../src/cli-agents/fixtures");
type Variant = "full" | "no-tools" | "reworded" | "no-shell-tool";
const VARIANTS: Record<string, Variant> = { "claude@2.1.291": "no-tools", "codex@0.160.0": "reworded", "codex@0.161.0": "no-shell-tool" };
const files = (agent: string, variant: Variant): { HELP_FILE: string; FEATURES_FILE?: string } =>
  agent === "claude"
    ? { HELP_FILE: variant === "no-tools" ? join(stubs, "claude-no-tools-help.txt") : join(fixtures, "claude-2.1.288-help.txt") }
    : {
        HELP_FILE: variant === "reworded" ? join(stubs, "codex-reworded-help.txt") : join(fixtures, "codex-0.159.2-exec-help.txt"),
        FEATURES_FILE: variant === "no-shell-tool" ? join(stubs, "codex-no-shell-tool-features.txt") : join(fixtures, "codex-0.159.2-features.txt"),
      };
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const releases: ReleaseSource = {
  async list(agent) {
    const got = (JSON.parse(readFileSync(stand.releases, "utf8")) as Record<string, string[] | "error">)[agent];
    if (got === "error" || got === undefined) throw new Error("substitute release source failure");
    return got;
  },
};

const source: PackageSource = {
  async fetch(agent, version, dir, signal) {
    appendFileSync(stand.log, `${JSON.stringify({ agent, version, dir })}\n`);
    if (stand.slowInstallMs) {
      await new Promise<void>((res, rej) => {
        const timer = setTimeout(res, stand.slowInstallMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); rej(new Error("aborted")); }, { once: true });
        if (signal?.aborted) { clearTimeout(timer); rej(new Error("aborted")); }
      });
    }
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(stand.counter, { recursive: true });
    const exe = join(bin, agent);
    copyFileSync(join(stubs, agent), exe);
    chmodSync(exe, 0o755);
    const settings = { VERSION: version, COUNTER: join(stand.counter, `${agent}-${version}`), ...files(agent, VARIANTS[`${agent}@${version}`] ?? "full") };
    writeFileSync(join(bin, "stub.env"), `${Object.entries(settings).map(([k, v]) => `${k}=${q(v)}`).join("\n")}\n`);
    return { executable: exe, source: `stand:${agent}@${version}` };
  },
};

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), {
  stdout: console.log, stderr: console.error, env: standEnv, signal: controller.signal,
  chunk: (t) => process.stderr.write(t), appVersion: "0.0.0-stand",
  cliPin: { releases, source, ...(stand.builtin === "claude-only" ? { builtin: BUILTIN_RECORD.filter((e) => e.agent === "claude") } : {}) },
});
