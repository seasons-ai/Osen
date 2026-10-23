// Live check of a ZIP archive attached as a folder: terminal (real council), MCP over stdio, the app's main process and the bundled document extractor.
// Participants are scripted only, 0 real model calls. Text steps run twice, on ru and on en (process language, COUNCIL_LANG of the child processes).
//   COUNCIL_DEV=1 [COUNCIL_HOME=<new empty folder>] node packages/core/scenarios/zip-archive/check.ts
// Run `npm run build -w @model-council/desktop` first: step 10 needs apps/desktop/out/main/doc-extract.mjs.
// Without COUNCIL_HOME the stand creates a folder in the system temporary folder and always deletes it, also on failure (rerun with COUNCIL_HOME to inspect the data).
// With COUNCIL_HOME (a new empty folder, e.g. inside the project) it uses that folder and does not delete it.
// The MCP and app parts run as child processes (packages/mcp/scenarios/zip-archive/check.ts, apps/desktop/scenarios/zip-archive/check.ts).
// Archives are generated in code (packages/core/src/documents/fixture.ts), no binary files.
import "../language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, readSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { collectMaterials, setDocumentExtractorRuntime, setProcessLanguage } from "../../src/index.ts";
import { listArchiveEntries, readArchiveEntries } from "../../src/documents/archive-run.ts";
import { makeDocx, makeZip, p } from "../../src/documents/fixture.ts";
import { materialsMessages } from "../../src/messages/materials.ts";
import { setOcrRuntime } from "../../src/ocr/run.ts";
import { writeExecutable } from "../../src/executable.testutil.ts";

const repo = resolve(import.meta.dirname, "../../../..");
const home = process.env.COUNCIL_HOME;
const usage = "COUNCIL_DEV=1 [COUNCIL_HOME=<new empty folder>] node packages/core/scenarios/zip-archive/check.ts";
if (process.env.COUNCIL_DEV !== "1") { console.error(`Usage: ${usage}`); process.exit(2); }
if (home && (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. Usage: ${usage}`);
  process.exit(2);
}
const bundle = join(repo, "apps/desktop/out/main/doc-extract.mjs");
if (!existsSync(bundle)) {
  console.error(`The bundled extractor ${bundle} is missing. Run: npm run build -w @model-council/desktop`);
  process.exit(2);
}
const work = home ? realpathSync(resolve(home)) : mkdtempSync(join(realpathSync(tmpdir()), "zip-archive-check-"));
const fx = join(work, "fx"), scen = join(work, "scen");
for (const d of [fx, scen]) mkdirSync(d, { recursive: true });
const SECRET = "stand-secret-value-zip";
const MARK = "МАРКЕР-АРХИВ-7";

// ---- Fixtures and the texts they must give (written out by hand, not taken from the collector) ----
const README = "читай";
const SPEC = "Первая строка";
const ATS = `// ${MARK}\nconst a = 1;`;
const PROJ_NAMES = ["proj.zip/README.md", "proj.zip/docs/spec.docx", "proj.zip/src/a.ts"];
const PROJ_TEXTS = [README, SPEC, ATS];
const PROJ_CHARS = PROJ_TEXTS.reduce((s, t) => s + t.length, 0);
const projZip = () => makeZip([
  { name: "README.md", data: README }, { name: "src/a.ts", data: ATS },
  { name: "docs/spec.docx", data: makeDocx({ body: p(SPEC) }) },
  { name: ".gitignore", data: "out/\n" }, { name: "out/main.js", data: "x" }, { name: ".env", data: `API_KEY=${SECRET}\n` }, { name: "__MACOSX/x", data: "x" },
]);
const sha = (b: Uint8Array | string) => createHash("sha256").update(typeof b === "string" ? Buffer.from(b, "utf8") : b).digest("hex");
const put = (rel: string, data: Uint8Array | string): string => {
  const f = join(fx, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, data);
  return f;
};
// Header-valid PNG without pixels: enough for a stub OCR helper.
function png(): Buffer {
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(10), u32(10), Buffer.alloc(5)]);
}
let stubN = 0;
const ocrStub = (reply: unknown) => setOcrRuntime({ helper: writeExecutable(join(work, `ocr-stub-${stubN++}.sh`), `#!/bin/sh\nC=$(/bin/cat)\nprintf '%s\\n' '${JSON.stringify(reply)}'\n`) });
const OCR_OK = { ok: true, lines: [{ t: "stub text", x: 0, y: 0, w: 1, h: 0.1 }] };
// Substitute extractor: a ZIP is not a document; in the entry-listing mode it fails the way the test asks (MODE).
const FAIL_STUB = `for await (const c of process.stdin);
if (!JSON.parse(process.argv[2]).mode) { process.stdout.write('{"ok":false,"code":"unsupported"}\\n'); process.exit(0); }
if (process.env.MODE === "exit") process.exit(3);
if (process.env.MODE === "signal") process.kill(process.pid, "SIGKILL");
process.stdout.write('{"ok":false,"code":"failed","detail":"worker exit"}\\n');
`;
// Names are written out by hand: "Отчёт.txt" in CP866.
const CP866_REPORT = Uint8Array.from([0x8e, 0xe2, 0xe7, 0xf1, 0xe2, 0x2e, 0x74, 0x78, 0x74]);
const cp866Zip = () => makeZip([{ name: "readme.txt", data: "читай" }, { name: CP866_REPORT, data: "отчёт" }]);
const method12Zip = () => makeZip([{ name: "a.txt", data: "a", method: 0 }, { name: "b.txt", data: "b", method: 12 }]);
const sparseZip = (rel: string): string => {
  const f = put(rel, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  truncateSync(f, 150 * 2 ** 20);
  return f;
};

interface Texts { session: RegExp; summary: (n: number, chars: number) => string; rejected: string; folderHeader: string }
const T: Record<"ru" | "en", Texts> = {
  ru: { session: /^Сессия (\S+) ·/m, summary: (n, c) => `Материалы: ${n}, объём ${c} символов`, rejected: "Материалы не приняты:", folderHeader: "# Папка владельца" },
  en: { session: /^Session (\S+) ·/m, summary: (n, c) => `Materials: ${n}, size ${c} characters`, rejected: "Materials not accepted:", folderHeader: "# Owner's folder" },
};

// ---- Processes ----
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_DEV: "1" };
const entry = join(repo, "packages/core/src/council.ts");
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kids = new Set<ReturnType<typeof spawn>>();
type Proc = { out: string; err: string; exited: Promise<number | null> };
function proc(command: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(command, args, { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  kids.add(child);
  const r: Proc = { out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout.on("data", (d) => { r.out += d; });
  child.stderr.on("data", (d) => { r.err += d; });
  return r;
}
const dump = (r: Proc) => `\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}`;
function allFiles(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}
const readHead = (f: string, n: number): Buffer => { const fd = openSync(f, "r"); try { const b = Buffer.alloc(n); const k = readSync(fd, b, 0, n, 0); return b.subarray(0, k); } finally { closeSync(fd); } };

type Step = { expectPrompt?: string; delayMs?: number; stance: string; solution?: string | null; files?: string[] };
function scenario(name: string, steps: Step[]) {
  const path = join(scen, `${name}.json`);
  const body = steps.map(({ expectPrompt, delayMs, stance, solution, files }) => ({
    ...(expectPrompt ? { expectPrompt } : {}), ...(delayMs ? { delayMs } : {}),
    response: { stance, reasoning: "Проверка архива.", solution: solution ?? null, answers: [], questions: [], files: files ?? [] },
  }));
  writeFileSync(path, JSON.stringify({ steps: body }));
  return `scripted:${path}`;
}
const agree = (n: number): Step[] => Array.from({ length: n }, () => ({ stance: "agree" }));
/** Agreement within three turns. */
function pair(name: string): string[] {
  return [scenario(`${name}-p1`, [{ stance: "amend", solution: "Решение по материалам." }, ...agree(2)]), scenario(`${name}-p2`, agree(3))];
}
const parts = (p2: string[]) => ["--participant", p2[0]!, "--participant", p2[1]!];

type Material = { name: string; sha256: string; text: string };
/** Child stand: ok lines are forwarded, the RESULT line is parsed. */
async function subStand(what: string, script: string, dataDir: string, lang: string, archive: string) {
  mkdirSync(dataDir, { recursive: true });
  const r = proc(process.execPath, [join(repo, script), archive, lang], { ...baseEnv, COUNCIL_LANG: lang, COUNCIL_HOME: dataDir });
  const code = await r.exited;
  const lines = r.out.split("\n");
  for (const l of lines) if (l && !l.startsWith("RESULT ")) console.log(l);
  if (code !== 0) throw new Error(`part "${what}" (${lang}) exited with code ${code}${r.err ? `\n${r.err}` : ""}`);
  const line = lines.find((l) => l.startsWith("RESULT "));
  assert.ok(line, `part "${what}" printed no RESULT`);
  const res = JSON.parse(line.slice(7)) as { checks: number; materials: (Material & { chars: number })[]; workspace: { files: number; chars: number } };
  checks += res.checks;
  return res;
}

async function suite(lang: "ru" | "en") {
  const t = T[lang];
  setProcessLanguage(lang);
  const m = materialsMessages();
  const tag = `[${lang}]`;
  const cliHome = join(work, `cli-${lang}`), promptLog = join(work, `prompts-${lang}.jsonl`);
  mkdirSync(cliHome, { recursive: true });
  const cliEnv = { ...baseEnv, COUNCIL_LANG: lang, COUNCIL_HOME: cliHome, COUNCIL_SCRIPTED_PROMPT_LOG: promptLog, OPENAI_API_KEY: SECRET, ANTHROPIC_API_KEY: SECRET };
  const start = (args: string[]) => proc(process.execPath, [entry, ...args], cliEnv);
  const run = async (args: string[]) => { const r = start(args); const code = await r.exited; return { code, r }; };
  const sdir = (id: string) => join(cliHome, "sessions", id);
  const events = (id: string) => readFileSync(join(sdir(id), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  const created = (id: string) => events(id).find((e) => e.type === "session_created")!.session;
  const journals = () => (existsSync(join(cliHome, "sessions")) ? readdirSync(join(cliHome, "sessions")).filter((d) => existsSync(join(cliHome, "sessions", d, "events.jsonl"))) : []);
  const sessionId = (r: Proc) => t.session.exec(r.out)?.[1] ?? assert.fail(`no session line${dump(r)}`);
  const promptLines = () => (existsSync(promptLog) ? readFileSync(promptLog, "utf8").split("\n").filter(Boolean) : []);
  const preview = async (...paths: string[]) => { const r = await run([...paths.flatMap((x) => ["--attach", x]), "--preview-materials"]); assert.equal(r.code, 0, `preview exit code ${r.code}${dump(r.r)}`); return r.r.out; };
  const session = (name: string, paths: string[], extra: string[] = []) => ["--topic", "Что в архиве?", ...paths.flatMap((x) => ["--attach", x]), ...parts(pair(`${lang}-${name}`)), "--max-rounds", "3", ...extra];
  const skipLine = (out: string, name: string, reason: string) => assert.ok(out.split("\n").includes(`  ${name} — ${reason}`), `no skipped line «${name} — ${reason}»${out}`);
  const materialsOf = (id: string): Material[] => created(id).materials.map((x: { name: string; sha256: string }, i: number) => ({ name: x.name, sha256: x.sha256, text: readFileSync(join(sdir(id), "materials", `m${i + 1}.txt`), "utf8") }));
  const refuse = async (name: string, f: string, reason: string) => {
    const before = journals().length, calls = promptLines().length;
    const r = await run(["--topic", "t", "--attach", f, ...parts(pair(`${lang}-refuse-${name}`)), "--max-rounds", "1"]);
    assert.equal(r.code, 2, `${name}: exit code ${r.code}${dump(r.r)}`);
    assert.equal(r.r.out, "", `${name}: stdout${dump(r.r)}`);
    assert.ok(r.r.err.startsWith(`${t.rejected}\n`) && r.r.err.includes(`  «${basename(f)}»: ${reason}\n`), `${name}: stderr${dump(r.r)}`);
    assert.equal(journals().length, before, `${name}: a session appeared`);
    assert.equal(promptLines().length, calls, `${name}: a participant was called`);
    return r.r;
  };

  const proj = put("proj.zip", projZip());
  const fxBefore = allFiles(fx).map((f) => `${f}:${sha(readFileSync(f))}`).sort();

  // ---- 1. Preview ----
  const out1 = await preview(proj);
  assert.ok(out1.includes(t.summary(3, PROJ_CHARS)), `summary${out1}`);
  PROJ_NAMES.forEach((name, i) => assert.ok(out1.includes(`: ${name}\n${PROJ_TEXTS[i]}`), `material ${name} with its text${out1}`));
  skipLine(out1, "proj.zip/out/", m.excludedByRule("out/"));
  skipLine(out1, "proj.zip/.env", m.envSkipped);
  skipLine(out1, "proj.zip/__MACOSX/", m.archiveMacos);
  assert.ok(!out1.includes(SECRET), "the secret is in the preview");
  assert.deepEqual(allFiles(fx).map((f) => `${f}:${sha(readFileSync(f))}`).sort(), fxBefore, "files next to the archive changed");
  assert.ok(!allFiles(cliHome).some((f) => readFileSync(f, "latin1").includes(SECRET)), "the .env secret is in the data folder");
  ok(`${tag} 1: preview of proj.zip - names ${PROJ_NAMES.join(", ")} with their texts; skipped out/ (.gitignore rule), .env (secrets protection), __MACOSX/; nothing extracted next to the archive, the secret is in no file of the data folder`);

  // ---- 2. Real run, snapshot, listing, archive deleted right after start, a later turn reads a file ----
  const rA = await run(session("s2a", [proj]));
  assert.equal(rA.code, 0, `code ${rA.code}${dump(rA.r)}`);
  assert.ok(rA.r.out.includes(t.summary(3, PROJ_CHARS)), `summary${dump(rA.r)}`);
  const idA = sessionId(rA.r);
  const mA = materialsOf(idA);
  assert.deepEqual(mA.map((x) => x.name), PROJ_NAMES);
  assert.deepEqual(mA.map((x) => x.text), PROJ_TEXTS);
  assert.deepEqual(mA.map((x) => x.sha256), PROJ_TEXTS.map(sha));
  assert.deepEqual(created(idA).workspace, { files: 3, chars: PROJ_CHARS });
  const wsRoot = join(sdir(idA), "workspace");
  assert.deepEqual(allFiles(wsRoot).map((f) => relative(wsRoot, f)).sort(), [...PROJ_NAMES].sort(), "workspace files");
  assert.deepEqual(readdirSync(join(sdir(idA), "workspace")), ["proj.zip"]);
  const listing = promptLines();
  assert.ok(listing.length >= 2 && listing.every((l) => { const q = (JSON.parse(l) as { prompt: string }).prompt; return q.includes(t.folderHeader) && PROJ_NAMES.every((n) => q.includes(n)); }), "the folder listing in the turn requests lacks the archive files");
  ok(`${tag} 2a: session ${idA} - 3 materials / ${PROJ_CHARS} characters in the summary and the journal, session_created.workspace {3, ${PROJ_CHARS}}, workspace/proj.zip holds exactly the three files, ${listing.length} turn requests carry the folder listing with them`);

  const del = put("del/proj.zip", projZip());
  const calls0 = promptLines().length;
  const s1 = scenario(`${lang}-s2b-p1`, [{ stance: "object", files: ["proj.zip/src/a.ts"], delayMs: 2500 }, { expectPrompt: MARK, stance: "amend", solution: "Файл проверен, правок нет." }, ...agree(3)]);
  const s2 = scenario(`${lang}-s2b-p2`, agree(3));
  const rB = start(["--topic", "Проверь файл src/a.ts", "--attach", del, "--participant", s1, "--participant", s2, "--max-rounds", "2", "--materials-chars", "20"]);
  for (let i = 0; i < 300 && !t.session.test(rB.out); i++) await sleep(50);
  assert.ok(t.session.test(rB.out), `no session line${dump(rB)}`);
  unlinkSync(del);
  assert.equal(await rB.exited, 0, `code${dump(rB)}`);
  const idB = sessionId(rB);
  assert.ok(!created(idB).materials.some((x: { name: string }) => x.name === "proj.zip/src/a.ts"), "a.ts is in the initial set, the request is not needed");
  const read = events(idB).filter((e) => e.type === "turn_completed" && e.filesRead?.length);
  assert.ok(read.length >= 1 && read[0]!.filesRead[0].name === "proj.zip/src/a.ts", "no turn with filesRead");
  assert.equal(readFileSync(join(sdir(idB), "workspace", "proj.zip", "src", "a.ts"), "utf8"), ATS);
  assert.ok(promptLines().length > calls0);
  ok(`${tag} 2b: proj.zip deleted right after the start; a later turn requested proj.zip/src/a.ts and its text (marker ${MARK}) came from the session snapshot`);

  // ---- 3. MCP and app ----
  const mcp = await subStand("MCP", "packages/mcp/scenarios/zip-archive/check.ts", join(work, `mcp-${lang}`), lang, proj);
  const desk = await subStand("app", "apps/desktop/scenarios/zip-archive/check.ts", join(work, `desktop-${lang}`), lang, proj);
  for (const [what, r] of [["MCP", mcp], ["app", desk]] as const) {
    assert.deepEqual(r.materials.map(({ name, sha256, text }) => ({ name, sha256, text })), mA, `${what}: names, texts or sha256 differ from the terminal`);
    assert.deepEqual(r.workspace, { files: 3, chars: PROJ_CHARS }, `${what}: workspace`);
  }
  ok(`${tag} 3: parity: names, texts and sha256 of the 3 materials are identical in the terminal, MCP council_start and the app main modules`);

  // ---- 4. Unsafe names, nested archive, encrypted entry ----
  const unsafe = put("u.zip", makeZip([
    { name: "inner.zip", data: makeZip([{ name: "b.txt", data: "b" }]) }, { name: "../evil.txt", data: "t" }, { name: "/etc/x", data: "t" },
    { name: "C:/x.txt", data: "t" }, { name: "a\\b.txt", data: "t" }, { name: "enc.txt", data: "z", encrypted: true }, { name: "ok.txt", data: "ok" },
  ]));
  const out4 = await preview(unsafe);
  assert.ok(out4.includes(t.summary(1, 2)), `summary${out4}`);
  skipLine(out4, "u.zip/inner.zip", m.archiveNested);
  for (const n of ["u.zip/../evil.txt", "u.zip//etc/x", "u.zip/C:/x.txt", "u.zip/a\\b.txt"]) skipLine(out4, n, m.archiveUnsafeName);
  skipLine(out4, "u.zip/enc.txt", m.docEncrypted);
  const r4 = await run(session("s4", [unsafe]));
  assert.equal(r4.code, 0, `code ${r4.code}${dump(r4.r)}`);
  const id4 = sessionId(r4.r);
  const ws4 = allFiles(join(sdir(id4), "workspace")).map((f) => relative(join(sdir(id4), "workspace"), f));
  assert.deepEqual(ws4, ["u.zip/ok.txt"]);
  assert.ok(!allFiles(cliHome).some((f) => ["evil.txt", "b.txt", "x.txt"].includes(basename(f)) || f.includes("etc")), "an unsafe or nested entry was written");
  assert.ok(!existsSync(join(sdir(id4), "evil.txt")) && !existsSync(join(cliHome, "evil.txt")) && !existsSync(join(fx, "evil.txt")) && !existsSync(join(work, "evil.txt")), "evil.txt escaped");
  ok(`${tag} 4: nested archive, four unsafe names and the encrypted entry skipped with their reasons; ok.txt collected; the session workspace holds only u.zip/ok.txt, nothing written outside it`);

  // ---- 5. Bombs ----
  const bombs: [string, Uint8Array, string][] = [
    ["ratio", makeZip([{ name: "a.bin", data: "a", declaredSize: 1000 }]), m.archiveRatio(200)],
    ["unpacked", makeZip([{ name: "a.bin", data: "a", declaredSize: 600 * 2 ** 20, method: 0 }]), m.archiveUnpacked(512)],
    ["entries", makeZip(Array.from({ length: 10_001 }, (_, i) => ({ name: `x${i}`, data: "a" }))), m.archiveParts(10_000)],
  ];
  for (const [name, bytes, reason] of bombs) await refuse(name, put(`bomb-${name}.zip`, bytes), reason);
  collectMaterials([unsafe], { materialsChars: 10_000, materialsIgnore: [] }); // warm-up: module and extractor start-up are not counted
  const bomb = join(fx, "bomb-unpacked.zip");
  const rss0 = process.memoryUsage().rss, peak0 = process.resourceUsage().maxRSS * 1024;
  assert.throws(() => collectMaterials([bomb], { materialsChars: 10_000, materialsIgnore: [] }), (e: Error) => (e as { reasons?: string[] }).reasons?.some((x) => x.includes(m.archiveUnpacked(512))) === true);
  const grew = Math.max(process.memoryUsage().rss - rss0, process.resourceUsage().maxRSS * 1024 - peak0);
  assert.ok(grew < 64 * 2 ** 20, `RSS grew by ${Math.round(grew / 2 ** 20)} MiB`);
  ok(`${tag} 5: ratio > 200, unpacked > 512 MiB and 10001 entries - exit code 2, reason names the limit, no session, no participant call; in-process collection of the 512 MiB bomb grew RSS by ${Math.round(grew / 2 ** 20)} MiB (< 64)`);

  // ---- 6. Damaged and all-hidden ----
  await refuse("damaged", put("damaged.zip", Buffer.from(makeZip([{ name: "a.txt", data: "a" }, { name: "b.txt", data: "b" }])).subarray(0, -30)), m.archiveDamaged);
  const hid = await refuse("hidden", put("hidden.zip", makeZip([{ name: ".env", data: "a" }, { name: ".hid", data: "b" }])), m.archiveNoFiles(2));
  assert.ok(hid.err.includes(`hidden.zip/.env — ${m.envSkipped}`) && hid.err.includes(`hidden.zip/.hid — ${m.hiddenName}`), `skip list${dump(hid)}`);
  ok(`${tag} 6: a truncated archive is refused as "${m.archiveDamaged}"; an all-hidden one with "${m.archiveNoFiles(2)}" and the skip list`);

  // ---- 7. Archive inside a folder, 7a. big ZIP, empty archive ----
  put("d/notes.md", "n");
  put("d/export.zip", makeZip([{ name: "a.txt", data: "a" }]));
  const out7 = await preview(join(fx, "d"));
  assert.ok(out7.includes(t.summary(1, 1)) && out7.includes(": d/notes.md\nn"), out7);
  skipLine(out7, "d/export.zip", m.archiveInFolder);
  ok(`${tag} 7: folder with notes.md and export.zip - notes.md collected, export.zip skipped ("${m.archiveInFolder}")`);

  const huge = sparseZip("huge.zip");
  assert.deepEqual([...readHead(huge, 4)], [0x50, 0x4b, 0x03, 0x04]);
  await refuse("huge", huge, m.zipTooLarge(100));
  put("d2/a.md", "a");
  sparseZip("d2/huge.zip");
  skipLine(await preview(join(fx, "d2")), "d2/huge.zip", m.zipTooLarge(100));
  await refuse("empty", put("empty.zip", makeZip([])), m.archiveEmpty);
  ok(`${tag} 7a: a 150 MiB ZIP is refused explicitly and skipped in a folder with "${m.zipTooLarge(100)}"; an empty archive with "${m.archiveEmpty}"`);
  const iwork = makeZip([{ name: "Index/Document.iwa", data: "x" }, { name: "Index/a.iwa", data: "y" }]);
  await refuse("iwork", put("deck.zip", iwork), m.kindReason("iwork"));
  put("d3/a.md", "a");
  put("d3/deck.zip", iwork);
  const out7b = await preview(join(fx, "d3"));
  assert.ok(out7b.includes(t.summary(1, 1)), out7b);
  skipLine(out7b, "d3/deck.zip", m.kindReason("iwork"));
  ok(`${tag} 7b: an iWork ZIP (Index/Document.iwa) named .zip is refused with "${m.kindReason("iwork")}" and not expanded; in a folder it is skipped with it`);

  // ---- 8. Content decides, not the extension ----
  const out8 = await preview(put("x.zip", makeDocx({ body: p(SPEC) })), put("y.docx", makeZip([{ name: "a.txt", data: "a" }])));
  assert.ok(out8.includes(`: x.zip\n${SPEC}`) && out8.includes(": y.docx/a.txt\na"), out8);
  ok(`${tag} 8: a .docx renamed .zip is read as a document (x.zip), a plain archive renamed .docx expands as an archive (y.docx/a.txt)`);

  // ---- 9. Same names ----
  put("a/proj/check.ts", "folder");
  const f9 = [join(fx, "a/proj"), put("b/proj.zip", makeZip([{ name: "check.ts", data: "one" }])), put("c/proj.zip", makeZip([{ name: "check.ts", data: "two" }]))];
  const r9 = await run(session("s9", f9));
  assert.equal(r9.code, 0, `code ${r9.code}${dump(r9.r)}`);
  const id9 = sessionId(r9.r);
  assert.deepEqual(materialsOf(id9).map((x) => [x.name, x.text]), [["proj/check.ts", "folder"], ["proj.zip/check.ts", "one"], ["proj.zip (2)/check.ts", "two"]]);
  assert.deepEqual(readdirSync(join(sdir(id9), "workspace")).sort(), ["proj", "proj.zip", "proj.zip (2)"]);
  ok(`${tag} 9: folder proj and archives proj.zip from two dirs - proj/, proj.zip/, proj.zip (2)/ in the materials and in the written session snapshot`);

  // ---- 11. Entry names without the UTF-8 flag, an unsupported method, NUL in a name, an archive in a folder and attached separately ----
  const outC = await preview(put("cp866.zip", cp866Zip()));
  assert.ok(outC.includes(t.summary(2, 10)), `summary${outC}`);
  assert.ok(outC.includes(": cp866.zip/readme.txt\nчитай") && outC.includes(": cp866.zip/Отчёт.txt\nотчёт"), `cp866 names${outC}`);
  const rC = await run(session("s11c", [join(fx, "cp866.zip")]));
  assert.equal(rC.code, 0, `code ${rC.code}${dump(rC.r)}`);
  const idC = sessionId(rC.r);
  assert.deepEqual(materialsOf(idC).map((x) => x.name), ["cp866.zip/readme.txt", "cp866.zip/Отчёт.txt"]);
  assert.deepEqual(allFiles(join(sdir(idC), "workspace")).map((f) => relative(join(sdir(idC), "workspace"), f)).sort(), ["cp866.zip/readme.txt", "cp866.zip/Отчёт.txt"]);
  ok(`${tag} 11a: CP866 names without the UTF-8 flag - cp866.zip/readme.txt and cp866.zip/Отчёт.txt in the preview, the session materials and workspace/cp866.zip/`);

  const outM = await preview(put("m12.zip", method12Zip()));
  assert.ok(outM.includes(t.summary(1, 1)) && outM.includes(": m12.zip/a.txt\na"), `method summary${outM}`);
  skipLine(outM, "m12.zip/b.txt", m.archiveMethod);
  const rM = await run(session("s11m", [join(fx, "m12.zip")]));
  assert.equal(rM.code, 0, `code ${rM.code}${dump(rM.r)}`);
  assert.deepEqual(materialsOf(sessionId(rM.r)).map((x) => x.name), ["m12.zip/a.txt"]);
  ok(`${tag} 11b: an entry with compression method 12 is skipped with "${m.archiveMethod}", the stored entry is collected, the archive is not damaged`);

  const outN = await preview(put("nul.zip", makeZip([{ name: "ok.txt", data: "ok" }, { name: "a/\u0000b.txt", data: "x" }])));
  assert.ok(outN.includes(t.summary(1, 2)), `nul summary${outN}`);
  skipLine(outN, "nul.zip/a/\\u0000b.txt", m.archiveUnsafeName);
  assert.ok(!outN.includes("\u0000"), "NUL in the preview");
  const rN = await run(session("s11n", [join(fx, "nul.zip")]));
  assert.equal(rN.code, 0, `code ${rN.code}${dump(rN.r)}`);
  assert.ok(!rN.r.out.includes("\u0000") && !rN.r.err.includes("\u0000"), "NUL in the council output");
  const idN = sessionId(rN.r);
  assert.ok(!allFiles(sdir(idN)).filter((f) => /\.(jsonl|json)$/.test(f)).some((f) => readFileSync(f, "latin1").includes("\u0000")), "NUL in the session journal");
  ok(`${tag} 11c: the unsafe name a/<NUL>b.txt is shown as nul.zip/a/\\u0000b.txt; no NUL byte in the preview, the council output and the session journal`);

  put("f/notes.md", "n");
  const exportZip = put("f/export.zip", makeZip([{ name: "a.txt", data: "a" }]));
  const outF = await preview(join(fx, "f"), exportZip);
  assert.ok(outF.includes(t.summary(2, 2)) && outF.includes(": f/notes.md\nn") && outF.includes(": export.zip/a.txt\na"), `folder and archive${outF}`);
  assert.ok(!outF.includes(m.archiveInFolder) && !outF.includes("f/export.zip"), `no skip line for the archive attached separately${outF}`);
  const rF = await run(session("s11f", [join(fx, "f"), exportZip]));
  assert.equal(rF.code, 0, `code ${rF.code}${dump(rF.r)}`);
  assert.deepEqual(materialsOf(sessionId(rF.r)).map((x) => x.name).sort(), ["export.zip/a.txt", "f/notes.md"]);
  ok(`${tag} 11d: folder f (notes.md, export.zip) plus export.zip attached separately - f/notes.md and export.zip/a.txt collected, no "${m.archiveInFolder}" line`);

  // ---- 12. In-process: re-collection after a transient failure, scan-only archive, extractor failure reasons ----
  const reasonOf = (set: { skipped: { name: string; reason: string }[] }, name: string) => set.skipped.find((x) => x.name === name)?.reason;
  const collect = (f: string) => collectMaterials([f], { materialsChars: 100_000, materialsIgnore: [] });
  try {
    const scanZip = put("scan.zip", makeZip([{ name: "note.txt", data: "n" }, { name: "scan.png", data: png() }]));
    setOcrRuntime({ helper: "/nonexistent/osen-ocr" });
    const first = collect(scanZip);
    assert.deepEqual(first.materials.map((x) => x.name), ["scan.zip/note.txt"]);
    assert.equal(reasonOf(first, "scan.zip/scan.png"), m.imgMissing);
    ocrStub(OCR_OK);
    assert.deepEqual(collect(scanZip).materials.map((x) => [x.name, x.text]), [["scan.zip/note.txt", "n"], ["scan.zip/scan.png", "stub text"]], "scan.png is not a material after the helper appeared");
    ok(`${tag} 12a: the same archive collected again after the OCR helper appeared - scan.png was skipped ("${m.imgMissing}"), then a material with the recognized text`);

    const slowZip = put("slow.zip", makeZip([{ name: "note.txt", data: "n" }, { name: "scan.png", data: png() }]));
    ocrStub({ ok: false, code: "timeout" });
    assert.equal(reasonOf(collect(slowZip), "slow.zip/scan.png"), m.imgTimeout(30));
    ocrStub(OCR_OK);
    assert.deepEqual(collect(slowZip).materials.map((x) => x.name), ["slow.zip/note.txt", "slow.zip/scan.png"], "scan.png is not a material after the timeout");
    ok(`${tag} 12b: a helper that exceeded its deadline (stub reply timeout) is not remembered: the next collection reads scan.png`);

    const onlyZip = put("only.zip", makeZip([{ name: "scan.png", data: png() }]));
    setOcrRuntime({ helper: "/nonexistent/osen-ocr" });
    let reasons: string[] = [];
    try { collect(onlyZip); assert.fail("a scan-only archive without a helper must be refused"); } catch (e) { reasons = (e as { reasons?: string[] }).reasons ?? assert.fail(String(e)); }
    assert.deepEqual(reasons, [`«${onlyZip}»: ${m.archiveNoFiles(1)}`, `«${onlyZip}»: only.zip/scan.png — ${m.imgMissing}`]);
    ocrStub(OCR_OK);
    assert.deepEqual(collect(onlyZip).materials.map((x) => [x.name, x.text]), [["only.zip/scan.png", "stub text"]], "the refusal was remembered");
    ok(`${tag} 12c: a scan-only archive without a helper is refused with the skip list; with the helper the same archive gives scan.png as a material`);
  } finally { setOcrRuntime(); }

  const stubScript = join(work, "fail-stub.mjs");
  writeFileSync(stubScript, FAIL_STUB);
  const expectedFail = {
    ru: { exit: "процесс извлечения завершился с кодом 3", signal: "процесс извлечения остановлен сигналом SIGKILL", reply: "рабочий поток извлечения остановился" },
    en: { exit: "the extraction process exited with code 3", signal: "the extraction process was stopped by signal SIGKILL", reply: "the extraction worker stopped" },
  }[lang];
  try {
    for (const mode of ["exit", "signal", "reply"] as const) {
      setDocumentExtractorRuntime({ script: stubScript, env: { MODE: mode } });
      const f = put(`fail-${mode}.zip`, makeZip([{ name: "a.txt", data: "a" }]));
      let rs: string[] = [];
      try { collect(f); assert.fail("expected a refusal"); } catch (e) { rs = (e as { reasons?: string[] }).reasons ?? assert.fail(String(e)); }
      assert.deepEqual(rs, [`«${f}»: ${m.archiveFailed(expectedFail[mode])}`], `${mode}: reason`);
      assert.ok(!/\bexit \d|worker error|worker exit/.test(rs[0]!.replace(expectedFail[mode], "")), `${mode}: raw text in the reason: ${rs[0]}`);
    }
  } finally { setDocumentExtractorRuntime(); }
  ok(`${tag} 12d: extractor failure (exit code 3, a signal, a worker reply) - the reason is the catalog text «${expectedFail.exit}» / «${expectedFail.signal}» / «${expectedFail.reply}», no raw exit/worker texts`);

  // ---- the stand's own invariants ----
  assert.ok(!allFiles(work).filter((f) => !f.startsWith(fx)).some((f) => readFileSync(f, "latin1").includes(SECRET)), "the control secret was found in the stand files");
}

/** Step 10: the bundled extractor gives the same entries and bytes as the source one under Node and under ELECTRON_RUN_AS_NODE=1. */
function bundled() {
  setProcessLanguage("en");
  const electron = join(repo, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  const bytes = makeZip([
    { name: "README.md", data: "читай" }, { name: "docs/spec.docx", data: makeDocx({ body: p("Первая строка") }) }, { name: "dir/", data: "" },
    { name: "enc.txt", data: "z", encrypted: true }, { name: "link", data: "README.md", unixMode: 0o120777 }, { name: "README.md", data: "dup" },
  ]);
  const bomb = makeZip([{ name: "a.bin", data: "a", declaredSize: 1000 }]);
  const probe = (bytes: Uint8Array) => {
    const list = listArchiveEntries(bytes);
    assert.ok(list.ok, `list: ${JSON.stringify(list)}`);
    const indices = list.entries.flatMap((e, i) => (e.kind === "file" ? [i] : []));
    const read = readArchiveEntries(bytes, indices, 1 << 20);
    assert.ok(read.ok, `read: ${JSON.stringify(read)}`);
    return { list, bomb: listArchiveEntries(bomb), read: [...read.entries].map(([i, v]) => [i, typeof v === "string" ? v : sha(v)]) };
  };
  const cases: [string, Uint8Array][] = [["mixed", bytes], ["CP866", cp866Zip()], ["method 12", method12Zip()]];
  try {
    const source = cases.map(([, b]) => probe(b));
    assert.ok(source[0]!.list.ok && source[0]!.list.entries.length >= 4);
    assert.ok(source[1]!.list.ok && source[1]!.list.entries.some((e) => e.name === "Отчёт.txt" && e.kind === "file"), "CP866 name in the source listing");
    assert.ok(source[2]!.list.ok && source[2]!.list.entries.some((e) => e.name === "b.txt" && e.kind === "method"), "method entry in the source listing");
    const runtimes: [string, { command: string; script: string; env: Record<string, string> }][] = [["Node", { command: process.execPath, script: bundle, env: {} }]];
    if (existsSync(electron)) runtimes.push(["Electron with ELECTRON_RUN_AS_NODE=1", { command: electron, script: bundle, env: { ELECTRON_RUN_AS_NODE: "1" } }]);
    else console.log("skipped: no Electron binary (npm install)");
    for (const [name, rt] of runtimes) {
      setDocumentExtractorRuntime(rt);
      cases.forEach(([what, b], i) => assert.deepEqual(probe(b), source[i], `${name}: the bundled extractor differs from the source one (${what})`));
      const n = source[0]!.list.ok ? source[0]!.list.entries.length : 0;
      ok(`10: bundled doc-extract.mjs under ${name} - the same entries (${n}), the same bytes of ${source[0]!.read.length} files and the same bomb refusal as doc-extract.ts; the CP866 archive (Отчёт.txt) and the method 12 archive (kind method) give the same entry names and kinds`);
    }
  } finally { setDocumentExtractorRuntime(); }
}

async function main() {
  for (const lang of ["ru", "en"] as const) await suite(lang);
  bundled();
  ok("0 real model calls: all parts use scripted participants only");
}

let failed = false;
const kept = () => (home ? `\nStand left in place: ${work}` : "\nRerun with COUNCIL_HOME=<new empty folder> to keep the data");
const cleanup = () => { if (!home) rmSync(work, { recursive: true, force: true }); };
const guard = setTimeout(() => { console.error(`FAILED: the stand did not finish within 600 seconds${kept()}`); for (const k of kids) k.kill("SIGKILL"); cleanup(); process.exit(1); }, 600000);
try {
  await main();
  console.log(`zip-archive check: ${checks} checks passed, 0 model calls`);
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}${kept()}`);
} finally {
  clearTimeout(guard);
  for (const k of kids) k.kill("SIGKILL");
}
cleanup();
process.exit(failed ? 1 : 0);
