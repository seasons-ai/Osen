// Live check of local PDF materials: terminal (real council), MCP over stdio and the app's main process.
// Participants are scripted only, 0 real model calls. All files live in COUNCIL_HOME (inside the project: the collector rejects paths through symlinks).
//   COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-pdf-XXXXXX")" node packages/core/scenarios/pdf/check.ts
// The MCP and app parts run as child processes (packages/mcp/scenarios/pdf/check.ts, apps/desktop/scenarios/pdf/check.ts)
// and are compared with the terminal. Does not delete COUNCIL_HOME. Fixtures only: node packages/core/scenarios/pdf/check.ts --fixtures <folder>
import "../language-ru.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { PDF_LIMITS, extractPdfText, sha256Of } from "../../src/index.ts";
import { makeEncryptedPdf, makeImageOnlyPdf, makeMalformedPdf, makePdf, makeScanPdf } from "../../src/pdf/fixture.ts";

const repo = resolve(import.meta.dirname, "../../../..");
const EXPECTED = "Первая страница\n\nВторая страница";
const SECRET = "stand-secret-value";
const REASON = {
  locked: "PDF зашифрован — пароль не запрашивается",
  scan: "в PDF не найден текст",
  broken: "PDF повреждён",
  blank201: "в PDF больше 200 страниц без текстового слоя",
};
const MARKER = "HELPER-WAS-LAUNCHED";

function makeFixtures(fx: string) {
  mkdirSync(fx, { recursive: true });
  const w = (rel: string, data: Uint8Array | string) => { mkdirSync(join(fx, rel, ".."), { recursive: true }); writeFileSync(join(fx, rel), data); };
  w("text.pdf", makePdf(["Первая страница", "Вторая страница"]));
  w("scan.pdf", makeImageOnlyPdf());
  w("locked.pdf", makeEncryptedPdf());
  w("broken.pdf", makeMalformedPdf());
  // Real recognition needs bin/osen-ocr-fixture (npm run build:ocr); makeScanPdf throws a clear message when it is missing.
  w("ocr.pdf", makeScanPdf([["Scan page one"], ["Страница скана два"]]));
  w("mixed.pdf", makeScanPdf(["Первая страница", ["Scanned middle page"], "Третья страница"]));
  w("blank201.pdf", makePdf(Array.from({ length: 201 }, () => "")));
  w("pages2001.pdf", makePdf(Array.from({ length: 2001 }, () => "слово")));
  const fd = openSync(join(fx, "big.pdf"), "w");
  writeSync(fd, "%PDF-");
  ftruncateSync(fd, PDF_LIMITS.bytes + 1);
  closeSync(fd);
  w("proj/README.md", "# Проект\nОписание проекта для PDF-проверки.\n");
  w("proj/good.pdf", makePdf(["Хорошая страница"]));
  w("proj/broken.pdf", makeMalformedPdf());
  w("proj/scan.pdf", makeImageOnlyPdf());
  w("proj/locked.pdf", makeEncryptedPdf());
  w("proj/blank201.pdf", makePdf(Array.from({ length: 201 }, () => "")));
  w("mix6/ocr.pdf", makeScanPdf([["Scan page one"], ["Страница скана два"]]));
  w("mix6/text.pdf", makePdf(["Первая страница", "Вторая страница"]));
  w("mix6/note.txt", "Обычная заметка рядом.\n");
  w("proj/.env", `SECRET=${SECRET}\n`);
}

if (process.argv[2] === "--fixtures") {
  makeFixtures(resolve(process.argv[3] ?? "."));
  process.exit(0);
}

const home = process.env.COUNCIL_HOME;
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error('Usage: COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-pdf-XXXXXX")" node packages/core/scenarios/pdf/check.ts');
  process.exit(2);
}
if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. Usage: COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-pdf-XXXXXX")" node packages/core/scenarios/pdf/check.ts`);
  process.exit(2);
}
const work = realpathSync(resolve(home));
const fx = join(work, "fx"), scen = join(work, "scen"), cliHome = join(work, "cli");
for (const d of [scen, cliHome]) mkdirSync(d, { recursive: true });
makeFixtures(fx);
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1" };
const entry = join(repo, "packages/core/src/council.ts");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let checks = 0, skips = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };
const kids = new Set<ReturnType<typeof spawn>>();
const captured: string[] = [];

type Proc = { out: string; err: string; exited: Promise<number | null> };
function proc(command: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(command, args, { env, cwd: repo });
  kids.add(child);
  const r: Proc = { out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout.on("data", (d) => { r.out += d; });
  child.stderr.on("data", (d) => { r.err += d; });
  r.exited.then(() => captured.push(r.out, r.err));
  return r;
}
const cliEnv = { ...baseEnv, COUNCIL_HOME: cliHome };
const cli = (args: string[], extra: Record<string, string> = {}) => proc(process.execPath, [entry, ...args], { ...cliEnv, ...extra });
const dump = (p: Proc) => `\n--- stdout ---\n${p.out}\n--- stderr ---\n${p.err}`;
async function run(args: string[], extra: Record<string, string> = {}) { const p = cli(args, extra); const code = await p.exited; return { code, p }; }
async function until(what: string, fn: () => unknown, p: Proc, ms = 15000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) if (fn()) return;
  throw new Error(`timed out waiting for: ${what}${dump(p)}`);
}

type Step = { expectPrompt?: string; delayMs?: number; stance: string; solution?: string | null };
function scenario(name: string, steps: Step[]) {
  const path = join(scen, `${name}.json`);
  const body = steps.map(({ expectPrompt, delayMs, stance, solution }) => ({
    ...(expectPrompt ? { expectPrompt } : {}), ...(delayMs ? { delayMs } : {}),
    response: { stance, reasoning: "Проверка PDF.", solution: solution ?? null, answers: [], questions: [], files: [] },
  }));
  writeFileSync(path, JSON.stringify({ steps: body }));
  return `scripted:${path}`;
}
/** Agreement within three turns; every request (expectPrompt) must contain all marks. One mark per step, cycling. */
function pair(name: string, marks: string[]): string[] {
  const m = (i: number) => marks[i % marks.length];
  return [
    scenario(`${name}-p1`, [{ stance: "amend", solution: "Решение по материалам.", expectPrompt: m(0) }, { stance: "agree", expectPrompt: m(1) }, { stance: "agree", expectPrompt: m(2) }]),
    scenario(`${name}-p2`, [1, 2, 3].map((i) => ({ stance: "agree", expectPrompt: m(i) }))),
  ];
}
/** Helper stub: drains stdin and prints the given line; the sandbox forbids file writes, so a stub cannot leave traces. */
function stubHelper(name: string, body: string, mode = 0o755) {
  const f = join(scen, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, mode);
  return f;
}
const printing = (name: string, obj: unknown) => stubHelper(name, `C=$(/bin/cat)\nprintf '%s\\n' '${JSON.stringify(obj)}'`);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const parts = (p: string[]) => ["--participant", p[0]!, "--participant", p[1]!];

const sessionId = (p: Proc) => /^Сессия (\S+) ·/m.exec(p.out)?.[1] ?? assert.fail(`no "Сессия" line${dump(p)}`);
const sdir = (id: string) => join(cliHome, "sessions", id);
const events = (id: string) => readFileSync(join(sdir(id), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
const ofType = (id: string, t: string) => events(id).filter((e) => e.type === t);
const journals = () => (existsSync(join(cliHome, "sessions")) ? readdirSync(join(cliHome, "sessions")).filter((d) => existsSync(join(cliHome, "sessions", d, "events.jsonl"))) : []);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
function allFiles(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}
const hashTree = (d: string) => Object.fromEntries(allFiles(d).map((f) => [f, sha(readFileSync(f))]));

/** Child stand: ok lines are forwarded, the RESULT line is parsed. */
async function subStand(what: string, script: string, dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const p = proc(process.execPath, [join(repo, script), fx], { ...baseEnv, COUNCIL_HOME: dataDir });
  const code = await p.exited;
  const lines = p.out.split("\n");
  for (const l of lines) if (l && !l.startsWith("RESULT ")) console.log(l);
  if (code !== 0) throw new Error(`part "${what}" exited with code ${code}${p.err ? `\n${p.err}` : ""}`);
  const line = lines.find((l) => l.startsWith("RESULT "));
  assert.ok(line, `part "${what}" printed no RESULT`);
  const res = JSON.parse(line.slice(7)) as { checks: number; sha256: string; chars: number; snapshot: string; scanSha256: string; scanChars: number; scanSnapshot: string };
  checks += res.checks;
  return res;
}

async function main() {
  const srcBefore = hashTree(fx);
  const shaExp = sha256Of(EXPECTED);

  // ---- 1. Terminal, good PDF ----
  const n0 = journals().length;
  const r1 = await run(["--topic", "Что в PDF?", "--attach", join(fx, "text.pdf"), ...parts(pair("t1", ["Первая страница", "Вторая страница"])), "--max-rounds", "3"]);
  assert.equal(r1.code, 0, `code ${r1.code}${dump(r1.p)}`);
  assert.match(r1.p.out, new RegExp(`^Материалы: 1, объём ${EXPECTED.length} символов`, "m"), `expected "Материалы: 1, объём ${EXPECTED.length}" (text ${JSON.stringify(EXPECTED)})${dump(r1.p)}`);
  const id1 = sessionId(r1.p);
  const m1 = ofType(id1, "session_created")[0]!.session.materials[0];
  assert.ok(String(m1.name).endsWith("text.pdf"), `name ${m1.name}`);
  assert.deepEqual([m1.chars, m1.sha256], [EXPECTED.length, shaExp], "chars/sha256 in the journal");
  const snap1 = join(sdir(id1), "materials", "m1.txt");
  assert.equal(readFileSync(snap1, "utf8"), EXPECTED, "m1.txt snapshot");
  assert.ok(ofType(id1, "turn_completed").length >= 2, "turns did not happen (did expectPrompt break the scenario?)");
  assert.ok(!ofType(id1, "turn_failed").length, `there were turn_failed${dump(r1.p)}`);
  ok(`terminal: code 0, "Материалы: 1, объём ${EXPECTED.length}", the journal has text.pdf with chars and sha256 of the text, m1.txt equals the text, turns passed with expectPrompt "Первая страница"/"Вторая страница"`);
  assert.ok(![readFileSync(join(sdir(id1), "events.jsonl"), "utf8"), readFileSync(snap1, "utf8"), r1.p.out].some((t) => t.includes("%PDF")), "%PDF in output, journal or snapshot");
  ok("no \"%PDF\" in stdout, events.jsonl or the snapshot");
  assert.equal(journals().length, n0 + 1);

  // ---- 2. Snapshot after the source is deleted ----
  copyFileSync(join(fx, "text.pdf"), join(fx, "copy.pdf"));
  const slow = [
    scenario("t2-p1", [0, 1, 2, 3, 4, 5].map((i) => ({ stance: i < 3 ? "amend" : "agree", solution: i < 3 ? "Предварительное решение." : null, expectPrompt: "Первая страница" }))),
    scenario("t2-p2", [{ delayMs: 5000, stance: "object", expectPrompt: "Вторая страница" }, ...[1, 2, 3, 4].map(() => ({ stance: "agree", expectPrompt: "Вторая страница" }))]),
  ];
  const r2 = cli(["--topic", "Что в PDF после удаления?", "--attach", join(fx, "copy.pdf"), ...parts(slow), "--max-rounds", "2"]);
  await until("session line", () => /^Сессия \S+ ·/m.test(r2.out), r2);
  const id2 = sessionId(r2);
  await until("turn_completed of turn 1", () => ofType(id2, "turn_completed").length >= 1, r2);
  const st = await run(["stop", id2]);
  assert.equal(st.code, 0, `stop: ${st.code}${dump(st.p)}`);
  assert.equal(await r2.exited, 4, `exit code of the stopped session${dump(r2)}`);
  const h2 = hashTree(join(sdir(id2), "materials")), sha2 = ofType(id2, "session_created")[0]!.session.materials[0].sha256;
  assert.equal(sha2, shaExp);
  rmSync(join(fx, "copy.pdf"));
  const turnsBefore = ofType(id2, "turn_completed").length;
  const rs = await run(["resume", id2, "--rounds", "2"]);
  assert.equal(rs.code, 0, `resume: code ${rs.code}${dump(rs.p)}`);
  assert.ok(ofType(id2, "turn_completed").length > turnsBefore && !ofType(id2, "turn_failed").length, `after resume there are no new turns or there is turn_failed${dump(rs.p)}`);
  assert.deepEqual(hashTree(join(sdir(id2), "materials")), h2, "snapshot changed");
  assert.equal(ofType(id2, "session_created")[0]!.session.materials[0].sha256, shaExp);
  ok("stopped session (code 4), source PDF deleted, resume: code 0, new turns passed with the PDF text in the request (expectPrompt), snapshot hash and sha256 in the journal unchanged");

  // ---- 6. Rejections and folder (terminal) ----
  const okPair = pair("t6", ["Первая страница"]);
  for (const [f, reason] of Object.entries(REASON)) {
    const n = journals().length;
    const r = await run(["--topic", "t", "--attach", join(fx, `${f}.pdf`), ...parts(okPair), "--max-rounds", "1"]);
    assert.equal(r.code, 2, `${f}.pdf: code ${r.code}${dump(r)}`);
    assert.ok(r.p.err.includes("Материалы не приняты:") && r.p.err.includes(reason), `${f}.pdf: rejection text${dump(r.p)}`);
    assert.equal(journals().length, n, `${f}.pdf: a session appeared`);
  }
  ok("terminal, explicit locked/scan/broken/blank201 (real helper, 201 blank pages are refused before it starts): code 2, \"Материалы не приняты:\" and its own reason, no new sessions");
  const rf = await run(["--topic", "Папка с PDF", "--attach", join(fx, "proj"), ...parts(pair("t6f", ["Хорошая страница", "Описание проекта"])), "--max-rounds", "3"]);
  assert.equal(rf.code, 0, dump(rf.p));
  assert.match(rf.p.out, /^Материалы: 2, /m, dump(rf.p));
  const skippedText = rf.p.out.slice(rf.p.out.indexOf("Пропущено:"));
  assert.match(skippedText, /^Пропущено: 5$/m, dump(rf.p));
  const skippedLines = skippedText.split("\n").filter((l) => l.startsWith("  "));
  for (const [f, reason] of Object.entries(REASON)) assert.ok(skippedLines.some((l) => l.includes(`proj/${f}.pdf`) && l.includes(reason)), `missing "${f}.pdf — ${reason}":\n${skippedText}`);
  const envLine = skippedLines.find((l) => l.includes("proj/.env"));
  assert.ok(envLine, `no .env among the skipped:\n${skippedText}`);
  const idf = sessionId(rf.p);
  const names = (ofType(idf, "session_created")[0]!.session.materials as { name: string }[]).map((m) => m.name);
  assert.ok(names.some((n) => n.endsWith("README.md")) && names.some((n) => n.endsWith("good.pdf")) && names.length === 2, `collected: ${names}`);
  ok(`terminal, folder: "Пропущено: 5" — four PDFs with their own reasons and "${envLine.trim()}"; README.md and good.pdf collected`);


  // ---- Scanned PDFs (real osen-ocr unless a stub is named) ----
  const ocrBytes = new Uint8Array(readFileSync(join(fx, "ocr.pdf")));
  const rec = extractPdfText(ocrBytes);
  assert.ok(rec.ok, `real recognition of ocr.pdf failed (run: npm run build:ocr): ${JSON.stringify(rec)}`);
  const SCAN = rec.text, scanPages = SCAN.split("\n\n");
  assert.equal(scanPages.length, 2, `pages of the recognized text: ${JSON.stringify(SCAN)}`);
  assert.ok(norm(scanPages[0]!).includes("scan page one") && norm(scanPages[1]!).includes("страница скана два"), `recognized: ${JSON.stringify(SCAN)}`);
  const nS = journals().length;
  const rs1 = await run(["--topic", "Что в скане?", "--attach", join(fx, "ocr.pdf"), ...parts(pair("s1", scanPages)), "--max-rounds", "3"]);
  assert.equal(rs1.code, 0, `code ${rs1.code}${dump(rs1.p)}`);
  assert.match(rs1.p.out, new RegExp(`^Материалы: 1, объём ${SCAN.length} символов`, "m"), dump(rs1.p));
  const ids1 = sessionId(rs1.p);
  const sm = ofType(ids1, "session_created")[0]!.session.materials[0];
  assert.ok(String(sm.name).endsWith("ocr.pdf"));
  assert.deepEqual([sm.chars, sm.sha256], [SCAN.length, sha256Of(SCAN)]);
  const scanSnap = join(sdir(ids1), "materials", "m1.txt");
  assert.equal(readFileSync(scanSnap, "utf8"), SCAN, "m1.txt of the scan");
  assert.ok(ofType(ids1, "turn_completed").length >= 2 && !ofType(ids1, "turn_failed").length, `turns of the scan session${dump(rs1.p)}`);
  assert.equal(journals().length, nS + 1);
  ok(`terminal, scan ocr.pdf (real osen-ocr): code 0, "Материалы: 1, объём ${SCAN.length}", two pages joined by an empty line, the journal sha256/chars and m1.txt equal the in-process recognition, turns passed with the recognized pages in the request`);

  // Scan: stop a slow session, delete the source, resume from the snapshot.
  copyFileSync(join(fx, "ocr.pdf"), join(fx, "ocr-copy.pdf"));
  const w0 = scanPages[0]!, w1 = scanPages[1]!;
  const slowScan = [
    scenario("s1r-p1", [0, 1, 2, 3, 4, 5].map((i) => ({ stance: i < 3 ? "amend" : "agree", solution: i < 3 ? "Предварительное решение." : null, expectPrompt: w0 }))),
    scenario("s1r-p2", [{ delayMs: 5000, stance: "object", expectPrompt: w1 }, ...[1, 2, 3, 4].map(() => ({ stance: "agree", expectPrompt: w1 }))]),
  ];
  const r1r = cli(["--topic", "Что в скане после удаления?", "--attach", join(fx, "ocr-copy.pdf"), ...parts(slowScan), "--max-rounds", "2"]);
  await until("session line (scan)", () => /^Сессия \S+ ·/m.test(r1r.out), r1r);
  const id1r = sessionId(r1r);
  await until("turn_completed of turn 1 (scan)", () => ofType(id1r, "turn_completed").length >= 1, r1r);
  assert.equal((await run(["stop", id1r])).code, 0);
  assert.equal(await r1r.exited, 4, `exit code of the stopped scan session${dump(r1r)}`);
  const h1r = hashTree(join(sdir(id1r), "materials")), sha1r = ofType(id1r, "session_created")[0]!.session.materials[0].sha256;
  assert.equal(sha1r, sha256Of(SCAN));
  rmSync(join(fx, "ocr-copy.pdf"));
  const turns1r = ofType(id1r, "turn_completed").length;
  const rr = await run(["resume", id1r, "--rounds", "2"]);
  assert.equal(rr.code, 0, `resume of the scan: code ${rr.code}${dump(rr.p)}`);
  assert.ok(ofType(id1r, "turn_completed").length > turns1r && !ofType(id1r, "turn_failed").length, `scan resume produced no new turns or has turn_failed${dump(rr.p)}`);
  assert.deepEqual(hashTree(join(sdir(id1r), "materials")), h1r, "scan snapshot changed");
  assert.equal(ofType(id1r, "session_created")[0]!.session.materials[0].sha256, sha256Of(SCAN));
  ok("scan: stopped session (code 4), source deleted, resume: code 0, new turns with the recognized pages in the request (expectPrompt), snapshot hash and sha256 unchanged");

  const nM = journals().length;
  const rm = await run(["--topic", "Что в смешанном PDF?", "--attach", join(fx, "mixed.pdf"), ...parts(pair("s2", ["Первая страница", "Третья страница"])), "--max-rounds", "3"]);
  assert.equal(rm.code, 0, dump(rm.p));
  const mixed = readFileSync(join(sdir(sessionId(rm.p)), "materials", "m1.txt"), "utf8").split("\n\n");
  assert.equal(mixed.length, 3, JSON.stringify(mixed));
  assert.equal(mixed[0], "Первая страница");
  assert.ok(norm(mixed[1]!).includes("scanned middle page"), JSON.stringify(mixed));
  assert.equal(mixed[2], "Третья страница");
  assert.equal(journals().length, nM + 1);
  ok("terminal, mixed.pdf: pages in order 1, 2 (recognized), 3; the text-layer pages are exactly the PDF.js text");

  const launched = printing("launched.sh", { ok: true, pages: [{ n: 1, lines: [{ t: MARKER, x: 0, y: 0, w: 0.5, h: 0.1 }] }] });
  const withHelper = (helper: string, lang = "ru") => ({ COUNCIL_OCR_HELPER: helper, COUNCIL_LANG: lang });
  const refuse = async (f: string, reason: string, extra: Record<string, string>, head = "Материалы не приняты:") => {
    const n = journals().length;
    const r = await run(["--topic", "t", "--attach", join(fx, f), ...parts(okPair), "--max-rounds", "1"], extra);
    assert.equal(r.code, 2, `${f}: code ${r.code}${dump(r.p)}`);
    assert.ok(r.p.err.includes(head) && r.p.err.includes(reason), `${f}: expected «${reason}»${dump(r.p)}`);
    assert.ok(![r.p.out, r.p.err].some((t) => t.includes("%PDF") || t.includes("Traceback")), `${f}: noise in the output`);
    assert.equal(journals().length, n, `${f}: a session appeared`);
  };

  await refuse("scan.pdf", "PDF has no text", { COUNCIL_LANG: "en" }, "Materials not accepted:");
  ok("terminal, image-only scan.pdf with COUNCIL_LANG=en: code 2, \"Materials not accepted:\", \"PDF has no text\"; no session");

  await refuse("blank201.pdf", REASON.blank201, withHelper(launched));
  const rf4 = await run(["--topic", "Папка с PDF", "--attach", join(fx, "proj"), ...parts(pair("t4f", ["Хорошая страница"])), "--max-rounds", "3"]);
  assert.equal(rf4.code, 0, dump(rf4.p));
  assert.ok(rf4.p.out.split("\n").some((l) => l.includes("proj/blank201.pdf") && l.includes(REASON.blank201)), `folder, blank201:${dump(rf4.p)}`);
  const names4 = (ofType(sessionId(rf4.p), "session_created")[0]!.session.materials as { name: string }[]).map((m) => m.name);
  assert.ok(names4.some((n) => n.endsWith("README.md")) && names4.some((n) => n.endsWith("good.pdf")) && names4.length === 2, `folder collected: ${names4}`);
  ok(`terminal, 201 blank pages with a helper stub that prints ${MARKER}: code 2 «${REASON.blank201}» for the file; in the folder (real helper: the stub would turn the image-only scan into text) it is skipped with that reason; the stub's marker never appears (checked at the end over all output and journals)`);

  await refuse("ocr.pdf", "распознавание текста PDF дольше 5 секунд на страницу", withHelper(printing("page-timeout.sh", { ok: false, code: "page_timeout" })));
  await refuse("ocr.pdf", "распознавание текста PDF дольше 300 секунд", withHelper(printing("timeout.sh", { ok: false, code: "timeout" })));
  ok("terminal, helper stubs answering page_timeout and timeout: code 2 with «дольше 5 секунд на страницу» and «дольше 300 секунд», no session, no partial text");

  const missing = join(work, "no-such-helper");
  const noExec = stubHelper("no-exec.sh", "exit 0", 0o644);
  await refuse("ocr.pdf", "распознавание текста недоступно — нет помощника osen-ocr", withHelper(missing));
  await refuse("ocr.pdf", "text recognition is unavailable — the osen-ocr helper is missing", withHelper(missing, "en"), "Materials not accepted:");
  await refuse("ocr.pdf", "распознавание текста недоступно — не удалось запустить помощника osen-ocr", withHelper(noExec));
  for (const [what, helper, reason] of [["missing", missing, "нет помощника osen-ocr"], ["without the exec bit", noExec, "не удалось запустить помощника osen-ocr"]] as const) {
    const r6 = await run(["--topic", "Папка со сканом", "--attach", join(fx, "mix6"), ...parts(pair(`t6${what[0]}`, ["Первая страница", "Обычная заметка"])), "--max-rounds", "3"], withHelper(helper));
    assert.equal(r6.code, 0, dump(r6.p));
    assert.match(r6.p.out, /^Материалы: 2, /m, dump(r6.p));
    assert.ok(r6.p.out.split("\n").some((l) => l.includes("mix6/ocr.pdf") && l.includes(reason)), `${what}:${dump(r6.p)}`);
    const names6 = (ofType(sessionId(r6.p), "session_created")[0]!.session.materials as { name: string }[]).map((m) => m.name);
    assert.ok(names6.some((n) => n.endsWith("text.pdf")) && names6.some((n) => n.endsWith("note.txt")) && names6.length === 2, `${what}: ${names6}`);
  }
  ok("terminal, helper missing (ru and en) and a stub without the exec bit: code 2 with the matching reason; in a folder the scan is skipped while the text-layer PDF and the .txt are still read");

  await refuse("locked.pdf", REASON.locked, withHelper(launched));
  ok(`terminal, locked.pdf with the ${MARKER} stub: «${REASON.locked}», the helper is not reached`);

  // ---- 7. Link and script ----
  let connections = 0;
  const server = net.createServer((s) => { connections++; s.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  writeFileSync(join(fx, "link.pdf"), makePdf(["Текст со ссылкой"], { link: `http://127.0.0.1:${port}/x`, openActionJs: "app.alert('x')" }));
  const rl = await run(["--topic", "PDF со ссылкой", "--attach", join(fx, "link.pdf"), ...parts(pair("t7", ["Текст со ссылкой"])), "--max-rounds", "3"]);
  assert.equal(rl.code, 0, dump(rl.p));
  assert.equal(readFileSync(join(sdir(sessionId(rl.p)), "materials", "m1.txt"), "utf8"), "Текст со ссылкой");
  await sleep(300);
  assert.equal(connections, 0, `the local server got ${connections} connections`);
  ok("PDF with a link and a script: material text \"Текст со ссылкой\", 0 connections to the local server");

  // ---- 8. Real limits ----
  const nL = journals().length;
  const t0 = Date.now();
  const rb = await run(["--topic", "t", "--attach", join(fx, "big.pdf"), ...parts(okPair), "--max-rounds", "1"]);
  const dt = Date.now() - t0;
  assert.equal(rb.code, 2, dump(rb.p));
  assert.ok(rb.p.err.includes("Материалы не приняты:") && rb.p.err.includes("PDF больше 100 МиБ"), dump(rb.p));
  assert.ok(dt < 5000, `big.pdf rejected in ${dt} ms`);
  ok(`terminal, file of ${PDF_LIMITS.bytes + 1} bytes: code 2, "PDF больше 100 МиБ", in ${dt} ms`);
  const rp = await run(["--topic", "t", "--attach", join(fx, "pages2001.pdf"), ...parts(okPair), "--max-rounds", "1"]);
  assert.equal(rp.code, 2, dump(rp.p));
  assert.ok(rp.p.err.includes("Материалы не приняты:") && rp.p.err.includes("в PDF больше 2000 страниц"), dump(rp.p));
  assert.equal(journals().length, nL, "a session appeared");
  ok("terminal, 2001 pages: code 2, \"в PDF больше 2000 страниц\"; no new sessions");

  // ---- 9. Limits that are expensive to reach in full ----
  const bytes = new Uint8Array(readFileSync(join(fx, "text.pdf")));
  const cut = extractPdfText(bytes, { ...PDF_LIMITS, chars: EXPECTED.length - 1 });
  assert.deepEqual(cut, { ok: false, code: "chars" });
  const fit = extractPdfText(bytes, { ...PDF_LIMITS, chars: EXPECTED.length });
  assert.ok(fit.ok && fit.text === EXPECTED, JSON.stringify(fit));
  ok(`the character limit is not reached at 20000000 in full, so it is checked on a real child process with chars=${EXPECTED.length - 1} (chars rejection) and chars=${EXPECTED.length} (text accepted)`);
  const supervise = (extra: object, worker: string) => {
    const arg = JSON.stringify({ pages: PDF_LIMITS.pages, chars: PDF_LIMITS.chars, ms: PDF_LIMITS.ms, rssBytes: PDF_LIMITS.rssBytes, ...extra, worker: join(repo, "packages/core/src/pdf/testdata", worker) });
    return spawnSync(process.execPath, [join(repo, "packages/core/src/pdf/pdf-extract.ts"), arg], { input: new Uint8Array(), timeout: 20000, maxBuffer: 2 ** 26, env: {} });
  };
  const gone = (pid: number | undefined) => { try { process.kill(pid!, 0); return false; } catch { return true; } };
  const th = supervise({ ms: 400 }, "worker-hang.ts");
  assert.equal(th.status, 0);
  assert.equal(th.stdout.toString(), '{"ok":false,"code":"timeout"}\n');
  assert.ok(gone(th.pid), "extraction process is alive");
  const tm = supervise({ ms: 15000, rssBytes: 300 * 2 ** 20 }, "worker-memory.ts");
  assert.equal(tm.status, 0);
  assert.equal(tm.stdout.toString(), '{"ok":false,"code":"memory"}\n');
  assert.ok(gone(tm.pid), "extraction process is alive");
  ok("time (30 s) and memory (512 MiB) are not reached in full: the real pdf-extract.ts with a test worker gives exactly one line timeout (ms=400) and memory (rssBytes=300 MiB), code 0, no process left");

  // ---- 10. Texts without recognition promises ----
  const help = spawnSync(process.execPath, [entry, "--help"], { env: cliEnv, encoding: "utf8" });
  assert.ok(help.stdout.includes("Из PDF берётся текстовый слой") && help.stdout.includes("PDF в том числе сканы"), `council --help:\n${help.stdout.slice(0, 300)}`);
  ok("council --help: \"Из PDF берётся текстовый слой\" and \"PDF в том числе сканы\"");

  // ---- 11. Built extractor ----
  const built = join(repo, "apps/desktop/out/main/pdf-extract.mjs");
  const electron = join(repo, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const arg = JSON.stringify({ pages: PDF_LIMITS.pages, chars: PDF_LIMITS.chars, ms: PDF_LIMITS.ms, rssBytes: PDF_LIMITS.rssBytes });
  const textOf = (r: ReturnType<typeof spawnSync>) => { const j = JSON.parse(r.stdout.toString().trim()); return j.ok ? j.text : `REJECTED ${JSON.stringify(j)}`; };
  // The old refusal reason must be gone from the sources, docs and mockups (the literal is split so this file does not match itself).
  const OLD = ["в PDF нет", " текстового слоя", " — распознавание не выполняется"].join("");
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "out" || e.name === "bin" || e.name === "release" || e.name === "dist" || e.name.startsWith(".")) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && statSync(f).size < 4 * 2 ** 20 && readFileSync(f, "utf8").includes(OLD)) hits.push(f);
    }
  };
  for (const d of ["packages", "docs", "design"]) if (existsSync(join(repo, d))) walk(join(repo, d));
  assert.deepEqual(hits, [], "the old «no text layer» reason is still present");
  ok("the old no-text-layer refusal reason is absent from packages/, docs/, design/");
  const sourceScan = spawnSync(process.execPath, [join(repo, "packages/core/src/pdf/pdf-extract.ts"), arg], { input: ocrBytes, env: {}, timeout: 30000, maxBuffer: 2 ** 26 });
  assert.equal(sourceScan.status, 0, sourceScan.stderr.toString());
  const sourceReply = sourceScan.stdout.toString();
  const sj = JSON.parse(sourceReply);
  assert.ok(sj.ok === true && sj.pages === 2 && JSON.stringify(sj.blank) === "[1,2]" && Array.isArray(sj.parts), sourceReply);
  if (existsSync(built)) {
    const rbn = spawnSync(process.execPath, [built, arg], { input: ocrBytes, env: {}, timeout: 30000, maxBuffer: 2 ** 26 });
    assert.equal(rbn.stdout.toString(), sourceReply, "built stage reply ≠ source stage reply for the scan (plain Node)");
    ok("built pdf-extract.mjs on ocr.pdf, plain Node: the stage reply {ok,pages,parts,blank} equals the source reply byte for byte (recognition itself runs in the main process)");
    if (existsSync(electron)) {
      const rbe = spawnSync(electron, [built, arg], { input: ocrBytes, env: { ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000, maxBuffer: 2 ** 26 });
      assert.equal(rbe.stdout.toString(), sourceReply, "built stage reply ≠ source stage reply for the scan (Electron)");
      ok("built pdf-extract.mjs on ocr.pdf, Electron with ELECTRON_RUN_AS_NODE=1: same stage reply");
    }
  }
  if (existsSync(built)) {
    const rn = spawnSync(process.execPath, [built, arg], { input: bytes, env: {}, timeout: 30000, maxBuffer: 2 ** 26 });
    assert.equal(rn.status, 0, rn.stderr.toString());
    assert.equal(textOf(rn), EXPECTED);
    ok("built pdf-extract.mjs, plain Node with an empty environment: same text");
    if (existsSync(electron)) {
      const re = spawnSync(electron, [built, arg], { input: bytes, env: { ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000, maxBuffer: 2 ** 26 });
      assert.equal(re.status, 0, re.stderr.toString());
      assert.equal(textOf(re), EXPECTED);
      ok("built pdf-extract.mjs, Electron with ELECTRON_RUN_AS_NODE=1 only: same text");
    } else { skips++; console.log("skipped: no Electron binary (npm install)"); }
  } else { skips++; console.log("skipped: no app build (npm run build -w @model-council/desktop)"); }

  // ---- MCP and app parts ----
  const mcp = await subStand("MCP", "packages/mcp/scenarios/pdf/check.ts", join(work, "mcp"));
  const desk = await subStand("app", "apps/desktop/scenarios/pdf/check.ts", join(work, "desktop"));

  // ---- 5. Parity ----
  for (const [what, r] of [["terminal", { sha256: m1.sha256, chars: m1.chars, snapshot: snap1 }], ["MCP", mcp], ["app", desk]] as const) {
    assert.equal(r.sha256, shaExp, `${what}: sha256 ${r.sha256} ≠ ${shaExp}`);
    assert.equal(r.chars, EXPECTED.length, `${what}: chars ${r.chars} ≠ ${EXPECTED.length}`);
    assert.equal(readFileSync(r.snapshot, "utf8"), EXPECTED, `${what}: snapshot ≠ expected text`);
  }
  assert.ok(readFileSync(snap1).equals(readFileSync(mcp.snapshot)) && readFileSync(snap1).equals(readFileSync(desk.snapshot)), "snapshots differ byte by byte");
  ok(`parity: sha256 ${shaExp.slice(0, 12)}… and chars ${EXPECTED.length} are identical in the terminal, MCP and app; three snapshots are byte-equal`);

  const shaScan = sha256Of(SCAN);
  for (const [what, r] of [["terminal", { scanSha256: sm.sha256, scanChars: sm.chars, scanSnapshot: scanSnap }], ["MCP", mcp], ["app", desk]] as const) {
    assert.equal(r.scanSha256, shaScan, `${what}: scan sha256 ${r.scanSha256} ≠ ${shaScan}`);
    assert.equal(r.scanChars, SCAN.length, `${what}: scan chars`);
    assert.equal(readFileSync(r.scanSnapshot, "utf8"), SCAN, `${what}: scan snapshot ≠ recognized text`);
  }
  ok(`parity of the scan: sha256 ${shaScan.slice(0, 12)}… and chars ${SCAN.length} are identical in the terminal, MCP and app; snapshots equal the in-process recognition`);

  // ---- Final checks ----
  const secretZones = [...captured, ...allFiles(cliHome).map((f) => readFileSync(f, "utf8"))];
  assert.ok(!secretZones.some((t) => t.includes(SECRET)), "the .env control string was found in the output or files of the terminal part");
  ok("the .env control string is absent from the output, journals, snapshots and app.log of the terminal part");
  assert.ok(!secretZones.some((t) => t.includes(MARKER)), `${MARKER} reached the output or a journal: a helper stub was launched where it must not be`);
  ok(`${MARKER} (printed by the stub helper) is absent from all output, journals and snapshots of the terminal part`);
  for (const [f, h] of Object.entries(srcBefore)) assert.equal(sha(readFileSync(f)), h, `${f} changed`);
  ok("source files (PDFs, proj folder) are byte-identical after all parts");
  server.close();
  ok("0 real model calls: all parts use scripted participants only");
}

let failed = false;
const guard = setTimeout(() => { console.error(`FAILED: the stand did not finish within 300 seconds\nStand left in place: ${work}`); for (const k of kids) k.kill("SIGKILL"); process.exit(1); }, 300000);
try {
  await main();
  console.log(`Result: all checks passed (${checks})${skips ? `, skipped ${skips}` : ", skipped 0"}`);
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}\nStand left in place: ${work}`);
} finally {
  clearTimeout(guard);
  for (const k of kids) k.kill("SIGKILL");
}
process.exit(failed ? 1 : 0);
