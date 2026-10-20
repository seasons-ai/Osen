// Check of "Bounded URL material name construction" (CodeQL js/polynomial-redos in urlMaterialName), 0 model calls:
//   COUNCIL_DEV=1 node packages/core/scenarios/security-url-material-name/check.ts [--mutant]
// 1. Direct probe: probe.ts names a URL with 1,048,576 slashes before 'x' in a child with a 5,000 ms watchdog;
//    the median of three samples must be <= 1,000 ms. Sizes 1,024, 4,096 and 16,384 are printed as diagnostics.
// 2. Real council through the stand transport seam (url-materials/council-test.ts, local HTTP stand, 30 s watchdog per child):
//    preview of a link with 4,096 slashes before 'x' shows the normalized name and text; a start from that prepared set
//    with two scripted participants reaches consensus without another fetch, the stored name, sha256 and safe source match.
//    Port, encoded path and duplicate-name links keep their established names.
// --mutant: the probe runs on a copy of packages/core/src with the reported expression restored; the stand must exit nonzero.
// The stand creates .council-data/security-4-* itself and deletes it on success.
import "../language-ru.ts";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

if (process.env.COUNCIL_DEV !== "1") { console.error("COUNCIL_DEV=1 is required. Usage: COUNCIL_DEV=1 node packages/core/scenarios/security-url-material-name/check.ts [--mutant]"); process.exit(2); }
const mutant = process.argv.includes("--mutant");
const repo = resolve(import.meta.dirname, "../../../..");
const core = join(repo, "packages/core");
const work = join(repo, ".council-data", `security-4-${Date.now()}`);
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
    return { ok: true as const, code: 0, stdout, ms: performance.now() - started };
  } catch (e) {
    const err = e as { killed?: boolean; signal?: string; code?: number; stdout?: string; message: string };
    return { ok: false as const, code: err.code, stdout: err.stdout ?? "", why: err.killed ? `watchdog ${timeout} ms exceeded (${err.signal})` : err.message, ms: performance.now() - started };
  }
}

// ---------- 1. direct probe ----------
let collectModule = join(core, "src/url/collect.ts");
if (mutant) {
  const copy = join(work, "mutant-src");
  cpSync(join(core, "src"), copy, { recursive: true });
  collectModule = join(copy, "url/collect.ts");
  const source = readFileSync(collectModule, "utf8");
  const restored = source.replace(/export function urlMaterialName\(url: URL\): string \{[\s\S]*?\n\}/, 'export function urlMaterialName(url: URL): string {\n  return (url.host + url.pathname).replace(/\\/+$/, "").replaceAll("/", "_");\n}');
  check("mutation copy restores the reported expression", restored !== source && restored.includes('url.pathname).replace(/\\/+$/, "")'));
  writeFileSync(collectModule, restored);
}
const N = 1_048_576;
const probe = await supervised(process.execPath, [join(import.meta.dirname, "probe.ts"), collectModule, String(N), "1024,4096,16384"], 5_000);
if (probe.ok) {
  const r = JSON.parse(probe.stdout) as { n: number; samples: number[]; median: number; diagnostics: Array<{ n: number; ms: number }>; node: string; platform: string; arch: string; cpu: string };
  console.log(`       n=${r.n} samples=${r.samples.map((s) => s.toFixed(3)).join(",")} ms median=${r.median.toFixed(3)} ms child=${probe.ms.toFixed(0)} ms`);
  console.log(`       diagnostics ${r.diagnostics.map((d) => `n=${d.n}:${d.ms.toFixed(3)}ms`).join(" ")}; node ${r.node} ${r.platform}/${r.arch} ${r.cpu}`);
  check(`probe median <= 1,000 ms at n=${N}`, r.n === N && r.samples.length === 3 && r.median <= 1_000, `median ${r.median} ms`);
} else {
  check(`probe child finishes before the 5,000 ms watchdog at n=${N}`, false, `${probe.why}; supervisor stayed responsive, child settled after ${probe.ms.toFixed(0)} ms`);
}

// ---------- 2. real council through the stand transport seam ----------
if (!mutant) {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? ""; // raw: a path starting with '//' must not be parsed as a host
    hits.push(path);
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`Stand text for a path of ${path.split("?")[0]!.length} chars.`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  const env = {
    COUNCIL_DEV: "1", COUNCIL_HOME: home, COUNCIL_LANG: "ru",
    URL_STAND: JSON.stringify({ dns: { "docs.stand.test": ["93.184.215.14"] }, routes: { "93.184.215.14": port }, log: join(work, "transport.jsonl") }),
  };
  const council = (args: string[]) => supervised(process.execPath, [join(core, "scenarios/url-materials/council-test.ts"), ...args], 30_000, env);
  const setOf = (out: string) => /Подготовленный набор: ([0-9a-f]{32})/.exec(out)?.[1];
  const setJson = (id: string) => JSON.parse(readFileSync(join(home, "prepared-materials", id, "set.json"), "utf8")) as { materials: Array<{ id: string; name: string; sha256: string }> };
  const short = (s: string) => s.replace(/[/_]{24,}/g, (m) => `${m[0]}×${m.length}`);

  try {
    const slashes = "/".repeat(4_096);
    const name = `docs.stand.test${"_".repeat(4_096)}x`;
    const a = await council(["--url", `http://docs.stand.test${slashes}x?token=QMARK#QMARK`, "--preview-materials"]);
    const aSet = setOf(a.stdout);
    console.log(`       preview (${a.ms.toFixed(0)} ms, code ${a.code}): ${short(a.stdout.split("\n").filter((l) => l.includes("docs.stand.test") || l.startsWith("Материалы")).join(" | ")).slice(0, 300)}`);
    check("preview of 4,096 slashes before 'x': code 0, normalized name and stand text visible, one fetch",
      a.ok && aSet !== undefined && a.stdout.includes(name) && a.stdout.includes(`Stand text for a path of ${4_097} chars.`) && hits.length === 1 && hits[0] === `${slashes}x?token=QMARK`,
      a.ok ? short(a.stdout) : a.why);
    if (aSet) {
      const stored = setJson(aSet).materials[0];
      const s = await council(["--topic", "Проверка имени материала-ссылки", "--participant", `scripted:${join(core, "scenarios/consensus/p1.json")}`,
        "--participant", `scripted:${join(core, "scenarios/consensus/p2.json")}`, "--max-rounds", "3", "--prepared-materials", aSet]);
      const sid = /^Сессия (\S+) ·/m.exec(s.stdout)?.[1];
      console.log(`       start (${s.ms.toFixed(0)} ms, code ${s.code}): session ${sid}, fetches ${hits.length}`);
      if (s.ok && sid) {
        const dir = join(home, "sessions", sid);
        const created = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created");
        const mat = created.session.materials[0] as { name: string; sha256: string };
        const sources = readFileSync(join(dir, "materials", "sources.json"), "utf8");
        check("start from the prepared set: consensus (code 0), no second fetch, stored name and sha256 match the preview, safe source without query",
          s.stdout.includes(`Подготовленный набор: ${aSet}`) && hits.length === 1 && mat.name === name && stored?.name === name && mat.sha256 === stored.sha256
            && sources.includes(`/${slashes.slice(1)}x`) && !sources.includes("QMARK"), JSON.stringify({ name: mat.name.length, stored: stored?.name.length, hits: hits.length }));
      } else check("start from the prepared set reaches consensus within 30 s", false, s.ok ? short(s.stdout) : s.why);
    }

    hits.length = 0;
    const b = await council(["--url", "http://docs.stand.test:8443/a/", "--url", "http://docs.stand.test/%D0%B0/b/", "--url", "http://docs.stand.test/dup/", "--url", "http://docs.stand.test/dup", "--preview-materials"]);
    const bSet = b.ok ? setOf(b.stdout) : undefined;
    const names = bSet ? setJson(bSet).materials.map((m) => m.name) : [];
    const expected = ["docs.stand.test:8443_a", "docs.stand.test_%D0%B0_b", "docs.stand.test_dup", "docs.stand.test_dup (2)"];
    console.log(`       port/encoded/duplicate preview (${b.ms.toFixed(0)} ms, code ${b.code}): ${names.join(", ")}`);
    check("port, encoded path and duplicate names keep their established form and are visible in the preview",
      JSON.stringify(names) === JSON.stringify(expected) && expected.every((n) => b.stdout.includes(n)) && hits.length === 4, b.ok ? b.stdout : b.why);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

console.log(`${failed ? "FAIL" : "PASS"} Bounded URL material name construction${mutant ? " (mutant)" : ""}: ${total - failed}/${total} checks`);
if (failed) { console.log(`       data kept in ${work}`); process.exit(1); }
rmSync(work, { recursive: true, force: true });
