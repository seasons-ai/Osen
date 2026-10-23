// Child side of the "Bounded fenced response extraction" probe: run only under a supervisor with a finite timeout.
//   node probe.ts <path to protocol/parse.ts> <n> [diagnostic sizes, comma separated] [family: fence | brace]
// Builds the attack inside this process (never in argv): fence — '```' + '_'.repeat(n), brace — '{'.repeat(n);
// warms extractJsonObject up, times three samples and prints one JSON line: { family, n, samples, median, diagnostics, node, platform, arch, cpu }.
import { cpus } from "node:os";
import { pathToFileURL } from "node:url";

type Parse = {
  extractJsonObject(raw: string): Record<string, unknown> | undefined;
  parseFileRequest(raw: string): string[] | null;
  parseDraftResponse(raw: string, language: "en" | "ru"): { ok: boolean };
};
const [modulePath, nArg, diagArg = "", family = "fence"] = process.argv.slice(2);
if (!modulePath || !nArg || (family !== "fence" && family !== "brace")) { console.error("usage: node probe.ts <parse.ts> <n> [sizes] [fence|brace]"); process.exit(2); }
const parse = (await import(pathToFileURL(modulePath).href)) as Parse;
const attack = (size: number) => (family === "brace" ? "{".repeat(size) : "```" + "_".repeat(size));

function time(input: string): number {
  const t = performance.now();
  const r = parse.extractJsonObject(input);
  const ms = performance.now() - t;
  if (r !== undefined) throw new Error(`expected no object in the ${family} attack`);
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
if (parse.parseFileRequest(input) !== null || parse.parseDraftResponse(input, "en").ok) throw new Error(`consumers accepted the ${family} attack`);
console.log(JSON.stringify({ family, n, samples, median, diagnostics, node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }));
