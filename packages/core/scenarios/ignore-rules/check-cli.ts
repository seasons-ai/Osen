// Check of .gitignore rules in materials with the real `council` CLI (scripted participants, 0 model calls):
//   COUNCIL_DEV=1 node packages/core/scenarios/ignore-rules/check-cli.ts
// Writes only to a new folder <repository>/.council-data-ignore-rules-*; removes it both on success and on failure.
import "../language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/core/scenarios/ignore-rules/check-cli.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const entry = join(repo, "packages/core/src/council.ts");
const work = join(repo, `.council-data-ignore-rules-${Date.now()}-${randomBytes(3).toString("hex")}`);
const home = join(work, "home"), scen = join(work, "scen"), fx = join(work, "fx");
for (const d of [home, scen]) mkdirSync(d, { recursive: true });
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: home };
const MARK = `МАРКЕР-OUT-7070-${randomBytes(3).toString("hex")}`;
const ok = (s: string) => console.log(`ok: ${s}`);
const kids = new Set<ReturnType<typeof spawn>>();
const participants: string[] = [];

type Proc = { out: string; err: string };
async function run(args: string[]): Promise<{ code: number | null; p: Proc }> {
  const child = spawn(process.execPath, [entry, ...args], { env, cwd: repo });
  kids.add(child);
  const p: Proc = { out: "", err: "" };
  child.stdout.on("data", (d) => { p.out += d; });
  child.stderr.on("data", (d) => { p.err += d; });
  const code = await new Promise<number | null>((res) => child.on("close", (c) => { kids.delete(child); res(c); }));
  return { code, p };
}
const dump = (p: Proc) => `\n--- stdout ---\n${p.out}\n--- stderr ---\n${p.err}`;

function write(rel: string, text: string) { mkdirSync(join(fx, rel, ".."), { recursive: true }); writeFileSync(join(fx, rel), text); }
const ROOT_IGNORE = "out/\n";
function makeFx() {
  write(".gitignore", ROOT_IGNORE);
  write("README.md", "# Фикстура\nКороткое описание.\n");
  write("src/a.ts", "export const a = 1;\n");
  write("out/main.js", `// ${MARK}\n${"x".repeat(500000)}`);
  write("pkg/.gitignore", "gen/\n");
  write("pkg/gen/c.ts", "export const c = 3;\n");
  write("pkg/d.ts", "export const d = 4;\n");
}

type Step = { expectPrompt?: string; stance: string; solution?: string | null; files?: string[] };
function scenario(name: string, steps: Step[]) {
  const path = join(scen, `${name}.json`);
  const body = steps.map(({ expectPrompt, stance, solution, files }) => ({
    ...(expectPrompt ? { expectPrompt } : {}),
    response: { stance, reasoning: "Проверка правил .gitignore.", solution: solution ?? null, answers: [], questions: [], files: files ?? [] },
  }));
  writeFileSync(path, JSON.stringify({ steps: body }));
  return `scripted:${path}`;
}
const agree = (n: number): Step[] => Array.from({ length: n }, () => ({ stance: "agree" }));
/** The first participant requests fx/out/main.js and on the next step expects `expect` in the turn request. */
function readerPair(name: string, expect: string) {
  const p1 = scenario(`${name}-p1`, [
    { stance: "object", files: ["fx/out/main.js"] },
    { expectPrompt: expect, stance: "amend", solution: "Файл проверен." },
    ...agree(3),
  ]);
  const p2 = scenario(`${name}-p2`, agree(3));
  participants.push(p1, p2);
  return ["--participant", p1, "--participant", p2, "--max-rounds", "2"];
}
const topic = ["--topic", "Проверь файл out/main.js"];

// ---- reading results ----
const sessionIds = () => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")).sort() : []);
const sessionId = (p: Proc) => /^Сессия (\S+) ·/m.exec(p.out)?.[1] ?? assert.fail(`no "Сессия" line${dump(p)}`);
const events = (id: string) => readFileSync(join(home, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
function allFiles(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}
const OUT_LINE = "fx/out/ — исключён правилом .gitignore: out/";
const GEN_LINE = "fx/pkg/gen/ — исключён правилом .gitignore: gen/";
/** The "Исключено правилами" section: the heading and the indented lines after it. */
function section(o: string) {
  const ls = o.split("\n"), i = ls.findIndex((l) => l.startsWith("Исключено правилами:"));
  if (i < 0) return "";
  let j = i + 1;
  while (j < ls.length && ls[j]!.startsWith("  ")) j++;
  return ls.slice(i, j).join("\n");
}
const lines = (o: string, s: string) => o.split("\n").filter((l) => l.trim() === s).length;

async function main() {
  makeFx();

  // ---- 1. Preview ----
  const pv = await run(["--attach", fx, "--preview-materials"]);
  assert.equal(pv.code, 0, `code ${pv.code}${dump(pv.p)}`);
  const o = pv.p.out, iPrep = o.indexOf("Подготовленный набор:");
  assert.ok(iPrep > 0, `no "Подготовленный набор:"${dump(pv.p)}`);
  ok("preview: code 0, \"Подготовленный набор:\" is present");
  const sec = section(o);
  assert.ok(sec.startsWith("Исключено правилами: 2") && o.indexOf(sec) < iPrep, `section${dump(pv.p)}`);
  assert.equal(lines(o, OUT_LINE), 1, dump(pv.p));
  assert.equal(lines(o, GEN_LINE), 1, dump(pv.p));
  ok("before \"Подготовленный набор:\" the section \"Исключено правилами: 2\" with fx/out/ and fx/pkg/gen/, one line each");
  for (const n of ["out/main.js", "pkg/gen/c.ts", MARK]) assert.ok(!o.includes(n), `the preview contains ${n}${dump(pv.p)}`);
  ok("the preview has no out/main.js, pkg/gen/c.ts or marker (the set and \"Папка владельца\" without the excluded)");
  const prepId = /Подготовленный набор: ([0-9a-f]{32}) \(действует 24 часа; вызовов моделей не было\)/.exec(o)?.[1] ?? assert.fail(`id format${dump(pv.p)}`);
  ok(`line "Подготовленный набор: ${prepId}" in the expected format`);

  // ---- 2. Run from the prepared set after editing .gitignore ----
  write(".gitignore", "src/\n");
  const n0 = sessionIds().length;
  const r2 = await run([...topic, ...readerPair("s2", "нет в папке владельца"), "--prepared-materials", prepId]);
  write(".gitignore", ROOT_IGNORE);
  assert.equal(r2.code, 0, `code ${r2.code}${dump(r2.p)}`);
  assert.equal(section(r2.p.out), sec, `the section differs from the preview${dump(r2.p)}`);
  ok("with --prepared-materials: code 0, \"Исключено правилами\" is the same as in the preview");
  assert.equal(sessionIds().length, n0 + 1);
  const id2 = sessionId(r2.p);
  ok("the first participant requested fx/out/main.js, expectPrompt \"нет в папке владельца\" satisfied");
  const sFiles = allFiles(join(home, "sessions", id2)).filter((f) => !f.endsWith("events.jsonl"));
  assert.ok(sFiles.some((f) => f.endsWith("workspace/fx/src/a.ts")), "src/a.ts is not in the session snapshot");
  ok("src/a.ts is in the session snapshot: the set equals the shown one, not a re-read one");
  const leak = [r2.p.out, r2.p.err, ...allFiles(home).map((f) => readFileSync(f, "utf8"))].some((t) => t.includes(MARK));
  assert.ok(!leak, "marker found in the output or in the data folder");
  ok("the marker is neither in stdout/stderr nor in the data folder files");

  // ---- 3. --include brings the file back ----
  const inc = ["--attach", fx, "--include", join(fx, "out/main.js")];
  const pv3 = await run([...inc, "--preview-materials"]);
  assert.equal(pv3.code, 0, dump(pv3.p));
  assert.equal(lines(pv3.p.out, GEN_LINE), 1, dump(pv3.p));
  assert.equal(lines(pv3.p.out, OUT_LINE), 0, dump(pv3.p));
  ok("preview with --include: code 0, fx/pkg/gen/ in the section, fx/out/ is no longer there");
  const r3 = await run([...topic, ...inc, ...readerPair("s3", MARK)]);
  assert.equal(r3.code, 0, `code ${r3.code}${dump(r3.p)}`);
  assert.equal(lines(r3.p.out, GEN_LINE), 1, dump(r3.p));
  assert.ok(r3.p.out.includes("Итог: consensus"), dump(r3.p));
  ok("run with --include: code 0, the participant got the marker (expectPrompt), outcome consensus, fx/pkg/gen/ in the section");

  // ---- 4. --no-ignore ----
  const r4 = await run([...topic, "--attach", fx, "--no-ignore", ...readerPair("s4", MARK)]);
  assert.equal(r4.code, 0, `code ${r4.code}${dump(r4.p)}`);
  assert.ok(!r4.p.out.includes("Исключено правилами"), dump(r4.p));
  ok("--no-ignore: code 0, no \"Исключено правилами\" section, the participant got the marker");

  // ---- 5. Refusals ----
  const before = sessionIds();
  const a = await run([...topic, "--attach", fx, "--include", join(fx, "src/a.ts"), ...readerPair("s5a", MARK)]);
  assert.equal(a.code, 2, dump(a.p));
  assert.ok(a.p.err.includes("Материалы не приняты:") && a.p.err.includes("путь не найден среди исключённых правилами .gitignore"), dump(a.p));
  assert.deepEqual(sessionIds(), before, "a session appeared");
  ok("--include of the not-excluded src/a.ts: code 2, \"путь не найден среди исключённых правилами .gitignore\", no session");
  const b = await run([...topic, "--attach", fx, "--include", join(fx, "out"), "--no-ignore", ...readerPair("s5b", MARK)]);
  assert.equal(b.code, 2, dump(b.p));
  assert.ok(b.p.err.includes("--include и --no-ignore несовместимы"), dump(b.p));
  assert.deepEqual(sessionIds(), before, "a session appeared");
  ok("--include together with --no-ignore: code 2, \"--include и --no-ignore несовместимы\", no session");

  // ---- 6. Zero calls to real models ----
  assert.ok(participants.length > 0 && participants.every((p) => p.startsWith("scripted:")), "a non-scripted participant");
  for (const id of sessionIds()) {
    const ps = events(id)[0]!.session.participants as { providerId: string }[];
    assert.ok(ps.length === 2 && ps.every((x) => x.providerId === "scripted"), `session ${id}: ${JSON.stringify(ps)}`);
  }
  ok(`all --participant arguments and the participants of ${sessionIds().length} sessions in the journal are scripted, 0 calls to real models`);
}

let failed = false;
try {
  await main();
  console.log("Terminal .gitignore rules check passed.");
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  for (const k of kids) k.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
