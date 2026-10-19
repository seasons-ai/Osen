// Child side of the "Bounded CLI version extraction" probe: run only under a supervisor with a finite timeout.
//   node probe.ts <path to discovery.ts> <n> [diagnostic sizes, comma separated]
// Builds '9'.repeat(n) inside this process (never in argv), warms parseVersion up, times three samples
// and prints one JSON line: { n, samples, median, diagnostics, node, platform, arch, cpu }.
import { cpus } from "node:os";
import { pathToFileURL } from "node:url";

const [modulePath, nArg, diagArg = ""] = process.argv.slice(2);
if (!modulePath || !nArg) { console.error("usage: node probe.ts <discovery.ts> <n> [sizes]"); process.exit(2); }
const { parseVersion } = (await import(pathToFileURL(modulePath).href)) as { parseVersion(raw: string): string | undefined };

function time(input: string): number {
  const t = performance.now();
  const r = parseVersion(input);
  const ms = performance.now() - t;
  if (r !== undefined) throw new Error(`expected no version in a digit run, got ${r.slice(0, 20)}`);
  return ms;
}

if (parseVersion("2.1.288 (Claude Code)") !== "2.1.288") throw new Error("warm-up parse failed");
time("9".repeat(64));
const diagnostics = diagArg.split(",").filter(Boolean).map(Number).map((size) => ({ n: size, ms: time("9".repeat(size)) }));
const n = Number(nArg);
const input = "9".repeat(n);
const samples = [time(input), time(input), time(input)];
const median = [...samples].sort((a, b) => a - b)[1];
console.log(JSON.stringify({ n, samples, median, diagnostics, node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }));
