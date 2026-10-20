// Child side of the "Bounded URL material name construction" probe: run only under a supervisor with a finite timeout.
//   node probe.ts <path to url/collect.ts> <n> [diagnostic sizes, comma separated]
// Builds new URL('https://docs.stand.test/' + '/'.repeat(n) + 'x') inside this process (never in argv) before the timer,
// warms up, times urlMaterialName in three samples and prints one JSON line:
// { n, samples, median, diagnostics, node, platform, arch, cpu }.
import { cpus } from "node:os";
import { pathToFileURL } from "node:url";

const [modulePath, nArg, diagArg = ""] = process.argv.slice(2);
if (!modulePath || !nArg) { console.error("usage: node probe.ts <collect.ts> <n> [sizes]"); process.exit(2); }
const { urlMaterialName } = (await import(pathToFileURL(modulePath).href)) as { urlMaterialName(url: URL): string };

function time(url: URL, expected: string): number {
  const t = performance.now();
  const name = urlMaterialName(url);
  const ms = performance.now() - t;
  if (name !== expected) throw new Error(`unexpected name at path length ${url.pathname.length}`);
  return ms;
}

const attack = (size: number) => new URL("https://docs.stand.test/" + "/".repeat(size) + "x");
const expected = (size: number) => "docs.stand.test" + "_".repeat(size + 1) + "x";
time(new URL("http://example.com:8443/a/"), "example.com:8443_a");
time(attack(64), expected(64));
const diagnostics = [];
for (const size of diagArg.split(",").filter(Boolean).map(Number)) diagnostics.push({ n: size, ms: time(attack(size), expected(size)) });
const n = Number(nArg);
const url = attack(n), name = expected(n);
const samples = [time(url, name), time(url, name), time(url, name)];
const median = [...samples].sort((a, b) => a - b)[1];
console.log(JSON.stringify({ n, samples, median, diagnostics, node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }));
