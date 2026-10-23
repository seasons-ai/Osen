// Capture of the turn output of the claude and codex CLIs as anonymized fixtures (change 178):
//   COUNCIL_DEV=1 node packages/core/scenarios/cli-adapter-fixtures/capture.ts --stub [--out <dir>]
//   node packages/core/scenarios/cli-adapter-fixtures/capture.ts --real --max-calls 2 [--out <dir>] [--max-tokens <N>]
// --stub: stubs of both CLIs (personal data in their output), 0 model calls, writes into a new temporary folder by default.
// --real: ONE turn per agent through the real CLIs found as in a discussion (claude `haiku`, codex `default`);
//         spends the subscription, so it needs the owner's consent and an explicit --max-calls (at least 2). Writes into TURN_FIXTURE_DIR by default.
// Both modes: locate and inspect the CLI with inspectProvider, run one turn with createCliDriver (the same isolation arguments as a discussion),
// keep the raw output in a temporary folder outside git, anonymize it, verify the result and write <agent>-<version>-turn.<json|jsonl>.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseClaudeOutput, parseCodexOutput } from "../../src/cli-agents/output-parse.ts";
import { createCliDriver } from "../../src/cli-agents/driver.ts";
import { TURN_FIXTURE_DIR, anonymizeTurnOutput, findPersonalData, listTurnFixtures, turnFixtureName } from "../../src/cli-agents/turn-fixtures.ts";
import type { CliAgent, CliRuntime } from "../../src/cli-agents/types.ts";
import { collectSessionMaterials } from "../../src/materials.ts";
import { createSession } from "../../src/engine.ts";
import { setOcrRuntime } from "../../src/ocr/run.ts";
import { buildTurnPrompt } from "../../src/protocol/context.ts";
import { foldEvents } from "../../src/protocol/fold.ts";
import { inspectProvider } from "../../src/registry/providers.ts";
import type { Provider } from "../../src/registry/config.ts";
import { resolveDataDir } from "../../src/store/data-dir.ts";
import { INITIAL_MATERIALS } from "../../src/registry/config.ts";
import { BUILTIN_TEMPLATES_DIR, loadTemplates, templateSessionInput } from "../../src/templates/templates.ts";

const repo = resolve(import.meta.dirname, "../../../..");
const fixtureHelp = (name: string) => join(repo, "packages/core/src/cli-agents/fixtures", name);
const TOPIC = "Какие поля вывода CLI хода адаптер обязан читать строго, а какие может пропускать?";
const USAGE = "Usage: COUNCIL_DEV=1 node capture.ts --stub [--out <dir>]  |  node capture.ts --real --max-calls <N, at least 2> [--out <dir>] [--max-tokens <N>]";

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** Writes a `#!/bin/sh` stub of the claude or codex CLI: answers the inspection calls from the fixtures, prints the file `turn` for a turn. Never calls a model. */
export function writeCliStub(file: string, o: { agent: CliAgent; version: string; turn: string }): void {
  const body = o.agent === "claude"
    ? `case "$1" in
  --version) echo ${q(`${o.version} (Claude Code)`)} ;;
  --help) cat ${q(fixtureHelp("claude-2.1.288-help.txt"))} ;;
  *)
    read -r line
    case "$line" in
      *control_request*)
        id=$(printf '%s' "$line" | sed 's/.*"request_id":"\\([^"]*\\)".*/\\1/')
        printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"models":[{"value":"default"},{"value":"haiku"}]}}}\\n' "$id"
        exit 0 ;;
    esac
    cat > /dev/null; cat ${q(o.turn)} ;;
esac`
    : `case "$1" in
  --version) echo ${q(`codex-cli ${o.version}`)} ;;
  exec) if [ "$2" = "--help" ]; then cat ${q(fixtureHelp("codex-0.159.2-exec-help.txt"))}; else cat > /dev/null; cat ${q(o.turn)}; fi ;;
  features) cat ${q(fixtureHelp("codex-0.159.2-features.txt"))} ;;
  *) exit 2 ;;
esac`;
  writeFileSync(file, `#!/bin/sh\n${body}\nexit 0\n`);
  chmodSync(file, 0o755);
}

/** A login shell stand-in that prints only PATH (the CLI lookup must not run the owner's shell). */
export function writeFakeShell(file: string): void {
  writeFileSync(file, `#!/bin/sh\nprintf '\\n__COUNCIL_PATH__%s__COUNCIL_PATH__\\n' "$PATH"\n`);
  chmodSync(file, 0o755);
}

// raw output of the stubs: real-looking, with personal data the anonymizer must remove
const REPLY = {
  stance: "amend", reasoning: "The adapter reads /Users/alice/work/osen/README.md, contact alice@example.com, key sk-abcdefghijklmnopqrstuvwx.",
  solution: "Read the result event strictly; skip unknown fields.", answers: [], questions: [], files: [],
};
const SESSION = "3f2b8c1e-7a4d-4e6b-9c0a-1d2e3f4a5b6c";
const STUB_RAW: Record<CliAgent, string> = {
  claude: JSON.stringify({
    type: "result", subtype: "success", is_error: false, duration_ms: 4210, num_turns: 1, result: JSON.stringify(REPLY), session_id: SESSION,
    cwd: "/Users/alice/work/osen", total_cost_usd: 0.0123, usage: { input_tokens: 12, cache_creation_input_tokens: 3400, cache_read_input_tokens: 0, output_tokens: 187 },
    structured_output: REPLY,
  }) + "\n",
  codex: [
    { type: "thread.started", thread_id: SESSION },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Looking at /Users/alice/work/osen" } },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify(REPLY) } },
    { type: "turn.completed", usage: { input_tokens: 4210, cached_input_tokens: 3072, output_tokens: 96 } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n",
};
const STUB_VERSION: Record<CliAgent, string> = { claude: "2.1.288", codex: "0.159.2" };

function buildPrompt(participants: { providerId: string; model: string }[], maxTotalTokens: number | undefined): { prompt: string; note: string } {
  const catalog = loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: join(tmpdir(), "osen-no-user-templates") });
  const defaults = { maxRounds: 1, turnTimeoutSec: 300, contextChars: 24000, materialsChars: INITIAL_MATERIALS.materialsChars, ...(maxTotalTokens ? { maxTotalTokens } : {}) };
  const input = templateSessionInput({
    catalog, topic: TOPIC, origin: "cli", limits: {}, defaults,
    participants: participants.map((p, i) => ({ name: `P${i + 1}`, providerId: p.providerId, model: p.model })),
  });
  let note = "material: repository root";
  let set;
  try {
    set = collectSessionMaterials([repo], { materialsChars: defaults.materialsChars, materialsIgnore: INITIAL_MATERIALS.materialsIgnore });
  } catch {
    // the folder is over the snapshot limit: pass the README only
    note = "material: README.md only (the repository root is over the snapshot limit)";
    set = collectSessionMaterials([join(repo, "README.md")], { materialsChars: defaults.materialsChars, materialsIgnore: INITIAL_MATERIALS.materialsIgnore });
  }
  const session = createSession({ ...input, materials: set.materials, ...(set.workspace.length ? { workspace: set.workspace } : {}) }, { maxParticipants: 8 });
  const state = foldEvents([{ type: "session_created", seq: 1, ts: new Date().toISOString(), session, pid: process.pid }]);
  return { prompt: buildTurnPrompt(state, "p1", set.materials, set.workspace.length ? { folder: set.workspace } : {}), note };
}

async function main(argv: string[]): Promise<number> {
  const fail = (m: string) => { console.error(`${m}\n${USAGE}`); return 2; };
  let values;
  try {
    ({ values } = parseArgs({ args: argv, strict: true, options: {
      stub: { type: "boolean" }, real: { type: "boolean" }, "max-calls": { type: "string" }, out: { type: "string" }, "max-tokens": { type: "string" },
    } }));
  } catch (e) { return fail((e as Error).message); }
  if (values.stub === values.real) return fail("Exactly one of --stub and --real is required.");
  const stub = values.stub === true;
  const num = (v: string | undefined) => (v !== undefined && /^[1-9]\d*$/.test(v) ? Number(v) : undefined);
  const maxCalls = num(values["max-calls"]);
  if (!stub && (maxCalls === undefined || maxCalls < 2)) return fail("--real needs an explicit --max-calls of at least 2 (one call per agent).");
  if (values["max-tokens"] !== undefined && num(values["max-tokens"]) === undefined) return fail("--max-tokens must be a positive integer.");
  if (stub && process.env.COUNCIL_DEV !== "1") return fail("--stub needs COUNCIL_DEV=1.");

  const work = mkdtempSync(join(tmpdir(), "osen-fixture-capture-"));
  const rawDir = join(work, "raw");
  mkdirSync(rawDir);
  const outDir = resolve(values.out ?? (stub ? join(work, "out") : TURN_FIXTURE_DIR));
  if (stub && outDir === TURN_FIXTURE_DIR) return fail("--stub must not write into the repository fixtures folder.");
  const bin = join(work, "bin");
  let env: Record<string, string | undefined> = process.env;
  let dataDir: string | undefined = resolveDataDir(process.env);
  if (stub) {
    mkdirSync(bin);
    writeFakeShell(join(bin, "fake-shell"));
    for (const agent of ["claude", "codex"] as const) {
      writeFileSync(join(work, `${agent}-turn.raw`), STUB_RAW[agent]);
      writeCliStub(join(bin, agent), { agent, version: STUB_VERSION[agent], turn: join(work, `${agent}-turn.raw`) });
    }
    env = { PATH: `${bin}:/usr/bin:/bin`, SHELL: join(bin, "fake-shell"), HOME: work, COUNCIL_DEV: "1" };
    dataDir = join(work, "data");
  }
  mkdirSync(outDir, { recursive: true });

  const agents: { agent: CliAgent; model: string }[] = [{ agent: "claude", model: "haiku" }, { agent: "codex", model: "default" }];
  // the material only builds a prompt of a realistic size: images of the repository root are skipped as "no helper" instead of starting osen-ocr for each (change 217)
  setOcrRuntime({ helper: join(work, "no-ocr-helper") });
  const { prompt, note } = buildPrompt(agents.map((a) => ({ providerId: a.agent, model: a.model })), num(values["max-tokens"]));
  console.log(`mode: ${stub ? "stub" : "real"}; ${note}; prompt ${prompt.length} chars; raw output folder: ${rawDir}`);

  let calls = 0, failed = false;
  for (const { agent, model } of agents) {
    const provider: Provider = { id: agent, kind: "cli", label: agent, agent, models: [] };
    const found = await inspectProvider(provider, { env: env as Record<string, string | undefined>, withModels: false, dataDir });
    const runtime: CliRuntime | undefined = found.runtime;
    if (!runtime) { console.error(`${agent}: unavailable: ${found.status.reason ?? "unknown reason"}`); failed = true; continue; }
    if (!runtime.version) { console.error(`${agent}: the CLI version is unknown, no fixture name`); failed = true; continue; }
    if (!stub && calls >= maxCalls!) { console.error(`${agent}: --max-calls ${maxCalls} reached`); failed = true; continue; }
    let raw: { stdout: string; stderr: string; exitCode: number | null } | undefined;
    const driver = createCliDriver(runtime, { onOutput: (r) => { raw = r; } });
    if (!stub) calls++;
    try {
      await driver.call({
        participant: { id: "p1", name: "P1", providerId: agent, model, role: null }, prompt, language: "ru", timeoutSec: 300,
        signal: AbortSignal.timeout(300_000), onChunk: () => {},
      });
    } catch (e) {
      console.error(`${agent}: the turn failed: ${(e as Error).message}`);
      failed = true;
      continue;
    }
    if (!raw) { console.error(`${agent}: no raw output captured`); failed = true; continue; }
    const rawFile = join(rawDir, `${agent}-${runtime.version}-turn.raw`);
    writeFileSync(rawFile, raw.stdout);
    const anon = anonymizeTurnOutput(agent, raw.stdout);
    const kinds = findPersonalData(anon);
    if (kinds.length > 0) { console.error(`${agent}: personal data left after anonymization (${kinds.join(", ")}); nothing written`); failed = true; continue; }
    const parsed = agent === "claude" ? parseClaudeOutput(anon, runtime.version) : parseCodexOutput(anon, runtime.version);
    if (!parsed.ok) { console.error(`${agent}: the anonymized output does not parse: ${parsed.diagnostic}`); failed = true; continue; }
    const name = turnFixtureName(agent, runtime.version, false);
    writeFileSync(join(outDir, name), anon);
    const synthetic = listTurnFixtures(outDir).find((f) => f.agent === agent && f.version === runtime.version && f.synthetic);
    if (synthetic) rmSync(synthetic.file);
    console.log(`${agent} ${runtime.version}: wrote ${join(outDir, name)}${synthetic ? " (replaced the synthetic file)" : ""}; anonymization: ok`);
  }
  console.log(stub ? "0 model calls" : `${calls} model calls`);
  return failed ? 1 : 0;
}

// ponytail: a path comparison decides "run as a script"; a symlinked invocation path would skip main
if (process.argv[1] && existsSync(process.argv[1]) && resolve(process.argv[1]) === import.meta.filename) process.exitCode = await main(process.argv.slice(2));
