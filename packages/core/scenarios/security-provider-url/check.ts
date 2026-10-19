// Check of "Bounded provider base URL normalization" (CodeQL js/polynomial-redos in inspectHttp), 0 model calls:
//   COUNCIL_DEV=1 node packages/core/scenarios/security-provider-url/check.ts [--mutant]
// 1. Direct probe: probe.ts inspects a no-key openai-http provider (withModels: false) whose base URL has 1,048,576 slashes
//    before 'x', in a child with a 5,000 ms watchdog; the median of three samples must be <= 1,000 ms.
//    Sizes 1,024, 4,096 and 16,384 are printed as diagnostics.
// 2. Real `council providers --json` (COUNCIL_LANG=en, 30 s watchdog) against a local model-list stand:
//    4,096 internal slashes before 'x' reach the stand unchanged; '/v1///' reaches it as '/v1/models'.
// --mutant: the probe runs on a copy of packages/core/src with the reported expression restored; the stand must exit nonzero.
// The stand creates .council-data/security-3-* itself and deletes it on success.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

if (process.env.COUNCIL_DEV !== "1") { console.error("COUNCIL_DEV=1 is required. Usage: COUNCIL_DEV=1 node packages/core/scenarios/security-provider-url/check.ts [--mutant]"); process.exit(2); }
const mutant = process.argv.includes("--mutant");
const repo = resolve(import.meta.dirname, "../../../..");
const core = join(repo, "packages/core");
const work = join(repo, ".council-data", `security-3-${Date.now()}`);
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
let providersModule = join(core, "src/registry/providers.ts");
if (mutant) {
  const copy = join(work, "mutant-src");
  cpSync(join(core, "src"), copy, { recursive: true });
  providersModule = join(copy, "registry/providers.ts");
  const source = readFileSync(providersModule, "utf8");
  const restored = source.replace("const baseUrl = trimTrailingSlashes(provider.baseUrl);", "const baseUrl = provider.baseUrl.replace(/\\/+$/, \"\");");
  check("mutation copy restores the reported expression", restored !== source && restored.includes("provider.baseUrl.replace(/\\/+$/, \"\")"));
  writeFileSync(providersModule, restored);
}
const N = 1_048_576;
const probe = await supervised(process.execPath, [join(import.meta.dirname, "probe.ts"), providersModule, String(N), "1024,4096,16384"], 5_000);
if (probe.ok) {
  const r = JSON.parse(probe.stdout) as { n: number; samples: number[]; median: number; diagnostics: Array<{ n: number; ms: number }>; node: string; platform: string; arch: string; cpu: string };
  console.log(`       n=${r.n} samples=${r.samples.map((s) => s.toFixed(3)).join(",")} ms median=${r.median.toFixed(3)} ms child=${probe.ms.toFixed(0)} ms`);
  console.log(`       diagnostics ${r.diagnostics.map((d) => `n=${d.n}:${d.ms.toFixed(3)}ms`).join(" ")}; node ${r.node} ${r.platform}/${r.arch} ${r.cpu}`);
  check(`probe median <= 1,000 ms at n=${N}`, r.n === N && r.samples.length === 3 && r.median <= 1_000, `median ${r.median} ms`);
} else {
  check(`probe child finishes before the 5,000 ms watchdog at n=${N}`, false, `${probe.why}; supervisor stayed responsive, child settled after ${probe.ms.toFixed(0)} ms`);
}

// ---------- 2. real council providers against a local model-list stand ----------
if (!mutant) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "stand-model" }] }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function providers(name: string, baseUrl: string) {
    const home = join(work, name);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      providers: [{ id: "stand", kind: "openai-http", label: "Local stand", models: [], baseUrl, apiKeyEnv: "" }],
      defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, participants: [] },
    }, null, 2));
    seen.length = 0;
    const r = await supervised(process.execPath, [join(core, "src/council.ts"), "providers", "--json"], 30_000,
      { HOME: home, COUNCIL_DEV: "1", COUNCIL_HOME: home, COUNCIL_LANG: "en" });
    if (!r.ok) { check(`${name}: council providers finishes within 30 s`, false, r.why); return undefined; }
    const parsed = JSON.parse(r.stdout) as { providers?: Array<{ id: string; available: boolean; baseUrl?: string; models: string[]; modelsConfirmed: boolean }> };
    const stand = (parsed.providers ?? (parsed as unknown as NonNullable<typeof parsed.providers>)).find((p) => p.id === "stand");
    console.log(`       ${name} (${r.ms.toFixed(0)} ms): available=${stand?.available} models=${stand?.models.join(",")} baseUrl length=${stand?.baseUrl?.length} stand saw ${seen.map((u) => `${u.slice(0, 24)}${u.length > 24 ? `… (${u.length} chars)` : ""}`).join(", ")}`);
    return { stand, seen: [...seen] };
  }

  try {
    const internal = `${origin}${"/".repeat(4_096)}x`;
    const a = await providers("internal-slashes", internal);
    if (a) check("4,096 internal slashes: provider available with the stand model, URL and request path unchanged",
      a.stand?.available === true && a.stand.models.join() === "stand-model" && a.stand.modelsConfirmed && a.stand.baseUrl === internal
        && a.seen.length === 1 && a.seen[0] === `${"/".repeat(4_096)}x/models`, JSON.stringify({ ...a.stand, baseUrl: a.stand?.baseUrl?.length, seen: a.seen.map((u) => u.length) }));

    const b = await providers("trailing-slashes", `${origin}/v1///`);
    if (b) check("trailing '/v1///': status shows .../v1 and the stand sees /v1/models",
      b.stand?.available === true && b.stand.baseUrl === `${origin}/v1` && b.seen.join() === "/v1/models", JSON.stringify({ ...b.stand, seen: b.seen }));
  } finally {
    await new Promise((done) => server.close(done));
  }
}

console.log(`${failed ? "FAIL" : "PASS"} Bounded provider base URL normalization${mutant ? " (mutant)" : ""}: ${total - failed}/${total} checks`);
if (failed) { console.log(`       data kept in ${work}`); process.exit(1); }
rmSync(work, { recursive: true, force: true });
