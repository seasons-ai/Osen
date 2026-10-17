// Check of the large-folder snapshot by the real `council` CLI (scripted participants, 0 model calls):
//   COUNCIL_DEV=1 node packages/core/scenarios/folder/check-cli.ts
// Writes only to a new folder <repo>/.council-data/folder-check-*; deletes it on success, keeps it on failure.
import "../language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Usage: COUNCIL_DEV=1 node packages/core/scenarios/folder/check-cli.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const entry = join(repo, "packages/core/src/council.ts");
const work = join(repo, ".council-data", `folder-check-${Date.now()}-${randomBytes(3).toString("hex")}`);
const home = join(work, "home"), src = join(work, "src"), scen = join(work, "scen");
for (const d of [home, src, scen]) mkdirSync(d, { recursive: true });
const proj = join(src, "proj");
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: home };
const rnd = () => randomBytes(4).toString("hex");
const MARK = `МАРКЕР-ИСХОДНИК-${rnd()}`, SECRET = `СЕКРЕТ-ENV-${rnd()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (s: string) => console.log(`ok: ${s}`);
const kids = new Set<ReturnType<typeof spawn>>();
const captured: string[] = [];

type Proc = { out: string; err: string; exited: Promise<number | null> };
function proc(args: string[], extraEnv: Record<string, string> = {}): Proc {
  const child = spawn(process.execPath, [entry, ...args], { env: { ...env, ...extraEnv }, cwd: repo });
  kids.add(child);
  const r: Proc = { out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout.on("data", (d) => { r.out += d; });
  child.stderr.on("data", (d) => { r.err += d; });
  r.exited.then(() => captured.push(r.out, r.err));
  return r;
}
const dump = (p: Proc) => `\n--- stdout ---\n${p.out}\n--- stderr ---\n${p.err}`;
async function run(args: string[], extraEnv: Record<string, string> = {}) { const p = proc(args, extraEnv); const code = await p.exited; return { code, p }; }
async function until(what: string, fn: () => unknown, p: Proc, ms = 15000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) if (fn()) return;
  throw new Error(`timed out waiting for: ${what}${dump(p)}`);
}

// ---- fixture and scenarios ----
function makeProj() {
  rmSync(proj, { recursive: true, force: true });
  const w = (rel: string, text: string | Buffer) => { mkdirSync(join(proj, rel, ".."), { recursive: true }); writeFileSync(join(proj, rel), text); };
  w("README.md", "# Проект\nКороткое описание проекта.\n");
  w("docs/guide.md", "# Руководство\nКак пользоваться.\n");
  w("src/a.ts", `// ${MARK}\nexport const a = 1;\n`);
  for (let i = 0; i < 100; i++) w(`src/gen/f${String(i).padStart(3, "0")}.ts`, `export const v${i} = [\n${"  1234567890,\n".repeat(75)}];\n`);
  w(".env.local", `TOKEN=${SECRET}\n`);
  w("blob.bin", Buffer.from([0, 1, 2, 0, 255, 254, 0, 0]));
  w("node_modules/x/index.js", "module.exports = 1;\n");
  symlinkSync(join(proj, "README.md"), join(proj, "link.md"));
}
/** files/chars are computed from the fixture itself: text files without hidden ones, ignored ones, symlinks and binaries. */
function expected() {
  let files = 0, chars = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(join(d, e.name)); continue; }
      const b = readFileSync(join(d, e.name));
      if (b.includes(0)) continue;
      files++; chars += b.toString("utf8").length;
    }
  };
  walk(proj);
  return { files, chars };
}
type Step = { expectPrompt?: string; delayMs?: number; stance: string; solution?: string | null; files?: string[] };
function scenario(name: string, steps: Step[]) {
  const path = join(scen, `${name}.json`);
  const body = steps.map(({ expectPrompt, delayMs, stance, solution, files }) => ({
    ...(expectPrompt ? { expectPrompt } : {}), ...(delayMs ? { delayMs } : {}),
    response: { stance, reasoning: "Проверка снимка папки.", solution: solution ?? null, answers: [], questions: [], files: files ?? [] },
  }));
  writeFileSync(path, JSON.stringify({ steps: body }));
  return `scripted:${path}`;
}
const agree = (n: number): Step[] => Array.from({ length: n }, () => ({ stance: "agree" }));

// ---- reading results ----
const sessionId = (p: Proc) => /^Сессия (\S+) ·/m.exec(p.out)?.[1] ?? assert.fail(`no «Сессия» line ${dump(p)}`);
const sdir = (id: string) => join(home, "sessions", id);
const events = (id: string) => readFileSync(join(sdir(id), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
const ofType = (id: string, t: string) => events(id).filter((e) => e.type === t);
const journals = () => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")).filter((d) => existsSync(join(home, "sessions", d, "events.jsonl"))) : []);
function allFiles(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}
const hashes = (id: string) => Object.fromEntries(["workspace", "materials"].flatMap((s) => allFiles(join(sdir(id), s))).map((f) => [f, createHash("sha256").update(readFileSync(f)).digest("hex")]));

async function main() {
  makeProj();
  const exp = expected();
  assert.ok(exp.chars > 60000, `fixture too small: ${exp.chars}`);

  // ---- 1. Large folder, read on request, agreement ----
  const p1 = scenario("s1-p1", [
    { stance: "object", files: ["proj/src/a.ts"] },
    { expectPrompt: MARK, stance: "amend", solution: "Файл проверен, правок нет." },
    ...agree(3),
  ]);
  const p2 = scenario("s1-p2", agree(3));
  const r1 = await run(["--topic", "Проверь файл src/a.ts", "--attach", proj, "--participant", p1, "--participant", p2, "--max-rounds", "2"]);
  const o1 = r1.p.out;
  assert.equal(r1.code, 0, `code ${r1.code}${dump(r1.p)}`);
  const id1 = sessionId(r1.p);
  const total = Number(/^Материалы: \d+, объём (\d+) символов \(лимит 60000\)\./m.exec(o1)?.[1] ?? assert.fail(`no «Материалы:» line${dump(r1.p)}`));
  assert.ok(total <= 60000, `size ${total}`);
  ok(`code 0; «Материалы:» size ${total} ≤ limit 60000`);
  const snap = /^Снимок папки: файлов (\d+), объём (\d+) знаков \(граница 20000000\)\./m.exec(o1);
  assert.deepEqual([Number(snap?.[1]), Number(snap?.[2])], [exp.files, exp.chars], `snapshot${dump(r1.p)}`);
  ok(`«Снимок папки:» files ${exp.files}, size ${exp.chars} (> 60000) — as in the fixture`);
  assert.ok(o1.indexOf("Снимок папки:") < o1.indexOf("Сессия ") && o1.indexOf("Материалы:") < o1.indexOf("Сессия "), "summary comes after the «Сессия» line");
  ok("summary is printed before the «Сессия» line");
  const created = ofType(id1, "session_created")[0]!.session;
  assert.ok(!(created.materials as { name: string }[]).some((m) => m.name === "proj/src/a.ts"), "a.ts got into the initial set");
  assert.ok(created.materials.length > 0 && created.materials.some((m: { name: string }) => m.name === "proj/README.md"), "descriptions did not get into the set");
  ok("proj/src/a.ts is not in the initial set (README.md is)");
  const skipped = o1.slice(o1.indexOf("Пропущено:"));
  assert.ok(o1.includes("Пропущено:"), `no «Пропущено:»${dump(r1.p)}`);
  for (const n of [".env.local", "blob.bin", "link.md", "node_modules"]) assert.ok(skipped.includes(`proj/${n}`), `«Пропущено» lacks ${n}:\n${skipped}`);
  ok("«Пропущено:» lists .env.local, the binary file, the symlink and node_modules");
  assert.match(o1, /^Прочитано из папки: proj\/src\/a\.ts — \d+ знаков$/m, dump(r1.p));
  ok("output contains «Прочитано из папки: proj/src/a.ts — N знаков»");
  assert.deepEqual(created.workspace, exp);
  const read = ofType(id1, "turn_completed").filter((e) => e.filesRead?.length);
  assert.ok(read.length >= 1 && read[0].filesRead[0].name === "proj/src/a.ts", "no turn with filesRead");
  assert.equal(read[0].attempts, 2, "the first turn of p1 must take exactly 2 calls");
  ok(`journal: workspace = {${exp.files}, ${exp.chars}}, turn with filesRead, 2 participant calls (≤ 3)`);
  const snapDir = join(sdir(id1), "workspace", "proj");
  assert.equal(readFileSync(join(snapDir, "src/a.ts"), "utf8"), `// ${MARK}\nexport const a = 1;\n`);
  for (const n of [".env.local", "blob.bin", "link.md", "node_modules"]) assert.ok(!existsSync(join(snapDir, n)), `snapshot contains ${n}`);
  ok("snapshot contains the original a.ts; no .env.local, binary, symlink or node_modules in it");
  const hash1 = hashes(id1);

  // ---- 1b. Explicit file before and after the folder: same snapshot (change 110) ----
  const aTs = join(proj, "src/a.ts");
  for (const [name, order] of [["explicit file before folder", [aTs, proj]], ["explicit file after folder", [proj, aTs]]] as const) {
    const e1 = scenario(`s1b-${order[0] === aTs ? "first" : "last"}-p1`, [
      { stance: "object", files: ["proj/src/a.ts"] },
      { expectPrompt: MARK, stance: "amend", solution: "Файл проверен, правок нет." },
      ...agree(3),
    ]);
    const e2 = scenario(`s1b-${order[0] === aTs ? "first" : "last"}-p2`, agree(3));
    const re = await run(["--topic", "Проверь файл src/a.ts", ...order.flatMap((x) => ["--attach", x]), "--participant", e1, "--participant", e2, "--max-rounds", "2"]);
    assert.equal(re.code, 0, `${name}: code ${re.code}${dump(re.p)}`);
    const sn = /^Снимок папки: файлов (\d+), объём (\d+) знаков/m.exec(re.p.out);
    assert.deepEqual([Number(sn?.[1]), Number(sn?.[2])], [exp.files, exp.chars], `${name}: «Снимок папки: файлов ${sn?.[1]}, объём ${sn?.[2]}», expected «файлов ${exp.files}, объём ${exp.chars}»${dump(re.p)}`);
    assert.match(re.p.out, /^Прочитано из папки: proj\/src\/a\.ts — \d+ знаков$/m, `${name}: file proj/src/a.ts was not read from the snapshot${dump(re.p)}`);
    const eid = sessionId(re.p);
    assert.deepEqual(ofType(eid, "session_created")[0]!.session.workspace, exp, `${name}: workspace in the journal`);
    ok(`${name}: «Снимок папки: файлов ${exp.files}, объём ${exp.chars}», proj/src/a.ts read from the snapshot`);
  }

  // ---- 2. Stop, edit the source, resume from the snapshot ----
  const MARK2 = `МАРКЕР-ИЗМЕНЁН-${rnd()}`;
  const q1 = scenario("s2-p1", [
    { stance: "amend", solution: "Предварительное решение." },
    { stance: "object", files: ["proj/src/a.ts"] },
    { expectPrompt: MARK, stance: "amend", solution: "Решение после чтения файла." },
    ...agree(3),
  ]);
  const q2 = scenario("s2-p2", [{ delayMs: 6000, stance: "object" }, ...agree(4)]);
  const r2 = proc(["--topic", "Проверь файл src/a.ts после остановки", "--attach", proj, "--participant", q1, "--participant", q2, "--max-rounds", "2"]);
  await until("session line", () => /^Сессия \S+ ·/m.test(r2.out), r2);
  const id2 = sessionId(r2);
  await until("«── Ход 1»", () => r2.out.includes("── Ход 1"), r2);
  await until("turn_completed of turn 1", () => ofType(id2, "turn_completed").length >= 1, r2);
  const st = await run(["stop", id2]);
  assert.equal(st.code, 0, `stop: ${st.code}${dump(st.p)}`);
  assert.equal(await r2.exited, 4, `exit code of the stopped session${dump(r2)}`);
  ok("council stop stopped the session in the second turn (process code 4)");
  const before = readFileSync(join(sdir(id2), "events.jsonl")), h2 = hashes(id2);
  assert.ok(Object.keys(h2).some((f) => f.endsWith("proj/src/a.ts")), "no a.ts in the snapshot");
  writeFileSync(join(proj, "src/a.ts"), `// ${MARK2}\n`);
  rmSync(proj, { recursive: true, force: true });
  const rs = await run(["resume", id2, "--rounds", "2"]);
  assert.equal(rs.code, 0, `resume: code ${rs.code}${dump(rs.p)}`);
  assert.match(rs.p.out, /^Прочитано из папки: proj\/src\/a\.ts/m, dump(rs.p));
  ok("resume with the source folder deleted: file read from the snapshot with the original marker (expectPrompt), code 0");
  const after = readFileSync(join(sdir(id2), "events.jsonl"));
  assert.ok(after.length > before.length && after.subarray(0, before.length).equals(before), "the previous journal bytes are not a prefix");
  assert.deepEqual(hashes(id2), h2, "snapshot files changed");
  assert.equal(ofType(id2, "session_created").length, 1);
  assert.equal(ofType(id2, "session_resumed").length, 1);
  ok("journal before resume is an exact prefix of the new one; snapshot and materials hashes unchanged; session_created 1, session_resumed 1");
  assert.ok(Object.keys(hash1).length > 0);

  // ---- 3. Rejections ----
  makeProj();
  const n0 = journals().length;
  const a = await run(["--topic", "t", "--attach", join(proj, ".env.local"), "--participant", p2, "--participant", p2, "--max-rounds", "1"]);
  assert.equal(a.code, 2, dump(a.p));
  assert.ok(a.p.err.includes("Материалы не приняты:"), dump(a.p));
  assert.equal(journals().length, n0, "a journal appeared");
  ok("explicit .env.local: code 2, «Материалы не приняты:», no journal");
  const big = join(src, "big");
  mkdirSync(big);
  writeFileSync(join(big, "a.txt"), "a".repeat(10000000));
  writeFileSync(join(big, "b.txt"), "b".repeat(10000001));
  const b = await run(["--topic", "t", "--attach", big, "--participant", p2, "--participant", p2, "--max-rounds", "1"]);
  rmSync(big, { recursive: true, force: true });
  assert.equal(b.code, 2, dump(b.p));
  assert.ok(b.p.err.includes("Материалы не приняты:") && b.p.err.includes("20000001") && b.p.err.includes("20000000"), dump(b.p));
  assert.equal(journals().length, n0, "a journal appeared");
  ok("folder of 20000001 chars: code 2, message contains 20000001 and 20000000, no journal");

  // ---- 4. Leaks ----
  const text = [...captured, ...(existsSync(join(home, "logs/app.log")) ? [readFileSync(join(home, "logs/app.log"), "utf8")] : []),
    ...allFiles(join(home, "sessions")).filter((f) => !/\/(workspace|materials)\//.test(f)).map((f) => readFileSync(f, "utf8"))].join("\n");
  for (const [what, needle] of [["secret from .env.local", SECRET], ["text of a.ts", MARK], ["absolute path of src", src]] as const)
    assert.ok(!text.includes(needle), `leak: ${what} (${needle}) found in output, log or journal`);
  ok("output, app.log and journals contain no .env.local secret, no a.ts text and no absolute path of src");
  const snapText = allFiles(home).filter((f) => /\/(workspace|materials)\//.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
  assert.ok(!snapText.includes(SECRET), "secret in workspace/materials");
  ok("no .env.local secret in workspace/materials either");

  // ---- 5. Without --attach ----
  const c = await run(["--topic", "Обсуждение без материалов", "--participant", `scripted:${join(repo, "packages/core/scenarios/consensus/p1.json")}`,
    "--participant", `scripted:${join(repo, "packages/core/scenarios/consensus/p2.json")}`, "--max-rounds", "3"]);
  assert.equal(c.code, 0, dump(c.p));
  assert.ok(!/^Материалы:/m.test(c.p.out) && !/^Снимок папки:/m.test(c.p.out), dump(c.p));
  const s5 = ofType(sessionId(c.p), "session_created")[0]!.session;
  assert.ok(!("materials" in s5) && !("workspace" in s5), "session_created has materials/workspace");
  ok("without --attach: code 0, no «Материалы:» or «Снимок папки:», session_created has no materials or workspace");

  // ---- 6. Same-named folders ----
  const two = [scenario("s6-0", [{ stance: "amend", solution: "Решение." }, ...agree(4)]), scenario("s6-1", agree(5))];
  const mk = (root: string, rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
  const A = join(work, "a"), B = join(work, "b");
  mk(A, "language/check.ts", `// ${rnd()} from a\n`); mk(A, "language/other.md", "# a\n");
  mk(B, "language/check.ts", `// ${rnd()} from b\n`); mk(B, "language/more.md", "# b\n");
  const r6 = await run(["--topic", "Одноимённые папки", "--attach", join(A, "language"), "--attach", join(B, "language"), "--participant", two[0]!, "--participant", two[1]!, "--max-rounds", "2"]);
  assert.equal(r6.code, 0, `code ${r6.code}${dump(r6.p)}`);
  const id6 = sessionId(r6.p);
  assert.equal(ofType(id6, "session_finished")[0]?.status, "consensus", dump(r6.p));
  const names6 = (ofType(id6, "session_created")[0]!.session.materials as { name: string }[]).map((m) => m.name);
  for (const n of ["language/check.ts", "language (2)/check.ts"]) assert.ok(names6.includes(n), `materials lacks ${n}: ${names6}`);
  assert.equal(readFileSync(join(sdir(id6), "workspace/language/check.ts"), "utf8"), readFileSync(join(A, "language/check.ts"), "utf8"));
  assert.equal(readFileSync(join(sdir(id6), "workspace/language (2)/check.ts"), "utf8"), readFileSync(join(B, "language/check.ts"), "utf8"));
  ok("two language folders: code 0; materials and workspace — language/ and language (2)/ with the contents of each");
  const L1 = join(repo, "packages/core/scenarios/language"), L2 = join(repo, "packages/mcp/scenarios/language");
  const r6b = await run(["--topic", "Пара из репозитория", "--attach", L1, "--attach", L2, "--participant", two[0]!, "--participant", two[1]!, "--max-rounds", "2"]);
  assert.equal(r6b.code, 0, `code ${r6b.code}${dump(r6b.p)}`);
  const id6b = sessionId(r6b.p);
  const names6b = (ofType(id6b, "session_created")[0]!.session.materials as { name: string }[]).map((m) => m.name);
  assert.ok(names6b.includes("language/check.ts") && names6b.includes("language (2)/check.ts"), `materials: ${names6b}`);
  assert.equal(readFileSync(join(sdir(id6b), "workspace/language/check.ts"), "utf8"), readFileSync(join(L1, "check.ts"), "utf8"));
  assert.equal(readFileSync(join(sdir(id6b), "workspace/language (2)/check.ts"), "utf8"), readFileSync(join(L2, "check.ts"), "utf8"));
  ok("pair from the repository (core/scenarios/language and mcp/scenarios/language): code 0, both prefixes in materials and workspace");

  // ---- 6a. Same-named folders and .gitignore: --include by prefixed name ----
  for (const root of [A, B]) {
    mk(root, "proj/.gitignore", "out/\n"); mk(root, "proj/out/main.js", `console.log("${root === A ? "a" : "b"}");\n`);
    mk(root, "proj/x.ts", "export const x = 1;\n");
  }
  const base6a = ["--topic", "include по префиксу", "--attach", join(A, "proj"), "--attach", join(B, "proj"), "--participant", two[0]!, "--participant", two[1]!, "--max-rounds", "2"];
  const r6a = await run([...base6a, "--include", "proj (2)/out/"]);
  assert.equal(r6a.code, 0, `code ${r6a.code}${dump(r6a.p)}`);
  const id6a = sessionId(r6a.p);
  const names6a = (ofType(id6a, "session_created")[0]!.session.materials as { name: string }[]).map((m) => m.name);
  assert.ok(names6a.includes("proj (2)/out/main.js") && !names6a.includes("proj/out/main.js"), `materials: ${names6a}`);
  assert.equal(readFileSync(join(sdir(id6a), "workspace/proj (2)/out/main.js"), "utf8"), readFileSync(join(B, "proj/out/main.js"), "utf8"));
  assert.ok(!existsSync(join(sdir(id6a), "workspace/proj/out")), "proj/out got into the snapshot of the first folder");
  const ruled = r6a.p.out.slice(r6a.p.out.indexOf("Исключено правилами"));
  assert.ok(r6a.p.out.includes("Исключено правилами") && ruled.includes("proj/out/"), `no proj/out/ in «Исключено правилами»${dump(r6a.p)}`);
  assert.ok(!ruled.includes("proj (2)/out/"), "proj (2)/out/ stayed excluded");
  ok("--include «proj (2)/out/»: code 0, out/main.js of the second folder included, proj/out/ of the first stayed in «Исключено правилами»");
  const nJ = journals().length;
  const r6c = await run([...base6a, "--include", "proj/out/"]);
  assert.equal(r6c.code, 2, `code ${r6c.code}${dump(r6c.p)}`);
  assert.match(r6c.p.err, /абсолютный путь/, dump(r6c.p));
  assert.equal(journals().length, nJ, "a journal appeared");
  ok("--include proj/out/ with two proj: code 2, asks for an absolute path, no journal");

  // ---- 7. A snapshot write error leaves no partial session ----
  const seg = (c: string) => c.repeat(200);
  const home7 = join(work, "h7", seg("h"), seg("i"), seg("j")), src7 = join(work, "s7");
  mkdirSync(home7, { recursive: true });
  const long7 = join(seg("l"), seg("m"), seg("n"), "long-file.txt");
  mk(src7, "a.txt", "короткий\n"); mk(src7, long7, "длинный путь\n");
  assert.ok(join(src7, long7).length < 1000 && join(home7, "sessions", "20260101-000000-abcdef", "workspace", "s7", long7).length > 1100, "path lengths do not fit");
  const env7 = { COUNCIL_HOME: home7 };
  const ctrl = await run(["--topic", "Обычная сессия в длинной папке", "--participant", two[0]!, "--participant", two[1]!, "--max-rounds", "2"], env7);
  assert.equal(ctrl.code, 0, `code ${ctrl.code}${dump(ctrl.p)}`);
  const ctrlId = sessionId(ctrl.p);
  const ctrlBytes = readFileSync(join(home7, "sessions", ctrlId, "events.jsonl"));
  const listing7 = () => readdirSync(join(home7, "sessions")).sort();
  const before7 = listing7();
  const r7 = await run(["--topic", "Длинный путь", "--attach", join(src7), "--participant", two[0]!, "--participant", two[1]!, "--max-rounds", "2"], env7);
  console.log(`exit code on snapshot write error: ${r7.code}`);
  if (!/ENAMETOOLONG/.test(r7.p.err)) {
    console.log(`SKIPPED: the environment did not produce ENAMETOOLONG (code ${r7.code})${dump(r7.p)}`);
  } else {
    assert.notEqual(r7.code, 0, dump(r7.p));
    assert.ok(r7.p.err.includes("long-file.txt"), `stderr without the file name${dump(r7.p)}`);
    assert.deepEqual(listing7(), before7, "an extra folder appeared in sessions/");
    assert.ok(listing7().every((d) => existsSync(join(home7, "sessions", d, "events.jsonl"))), "a folder without events.jsonl exists");
    assert.ok(readFileSync(join(home7, "sessions", ctrlId, "events.jsonl")).equals(ctrlBytes), "the journal of the previous session changed");
    ok(`snapshot write error (ENAMETOOLONG, exit code ${r7.code}): stderr names long-file.txt, no new folders in sessions/, the previous session journal is untouched`);
  }

  // ---- 8. Limit of the folder listing in a participant request ----
  const listingOf = (prompt: string) => {
    const from = prompt.indexOf("# Папка владельца");
    assert.ok(from >= 0, "the request has no «Папка владельца» section");
    const body = prompt.slice(from).split("\n\n").slice(1).join("\n\n");
    const end = body.search(/\n# /);
    return end < 0 ? body : body.slice(0, end);
  };
  const promptsOf = (log: string) => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { participantId: string; prompt: string });
  const many = join(src, "many"), five = join(src, "five");
  for (let i = 0; i < 3000; i++) mk(many, `d${String(i).padStart(4, "0")}/f.txt`, "x\n");
  for (let i = 0; i < 500; i++) mk(five, `d${String(i).padStart(3, "0")}-${"z".repeat(40)}/f.txt`, "y\n");
  mk(five, "README.md", "# five\n");
  const probe = async (name: string, dir: string, want: string | null) => {
    const log = join(work, `${name}.prompts.jsonl`);
    const a = scenario(`s8-${name}-1`, [...(want ? [{ stance: "amend", solution: "Решение.", files: [want] }] : []), { stance: "amend", solution: "Решение." }, ...agree(4)]);
    const b = scenario(`s8-${name}-2`, agree(5));
    const r = await run(["--topic", "Что в папке?", "--attach", dir, "--participant", a, "--participant", b, "--max-rounds", "2"], { COUNCIL_SCRIPTED_PROMPT_LOG: log });
    assert.equal(r.code, 0, `code ${r.code}${dump(r.p)}`);
    const prompts = promptsOf(log).filter((c) => c.participantId === promptsOf(log)[0]!.participantId);
    const lst = listingOf(prompts[0]!.prompt);
    return { lst, prompts, r };
  };
  const FOLD = /— файлов: \d+, знаков: \d+ \(перечень по запросу\)/;
  const m8 = await probe("many", many, null);
  const folded = m8.lst.split("\n").filter((l) => FOLD.test(l));
  assert.ok(m8.lst.length <= 12000 && folded.length >= 1, `listing ${m8.lst.length}, folded ${folded.length}`);
  ok(`many (3000 folders): listing ${m8.lst.length} ≤ 12000 chars, folded lines ${folded.length}`);
  const key = folded[0]!.split(" — ")[0]!;
  const m8r = await probe("many-read", many, key);
  const served = m8r.prompts.find((c) => c.prompt.includes("# Запрошенные файлы"))?.prompt ?? assert.fail(`no «Запрошенные файлы» section${dump(m8r.r.p)}`);
  const servedPart = served.slice(served.indexOf("# Запрошенные файлы"));
  assert.ok(servedPart.includes(key) && /f\.txt/.test(servedPart) && /\d+ знак/.test(servedPart), `folder listing not served:\n${servedPart.slice(0, 600)}`);
  ok(`request «${key}» returned the folder file listing with sizes in «Запрошенные файлы»`);
  const f8 = await probe("five", five, null);
  assert.ok(f8.lst.length <= 12000 && f8.lst.split("\n").some((l) => FOLD.test(l)) && f8.lst.includes("five/README.md"), `five: ${f8.lst.length}`);
  ok(`five (500 folders with long names and README.md): listing ${f8.lst.length} ≤ 12000 chars, folded lines ${f8.lst.split("\n").filter((l) => FOLD.test(l)).length}, README.md visible`);
}

let failed = false;
try {
  await main();
  console.log("Folder snapshot check in the terminal passed.");
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}\nStand left in place: ${work}`);
} finally {
  for (const k of kids) k.kill("SIGKILL");
  if (!failed) rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
