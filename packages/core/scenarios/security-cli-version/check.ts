// Check of "Bounded CLI version extraction" (CodeQL js/polynomial-redos in parseVersion), 0 model calls:
//   COUNCIL_DEV=1 node packages/core/scenarios/security-cli-version/check.ts [--mutant]
// 1. Direct probe: probe.ts times parseVersion on '9'.repeat(1,048,576) in a child with a 5,000 ms watchdog;
//    the median of three samples must be <= 1,000 ms. Sizes 1,024, 4,096 and 16,384 are printed as diagnostics.
// 2. Real `council providers --json` (COUNCIL_LANG=en, 30 s watchdog) with claude and codex stubs registered by absolute path:
//    16,384 digits from --version -> unknown-version warning; VERIFIED_VERSIONS endpoints -> no warning; derived older/newer -> warnings.
// --mutant: the probe runs on a copy of packages/core/src with the reported expression restored; the stand must exit nonzero.
// The stand creates .council-data/security-1-* itself and deletes it on success.
import { execFile } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { VERIFIED_VERSIONS } from "../../src/cli-agents/discovery.ts";

if (process.env.COUNCIL_DEV !== "1") { console.error("COUNCIL_DEV=1 is required. Usage: COUNCIL_DEV=1 node packages/core/scenarios/security-cli-version/check.ts [--mutant]"); process.exit(2); }
const mutant = process.argv.includes("--mutant");
const repo = resolve(import.meta.dirname, "../../../..");
const core = join(repo, "packages/core");
const fixtures = join(core, "src/cli-agents/fixtures");
const work = join(repo, ".council-data", `security-1-${Date.now()}`);
mkdirSync(work, { recursive: true });
const run = promisify(execFile);

let total = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n       ${detail.slice(0, 500)}` : ""}`);
}

async function supervised(file: string, args: string[], timeout: number, env: Record<string, string> = {}) {
  const started = performance.now();
  const pending = run(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...env } });
  pending.child.stdin?.end();
  try {
    const { stdout } = await pending;
    return { ok: true as const, stdout, ms: performance.now() - started };
  } catch (e) {
    const err = e as { killed?: boolean; signal?: string; message: string };
    return { ok: false as const, why: err.killed ? `watchdog ${timeout} ms exceeded (${err.signal})` : err.message, ms: performance.now() - started };
  }
}

// ---------- 1. direct probe ----------
let discovery = join(core, "src/cli-agents/discovery.ts");
if (mutant) {
  const copy = join(work, "mutant-src");
  cpSync(join(core, "src"), copy, { recursive: true });
  discovery = join(copy, "cli-agents/discovery.ts");
  const source = readFileSync(discovery, "utf8");
  const restored = source.replace(/export function parseVersion\(raw: string\): string \| undefined \{\n[\s\S]*?\n\}\n/, "export function parseVersion(raw: string): string | undefined {\n  return raw.match(/\\d+\\.\\d+\\.\\d+/)?.[0];\n}\n");
  check("mutation copy restores the reported expression", restored !== source && restored.includes("raw.match(/\\d+\\.\\d+\\.\\d+/)"));
  writeFileSync(discovery, restored);
}
const N = 1_048_576;
const probe = await supervised(process.execPath, [join(import.meta.dirname, "probe.ts"), discovery, String(N), "1024,4096,16384"], 5_000);
if (probe.ok) {
  const r = JSON.parse(probe.stdout) as { n: number; samples: number[]; median: number; diagnostics: Array<{ n: number; ms: number }>; node: string; platform: string; arch: string; cpu: string };
  console.log(`       n=${r.n} samples=${r.samples.map((s) => s.toFixed(2)).join(",")} ms median=${r.median.toFixed(2)} ms child=${probe.ms.toFixed(0)} ms`);
  console.log(`       diagnostics ${r.diagnostics.map((d) => `n=${d.n}:${d.ms.toFixed(3)}ms`).join(" ")}; node ${r.node} ${r.platform}/${r.arch} ${r.cpu}`);
  check(`probe median <= 1,000 ms at n=${N}`, r.n === N && r.samples.length === 3 && r.median <= 1_000, `median ${r.median} ms`);
} else {
  check(`probe child finishes before the 5,000 ms watchdog at n=${N}`, false, `${probe.why}; supervisor stayed responsive, child settled after ${probe.ms.toFixed(0)} ms`);
}

// ---------- 2. real council providers ----------
if (!mutant) {
  const claudeHelp = join(fixtures, "claude-2.1.288-help.txt");
  const codexHelp = join(fixtures, "codex-0.159.2-exec-help.txt");
  const codexFeatures = join(fixtures, "codex-0.159.2-features.txt");
  const stub = (versionLine: string) => `#!${process.execPath}
import fs from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "--version") { process.stdout.write(${versionLine} + "\\n"); process.exit(0); }
if (a[0] === "--help") { process.stdout.write(fs.readFileSync(${JSON.stringify(claudeHelp)})); process.exit(0); }
if (a[0] === "exec" && a[1] === "--help") { process.stdout.write(fs.readFileSync(${JSON.stringify(codexHelp)})); process.exit(0); }
if (a[0] === "features" && a[1] === "list") { process.stdout.write(fs.readFileSync(${JSON.stringify(codexFeatures)})); process.exit(0); }
process.exit(2);
`;
  const bump = (v: string, d: number) => { const p = v.split(".").map(Number); p[2] += d; return p[2] < 0 ? undefined : p.join("."); };

  async function providers(name: string, claudeLine: string, codexLine: string) {
    const dir = join(work, name);
    const bin = join(dir, "bin");
    const home = join(dir, "home");
    mkdirSync(bin, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(bin, "claude"), stub(claudeLine));
    writeFileSync(join(bin, "codex"), stub(codexLine));
    writeFileSync(join(bin, "empty-shell"), "#!/bin/sh\nexit 0\n");
    for (const f of ["claude", "codex", "empty-shell"]) chmodSync(join(bin, f), 0o755);
    writeFileSync(join(home, "config.json"), JSON.stringify({
      providers: [
        { id: "claude", kind: "cli", agent: "claude", label: "Claude stub", models: ["m"], path: join(bin, "claude") },
        { id: "codex", kind: "cli", agent: "codex", label: "Codex stub", models: ["m"], path: join(bin, "codex") },
      ],
      defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, participants: [] },
    }, null, 2));
    const r = await supervised(process.execPath, [join(core, "src/council.ts"), "providers", "--json"], 30_000,
      { PATH: bin, SHELL: join(bin, "empty-shell"), HOME: dir, COUNCIL_DEV: "1", COUNCIL_HOME: home, COUNCIL_LANG: "en" });
    if (!r.ok) { check(`${name}: council providers finishes within 30 s`, false, r.why); return undefined; }
    const list = (JSON.parse(r.stdout) as { providers?: Array<{ id: string; version?: string; warning?: string }> }).providers
      ?? (JSON.parse(r.stdout) as Array<{ id: string; version?: string; warning?: string }>);
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    console.log(`       ${name} (${r.ms.toFixed(0)} ms): ${list.map((p) => `${p.id} version=${p.version ?? "-"} warning=${p.warning ? JSON.stringify(p.warning.slice(0, 120)) : "-"}`).join("; ")}`);
    return byId;
  }

  const long = await providers("long-digits", `"9".repeat(16384)`, `"codex-cli ${VERIFIED_VERSIONS.codex[1]}"`);
  if (long) check("16,384 digits: claude has no version and an unknown-version warning",
    long.claude?.version == null && (long.claude?.warning ?? "").startsWith("Could not determine the version of claude"), JSON.stringify(long.claude).slice(0, 300));

  for (const [label, end] of [["min", 0], ["max", 1]] as const) {
    const c = VERIFIED_VERSIONS.claude[end], x = VERIFIED_VERSIONS.codex[end];
    const r = await providers(`verified-${label}`, `"${c} (Claude Code)"`, `"codex-cli ${x}"`);
    if (r) check(`verified ${label} endpoints: versions printed, no range warning`,
      r.claude?.version === c && r.codex?.version === x && !r.claude?.warning && !r.codex?.warning, JSON.stringify(r.claude).slice(0, 300));
  }

  const older = bump(VERIFIED_VERSIONS.claude[0], -1), newer = bump(VERIFIED_VERSIONS.claude[1], 1)!;
  const n = await providers("newer", `"${newer} (Claude Code)"`, `"codex-cli ${VERIFIED_VERSIONS.codex[1]}"`);
  if (n) check(`derived newer ${newer}: newer-range warning`, n.claude?.version === newer && (n.claude?.warning ?? "").includes("is newer than the verified range"));
  if (older) {
    const o = await providers("older", `"${older} (Claude Code)"`, `"codex-cli ${VERIFIED_VERSIONS.codex[1]}"`);
    if (o) check(`derived older ${older}: older-range warning`, o.claude?.version === older && (o.claude?.warning ?? "").includes("is older than the verified range"));
  } else console.log("       older fixture skipped: the verified minimum has patch 0");
}

console.log(`${failed ? "FAIL" : "PASS"} Bounded CLI version extraction${mutant ? " (mutant)" : ""}: ${total - failed}/${total} checks`);
if (failed) { console.log(`       data kept in ${work}`); process.exit(1); }
rmSync(work, { recursive: true, force: true });
