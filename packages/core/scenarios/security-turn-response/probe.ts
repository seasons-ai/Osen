// Child side of the "Bounded fenced response extraction" probe: run only under a supervisor with a finite timeout.
//   node probe.ts <path to protocol/parse.ts> <n> [diagnostic sizes, comma separated]
// Builds '```' + '_'.repeat(n) inside this process (never in argv), warms extractJsonObject up, times three samples
// and prints one JSON line: { n, samples, median, diagnostics, node, platform, arch, cpu }.
import { cpus } from "node:os";
import { pathToFileURL } from "node:url";

type Parse = {
  extractJsonObject(raw: string): Record<string, unknown> | undefined;
  parseFileRequest(raw: string): string[] | null;
  parseDraftResponse(raw: string, language: "en" | "ru"): { ok: boolean };
};
const [modulePath, nArg, diagArg = ""] = process.argv.slice(2);
if (!modulePath || !nArg) { console.error("usage: node probe.ts <parse.ts> <n> [sizes]"); process.exit(2); }
const parse = (await import(pathToFileURL(modulePath).href)) as Parse;
const attack = (size: number) => "```" + "_".repeat(size);

function time(input: string): number {
  const t = performance.now();
  const r = parse.extractJsonObject(input);
  const ms = performance.now() - t;
  if (r !== undefined) throw new Error("expected no object in the malformed fence");
  return ms;
}

if (parse.extractJsonObject("```json\n{\"a\":1}\n```")?.a !== 1) throw new Error("warm-up parse failed");
time(attack(64));
const diagnostics = diagArg.split(",").filter(Boolean).map(Number).map((size) => ({ n: size, ms: time(attack(size)) }));
const n = Number(nArg);
const input = attack(n);
const samples = [time(input), time(input), time(input)];
const median = [...samples].sort((a, b) => a - b)[1];
// The direct consumers go through the same extractor and keep their "no object" results.
if (parse.parseFileRequest(input) !== null || parse.parseDraftResponse(input, "en").ok) throw new Error("consumers accepted the malformed fence");
console.log(JSON.stringify({ n, samples, median, diagnostics, node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }));
