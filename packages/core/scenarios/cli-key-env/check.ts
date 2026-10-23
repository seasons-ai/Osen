// Check of change 238: variables that come only from a .env file (cwd or data folder) do not reach CLI processes (claude, codex),
// while shell variables do and HTTP providers still get their key. Real council and MCP processes over stdio, claude and codex stubs
// that log the NAMES of their environment variables on every launch, a local fake HTTP server, 0 model calls, no network:
//   COUNCIL_DEV=1 node packages/core/scenarios/cli-key-env/check.ts
// Data lives in COUNCIL_HOME (must be inside the repository) or in <repository>/.council-data/cli-key-env-*;
// deleted on success (unless COUNCIL_HOME was given), kept on failure. The stand does not import cliEnv, so it also runs on the old code.
// Children get PATH = the stand bin folder + /usr/bin:/bin, so the real claude and codex are never launched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeServer } from "../../src/http/fake-server.ts";
import { locateCli } from "../../src/cli-agents/discovery.ts";
import { loadEnv } from "../../src/store/env.ts";
import { isInsideRepo } from "../inside-repo.ts";
import { writeStub } from "../launch-guard/stub.ts";
import { parseLog, writeLoggingWrapper } from "./stubs.ts";
import type { LaunchRecord } from "./stubs.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/core/scenarios/cli-key-env/check.ts");
  process.exit(2);
}
const KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const FILE_VALUES = { OPENAI_API_KEY: "file-openai-dummy", ANTHROPIC_API_KEY: "file-anthropic-dummy" };
// the stand process must not hold the keys itself: they would count as shell variables for step 6
for (const k of KEYS) delete process.env[k];

const repo = resolve(import.meta.dirname, "../../../..");
const council = join(repo, "packages/core/src/council.ts");
const entry = join(import.meta.dirname, "council-test.ts");
const mcpMain = join(repo, "packages/mcp/src/main.ts");
const given = process.env.COUNCIL_HOME ? resolve(process.env.COUNCIL_HOME) : undefined;
if (given && !isInsideRepo(repo, given)) {
  console.error(`COUNCIL_HOME must be inside the repository (${repo}): ${given}`);
  process.exit(2);
}
const work = given ?? join(repo, ".council-data", `cli-key-env-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(work, { recursive: true });

interface Home { dir: string; data: string; cwd: string; bin: string; log: string; shell: string }
/** A fresh data folder with a .env holding both keys, an empty working folder and claude and codex stubs that log their environment names. */
function home(name: string): Home {
  const dir = join(work, name);
  const h: Home = { dir, data: join(dir, "data"), cwd: join(dir, "cwd"), bin: join(dir, "bin"), log: join(dir, "stub.log"), shell: join(dir, "bin", "fake-shell") };
  for (const d of [h.data, h.cwd, h.bin, join(dir, "home")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(h.data, ".env"), KEYS.map((k) => `${k}=${FILE_VALUES[k]}\n`).join(""));
  writeFileSync(h.log, "");
  // the login-shell lookup must not run the owner's shell: a stub shell that prints PATH only
  writeFileSync(h.shell, `#!/bin/sh\nprintf '\\n__COUNCIL_PATH__%s__COUNCIL_PATH__\\n' "$PATH"\n`);
  chmodSync(h.shell, 0o755);
  const marks = join(dir, "marks");
  mkdirSync(marks, { recursive: true });
  for (const [agent, version] of [["claude", "1.0.0"], ["codex", "3.0.0"]] as const) {
    const real = join(h.bin, `${agent}.real`);
    writeStub(real, { agent, version, mark: join(marks, agent), side: join(marks, `side-${agent}`) });
    writeLoggingWrapper(join(h.bin, agent), real, agent, h.log);
  }
  return h;
}
const env = (h: Home, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: `${h.bin}:/usr/bin:/bin`, HOME: join(h.dir, "home"), SHELL: h.shell, COUNCIL_HOME: h.data, COUNCIL_DEV: "1", COUNCIL_LANG: "en", FROM_SHELL: "1", ...extra,
});
const records = (h: Home): LaunchRecord[] => parseLog(readFileSync(h.log, "utf8"));

interface Result { code: number; out: string; err: string }
function run(h: Home, script: string, args: string[], extra: Record<string, string> = {}, stand?: object): Promise<Result> {
  return new Promise((res, rej) => {
    const e = env(h, { ...extra, ...(stand ? { CLI_KEY_ENV_STAND: JSON.stringify(stand) } : {}) });
    const child = spawn(process.execPath, [script, ...args], { env: e, cwd: h.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => { child.kill("SIGKILL"); rej(new Error(`timeout: council ${args.join(" ")}`)); }, 120_000);
    child.on("close", (code) => { clearTimeout(timer); res({ code: code ?? -1, out, err }); });
  });
}
const all = (r: Result) => `${r.out}\n${r.err}`;

/** Every record lacks the given names; returns the names found in a record (for the message). */
function assertNoKeys(recs: LaunchRecord[], what: string): void {
  assert.ok(recs.length > 0, `${what}: the stubs were never launched`);
  for (const r of recs) {
    const leaked = KEYS.filter((k) => r.names.includes(k));
    assert.deepEqual(leaked, [], `${what}: ${r.agent} ${r.kind} (${r.args.slice(0, 40)}) got ${leaked.join(", ")}`);
    assert.ok(r.names.includes("FROM_SHELL") && r.names.includes("PATH"), `${what}: ${r.agent} ${r.kind} lacks FROM_SHELL or PATH`);
  }
}
function assertKinds(recs: LaunchRecord[], what: string): void {
  for (const kind of ["version", "help", "features", "turn"] as const) assert.ok(recs.some((r) => r.kind === kind), `${what}: no ${kind} launch recorded`);
  for (const agent of ["claude", "codex"]) assert.ok(recs.some((r) => r.agent === agent && r.kind === "turn"), `${what}: no ${agent} turn`);
  for (const r of recs.filter((x) => x.kind === "turn")) assert.ok(r.names.includes("COUNCIL_PARTICIPANT"), `${what}: a ${r.agent} turn lacks COUNCIL_PARTICIPANT`);
}
async function providersAndDiscussion(h: Home, extra: Record<string, string>): Promise<void> {
  const p = await run(h, council, ["providers", "--json"], extra);
  assert.equal(p.code, 0, all(p));
  const d = await run(h, council, ["--topic", "Check the CLI environment", "--participant", "claude", "--participant", "codex", "--max-rounds", "2"], extra);
  assert.ok([0, 3].includes(d.code), `discussion exit code ${d.code}: ${all(d)}`);
}

let failed = 0;
const fakes: Awaited<ReturnType<typeof startFakeServer>>[] = [];
async function step(name: string, f: () => Promise<void>): Promise<void> {
  try { await f(); console.log(`PASS ${name}`); } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n  ${(e instanceof Error ? e.message : String(e)).slice(0, 1200).replace(/\n/g, "\n  ")}`);
  }
}

await step("1. keys only in .env: providers and a discussion launch the stubs without OPENAI_API_KEY and ANTHROPIC_API_KEY", async () => {
  const h = home("s1");
  await providersAndDiscussion(h, {});
  assertKinds(records(h), "step 1");
  assertNoKeys(records(h), "step 1");
});

await step("2. OPENAI_API_KEY also in the shell environment: it reaches the stubs, ANTHROPIC_API_KEY (file only) does not", async () => {
  const h = home("s2");
  await providersAndDiscussion(h, { OPENAI_API_KEY: "shell-value" });
  const recs = records(h);
  assertKinds(recs, "step 2");
  for (const r of recs) {
    assert.ok(r.names.includes("OPENAI_API_KEY"), `${r.agent} ${r.kind}: the shell OPENAI_API_KEY is missing`);
    assert.ok(!r.names.includes("ANTHROPIC_API_KEY"), `${r.agent} ${r.kind}: ANTHROPIC_API_KEY leaked from .env`);
  }
});

/** Adds the fake HTTP provider with apiKeyEnv OPENAI_API_KEY to the config.json that `providers` has written. */
function addFakeProvider(h: Home, url: string): void {
  const file = join(h.data, "config.json");
  const cfg = JSON.parse(readFileSync(file, "utf8")) as { providers: object[] };
  cfg.providers.push({ id: "fake", kind: "openai-http", label: "Fake", models: [], baseUrl: url, apiKeyEnv: "OPENAI_API_KEY" });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
}
const fakeStatus = (out: string): { available?: boolean; reason?: string } | undefined => {
  const find = (v: unknown): { available?: boolean; reason?: string } | undefined => {
    if (Array.isArray(v)) { for (const x of v) { const f = find(x); if (f) return f; } return undefined; }
    if (v && typeof v === "object") {
      if ((v as { id?: unknown }).id === "fake") return v as never;
      for (const x of Object.values(v)) { const f = find(x); if (f) return f; }
    }
    return undefined;
  };
  return find(JSON.parse(out) as unknown);
};

await step("3. HTTP provider with apiKeyEnv OPENAI_API_KEY: available, the key from .env reaches the fake server", async () => {
  const h = home("s3");
  const srv = await startFakeServer({ apiKey: FILE_VALUES.OPENAI_API_KEY });
  fakes.push(srv);
  assert.equal((await run(h, council, ["providers", "--json"])).code, 0);
  addFakeProvider(h, srv.url);
  const r = await run(h, council, ["providers", "--json"]);
  assert.equal(r.code, 0, all(r));
  const s = fakeStatus(r.out);
  assert.ok(s?.available === true, `fake provider: ${JSON.stringify(s)}`);
  assert.ok(srv.requests.length > 0 && srv.requests.every((q) => q.authorization === `Bearer ${FILE_VALUES.OPENAI_API_KEY}`), `authorization headers: ${JSON.stringify(srv.requests.map((q) => q.authorization))}`);
  assertNoKeys(records(h), "step 3 (CLI stubs)");
});

await step("4. cli candidates and cli accept with the same .env: the stubs get no keys", async () => {
  const h = home("s4");
  const log = join(h.dir, "candidates.log");
  writeFileSync(log, "");
  const stand = { log };
  const c = await run(h, entry, ["cli", "candidates", "--json"], {}, stand);
  assert.equal(c.code, 0, all(c));
  assert.ok(JSON.parse(c.out).candidates.some((x: { agent: string; version: string }) => x.agent === "codex" && x.version === "9.9.9"), `no codex 9.9.9 candidate: ${c.out.slice(0, 400)}`);
  const afterCandidates = parseLog(readFileSync(log, "utf8"));
  assert.ok(afterCandidates.length > 0, "candidate check never launched the stub");
  const i = await run(h, entry, ["cli", "install", "codex", "--version", "9.9.9", "--candidate"], {}, stand);
  assert.equal(i.code, 0, all(i));
  const a = await run(h, entry, ["cli", "accept", "codex", "9.9.9", "--candidate", "--max-calls", "7"], {}, stand);
  assert.equal(a.code, 0, all(a));
  const recs = parseLog(readFileSync(log, "utf8"));
  assert.ok(recs.filter((r) => r.kind === "turn").length >= 7, "the acceptance probes did not launch the stub");
  assertNoKeys(recs, "step 4");
});

type Tool = { isError?: boolean; content: { text: string }[] };
await step("5. MCP council_start: the detached executor launches the stubs without keys, the HTTP provider still sees the key", async () => {
  const h = home("s5");
  const srv = await startFakeServer({ apiKey: FILE_VALUES.OPENAI_API_KEY });
  fakes.push(srv);
  assert.equal((await run(h, council, ["providers", "--json"])).code, 0);
  addFakeProvider(h, srv.url);
  const client = new Client({ name: "cli-key-env-check", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [mcpMain], cwd: h.cwd, stderr: "ignore", env: env(h) }));
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as Tool;
      return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
    };
    const opts = await call("council_options", {});
    assert.ok(!opts.isError, opts.text);
    const fake = fakeStatus(opts.text);
    assert.ok(fake?.available === true, `fake provider in council_options: ${JSON.stringify(fake)}`);
    assert.ok(srv.requests.length > 0 && srv.requests.every((q) => q.authorization === `Bearer ${FILE_VALUES.OPENAI_API_KEY}`), "the HTTP provider did not send the .env key");
    const modelOf = (id: string): string => {
      const find = (v: unknown): { models?: unknown[] } | undefined => {
        if (Array.isArray(v)) { for (const x of v) { const f = find(x); if (f) return f; } return undefined; }
        if (v && typeof v === "object") { if ((v as { id?: unknown }).id === id) return v as never; for (const x of Object.values(v)) { const f = find(x); if (f) return f; } }
        return undefined;
      };
      const m = find(JSON.parse(opts.text) as unknown)?.models?.[0];
      return typeof m === "string" ? m : ((m as { id?: string; value?: string } | undefined)?.id ?? (m as { value?: string } | undefined)?.value ?? "default");
    };
    const start = await call("council_start", { topic: "Check the CLI environment", participants: [{ providerId: "claude", model: modelOf("claude") }, { providerId: "codex", model: modelOf("codex") }], maxRounds: 2 });
    assert.ok(!start.isError, start.text);
    const id = (JSON.parse(start.text) as { sessionId: string }).sessionId;
    let status = "running";
    for (const t0 = Date.now(); status === "running" && Date.now() - t0 < 90_000;) {
      status = (JSON.parse((await call("council_status", { sessionId: id, waitSec: 5 })).text) as { status: string }).status;
    }
    assert.notEqual(status, "running", "the session did not finish");
  } finally { await client.close(); }
  const recs = records(h);
  assert.ok(recs.some((r) => r.kind === "turn"), "no turn launched by the detached executor");
  assertNoKeys(recs, "step 5");
});

await step("6. locateCli called like the app does, with env merged from .env: the --version launch lacks the keys", async () => {
  const h = home("s6");
  const merged = loadEnv({ ...env(h) }, h.cwd);
  for (const k of KEYS) assert.equal(merged[k], FILE_VALUES[k], `the merged env must hold ${k} (otherwise the step proves nothing)`);
  for (const agent of ["claude", "codex"] as const) {
    const loc = await locateCli(agent, { env: merged, dataDir: h.data });
    assert.ok(loc.found || (loc as { path?: string }).path, `${agent} not located: ${JSON.stringify(loc).slice(0, 300)}`);
  }
  const recs = records(h);
  assert.ok(recs.some((r) => r.agent === "claude" && r.kind === "version") && recs.some((r) => r.agent === "codex" && r.kind === "version"), "no --version launches recorded");
  assertNoKeys(recs.filter((r) => r.kind === "version"), "step 6");
});

for (const f of fakes) await f.close();
if (failed === 0) {
  console.log("PASS all steps");
  if (!given && existsSync(work)) rmSync(work, { recursive: true, force: true });
  process.exit(0);
}
console.log(`FAIL ${failed} step(s); data kept at ${work}`);
process.exit(1);
