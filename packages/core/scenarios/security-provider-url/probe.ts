// Child side of the "Bounded provider base URL normalization" probe: run only under a supervisor with a finite timeout.
//   node probe.ts <path to providers.ts> <n> [diagnostic sizes, comma separated]
// Builds 'https://provider.stand.test/' + '/'.repeat(n) + 'x' inside this process (never in argv), inspects a no-key
// openai-http provider with withModels: false (no DNS, fetch or model listing), warms up, times three samples
// and prints one JSON line: { n, samples, median, diagnostics, node, platform, arch, cpu }.
import { cpus } from "node:os";
import { pathToFileURL } from "node:url";

const [modulePath, nArg, diagArg = ""] = process.argv.slice(2);
if (!modulePath || !nArg) { console.error("usage: node probe.ts <providers.ts> <n> [sizes]"); process.exit(2); }
type Inspection = { status: { baseUrl?: string; available: boolean }; http?: { baseUrl: string } };
const { inspectProvider } = (await import(pathToFileURL(modulePath).href)) as { inspectProvider(p: unknown, o: unknown): Promise<Inspection> };

const listHttpModels = () => { throw new Error("model listing must not run in the direct probe"); };
const inspect = (baseUrl: string) => inspectProvider(
  { id: "stand", kind: "openai-http", label: "Stand", models: [], baseUrl },
  { env: {}, withModels: false, deps: { listHttpModels } },
);

async function time(input: string, expected: string): Promise<number> {
  const t = performance.now();
  const r = await inspect(input);
  const ms = performance.now() - t;
  if (!r.status.available || r.status.baseUrl !== expected || r.http?.baseUrl !== expected) throw new Error(`unexpected inspection at length ${input.length}`);
  return ms;
}

const attack = (size: number) => "https://provider.stand.test/" + "/".repeat(size) + "x";
await time("https://h.test/v1///", "https://h.test/v1");
await time(attack(64), attack(64));
const diagnostics = [];
for (const size of diagArg.split(",").filter(Boolean).map(Number)) diagnostics.push({ n: size, ms: await time(attack(size), attack(size)) });
const n = Number(nArg);
const input = attack(n);
const samples = [await time(input, input), await time(input, input), await time(input, input)];
const median = [...samples].sort((a, b) => a - b)[1];
console.log(JSON.stringify({ n, samples, median, diagnostics, node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }));
