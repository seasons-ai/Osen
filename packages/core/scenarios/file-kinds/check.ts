// Live check of reasons by file kind (change 216): real council --attach, real MCP server over stdio, real main-process materials draft of the app.
// Scripted participants only, 0 model calls. Text steps run on ru and on en.
//   COUNCIL_DEV=1 [COUNCIL_HOME=<new folder inside the project>] node packages/core/scenarios/file-kinds/check.ts [--mutant]
// Without COUNCIL_HOME the stand creates .council-data/file-kinds-<stamp> and removes it on success. A COUNCIL_HOME given is kept.
// Fixture files are generated in code (kind-fixtures.ts and the generators of changes 208-215) in a temp folder that is removed on success.
// --mutant: the RAR record is removed from KIND_SIGNATURES in a copy of packages/core/src, the terminal steps run on that copy; the stand must exit non-zero and name RAR.
import "../language-ru.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setProcessLanguage } from "../../src/index.ts";
import { createMaterialsDraft } from "../../../../apps/desktop/src/main/materials.ts";
import { makeDocx, makePptx, makeRtf, makeXlsx, makeZip, p, sp } from "../../src/documents/fixture.ts";
import { makeEpub, xhtml } from "../../src/documents/epub-fixture.ts";
import { makeOdf, odpPage, odsTable, odtP } from "../../src/documents/odf-fixture.ts";
import { KIND_FIXTURES } from "../../src/documents/kind-fixtures.ts";
import type { FileKindId } from "../../src/documents/kinds.ts";
import { materialsMessages } from "../../src/messages/materials.ts";
import { makeImage } from "../../src/ocr/fixture.ts";
import { makePdf, makeScanPdf } from "../../src/pdf/fixture.ts";
import { enc1251, encKoi8r, utf16le } from "../../src/text-encoding.testutil.ts";

const usage = "COUNCIL_DEV=1 [COUNCIL_HOME=<new folder inside the project>] node packages/core/scenarios/file-kinds/check.ts [--mutant]";
if (process.env.COUNCIL_DEV !== "1") { console.error(`Usage: ${usage}`); process.exit(2); }
const mutant = process.argv.includes("--mutant");
const repo = resolve(import.meta.dirname, "../../../..");
const given = process.env.COUNCIL_HOME;
if (given && existsSync(resolve(given)) && (!statSync(resolve(given)).isDirectory() || readdirSync(resolve(given)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(given)} must be absent or an empty folder. Usage: ${usage}`);
  process.exit(2);
}
const stamp = `${Date.now()}`;
const homeRoot = given ? resolve(given) : join(repo, ".council-data", `file-kinds-${stamp}`);
mkdirSync(homeRoot, { recursive: true });
const work = realpathSync(homeRoot);
const fx = mkdtempSync(join(realpathSync(tmpdir()), "file-kinds-fx-"));
const mutantDir = join(repo, "packages/core", `src-mutant-${stamp}`);
const LANGS = ["ru", "en"] as const;
type Lang = (typeof LANGS)[number];
const homes = (lang: Lang) => ({ cli: join(work, `cli-${lang}`), mcp: join(work, `mcp-${lang}`) });
for (const l of LANGS) for (const h of Object.values(homes(l))) mkdirSync(h, { recursive: true });

// ---- bookkeeping: every failure is recorded and printed, the stand goes on, the exit code is decided at the end ----
let checks = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); checks++; console.log(`ok ${checks}: ${name}`); } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`);
    console.log(`FAIL: ${name}: ${msg.split("\n")[0]}`);
  }
}
const CYR = /[Ѐ-ӿ]/;

// ---- processes ----
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_DEV: "1" };
const kids = new Set<ReturnType<typeof spawn>>();
type Proc = { out: string; err: string; code: number | null };
function run(args: string[], env: Record<string, string>): Promise<Proc> {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    kids.add(child);
    const r: Proc = { out: "", err: "", code: null };
    child.stdout.on("data", (d) => { r.out += d; });
    child.stderr.on("data", (d) => { r.err += d; });
    child.on("close", (c) => { kids.delete(child); r.code = c; res(r); });
  });
}
const dump = (r: Proc) => `\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}`;
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); } }));
  return out;
}
const coreEntry = join(mutant ? mutantDir : join(repo, "packages/core/src"), "council.ts");
const consensus = ["p1", "p2"].flatMap((x) => ["--participant", `scripted:${join(repo, "packages/core/scenarios/consensus", `${x}.json`)}`]);
const cli = (lang: Lang, args: string[]) => run([coreEntry, ...args], { ...baseEnv, COUNCIL_LANG: lang, COUNCIL_HOME: homes(lang).cli });
const attach = (lang: Lang, paths: string[], extra: string[] = []) => cli(lang, ["--topic", "What is in the files?", ...paths.flatMap((f) => ["--attach", f]), ...consensus, "--max-rounds", "3", ...extra]);
const sessionsOf = (lang: Lang) => { const d = join(homes(lang).cli, "sessions"); return existsSync(d) ? readdirSync(d).length : 0; };

// ---- fixture files ----
const EXT: Record<FileKindId, string> = {
  mp3: "mp3", aac: "aac", m4a: "m4a", wav: "wav", aiff: "aiff", flac: "flac", ogg: "ogg", video: "mp4", rar: "rar", "7z": "7z", tar: "tar", gzip: "gz", bzip2: "bz2", xz: "xz", zstd: "zst",
  dmg: "dmg", program: "bin", sqlite: "db", font: "ttf", xls: "xls", ppt: "ppt", iwork: "pages", unknown: "bin",
};
const put = (rel: string, data: Uint8Array | string): string => { const f = join(fx, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, data); return f; };
const kindFiles = KIND_FIXTURES.map((k) => ({ ...k, file: put(`kinds/${k.name}.${EXT[k.kind]}`, k.bytes), base: `${k.name}.${EXT[k.kind]}` }));
const TEXT = "Привет, мир. Ёж ест яблоко.";
const aMd = put("ok/a.md", "a");
const trackMp3 = put("ok/track.mp3", "just notes in a file named like music\n");
const plainZip = put("ok/plain.zip", makeZip([{ name: "a.txt", data: "a" }]));
const mp3Bytes = KIND_FIXTURES.find((k) => k.name === "mp3-id3")!.bytes;
const notesTxt = put("ok/notes.txt", mp3Bytes);
const brokenDocx = put("ok/broken.docx", makeDocx({ body: "<w:p>" }));
const koi = put("ok/koi.txt", encKoi8r(TEXT));
const hugeZip = put("ok/huge.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04]));
truncateSync(hugeZip, 150 * 2 ** 20);
const darwin = process.platform === "darwin";
let legacyDoc: string | undefined;
if (darwin) {
  const rtf = put("src/x.rtf", makeRtf(["Первая строка", "Вторая строка"]));
  legacyDoc = join(fx, "ok/legacy.doc");
  const r = spawnSync("/usr/bin/textutil", ["-convert", "doc", "-output", legacyDoc, rtf]);
  if (r.status !== 0) { console.error(`textutil failed: ${r.stderr}`); process.exit(2); }
} else console.log("skipped: DOC and pictures need macOS (textutil, osen-ocr)");

const t = { ru: { session: /^Сессия (\S+) ·/m }, en: { session: /^Session (\S+) ·/m } };
const REJECTED = { ru: "Материалы не приняты:", en: "Materials not accepted:" } as const;
const msgs = (lang: Lang) => { setProcessLanguage(lang); return materialsMessages(); };

// ---- steps 2-3: one file per kind, refused; accepted files ----
async function refusals(lang: Lang) {
  const m = msgs(lang);
  const before = sessionsOf(lang);
  const cases: { name: string; file: string; reason: string; tag: string }[] = [
    ...kindFiles.map((k) => ({ name: k.name, file: k.file, reason: m.kindReason(k.kind), tag: k.kind })),
    { name: "mp3 named notes.txt", file: notesTxt, reason: m.kindReason("mp3"), tag: "mp3" },
    { name: "damaged docx", file: brokenDocx, reason: m.docDamaged, tag: "docx" },
    { name: "KOI8-R text", file: koi, reason: m.encodingUnknown, tag: "encoding" },
    { name: "ZIP over 100 MiB", file: hugeZip, reason: m.zipTooLarge(100), tag: "zip" },
  ];
  const results = await mapLimit(cases, 6, async (c) => ({ c, r: await attach(lang, [c.file], ["--max-rounds", "1"]) }));
  for (const { c, r } of results) {
    await check(`2 [${lang}] ${c.tag} (${c.name}): exit 2, «${basename(c.file)}»: ${c.reason}`, () => {
      assert.equal(r.code, 2, `exit code ${r.code}${dump(r)}`);
      assert.equal(r.out, "", `stdout${dump(r)}`);
      assert.ok(r.err.startsWith(`${REJECTED[lang]}\n`) && r.err.includes(`  «${basename(c.file)}»: ${c.reason}\n`), `stderr lacks the reason "${c.reason}"${dump(r)}`);
      if (lang === "en") assert.ok(!CYR.test(r.err.split(fx).join("")), `Cyrillic in the en reason${dump(r)}`);
      if (c.tag !== "docx" && c.tag !== "encoding" && c.tag !== "zip" && c.name !== "mp3 named notes.txt") assert.ok(c.reason !== m.kindReason("unknown") || c.tag === "unknown", "kind fell to unknown");
    });
  }
  await check(`2 [${lang}] ${cases.length} refusals created no session folder`, () => assert.equal(sessionsOf(lang), before));
  if (lang === "ru") {
    const lit: [string, string][] = [["mp3-id3", "аудио MP3 — расшифровка не выполняется"], ["rar", "архив RAR — раскрывается только ZIP"], ["xls", "таблица Excel 97 — сохраните как XLSX"]];
    for (const [name, reason] of lit) {
      const r = results.find((x) => x.c.name === name)!;
      await check(`2 [ru] literal reason «${reason}» for ${name}`, () => assert.ok(r.r.err.includes(`: ${reason}\n`), dump(r.r)));
    }
  }
  await check(`2 [${lang}] kind reasons differ between kinds (no two audio/archive/program texts collapsed)`, () => {
    const texts = (["mp3", "rar", "7z", "tar", "sqlite", "dmg", "xls", "ppt", "iwork", "unknown"] as FileKindId[]).map((k) => m.kindReason(k));
    assert.equal(new Set(texts).size, texts.length);
  });
}
async function accepted(lang: Lang) {
  const before = sessionsOf(lang);
  const files = [aMd, trackMp3, plainZip, ...(legacyDoc ? [legacyDoc] : [])];
  const results = await mapLimit(files, 4, async (f) => ({ f, r: await attach(lang, [f]) }));
  for (const { f, r } of results) {
    await check(`3 [${lang}] ${basename(f)} accepted: exit 0, session created`, () => {
      assert.equal(r.code, 0, `exit code ${r.code}${dump(r)}`);
      assert.ok(t[lang].session.test(r.out), `no session line${dump(r)}`);
    });
  }
  await check(`3 [${lang}] ${files.length} accepted files created ${files.length} sessions`, () => assert.equal(sessionsOf(lang) - before, files.length));
}

// ---- step 4: a folder with every file ----
async function folder(lang: Lang) {
  const m = msgs(lang);
  const dir = join(fx, "all");
  for (const k of kindFiles) put(`all/${k.base}`, k.bytes);
  put("all/koi.txt", encKoi8r(TEXT));
  put("all/a.md", "a");
  const r = await attach(lang, [dir]);
  await check(`4 [${lang}] folder with ${kindFiles.length + 2} files: exit 0, a.md collected, kind reasons before the session id, consensus`, () => {
    assert.equal(r.code, 0, `exit code ${r.code}${dump(r)}`);
    const sid = t[lang].session.exec(r.out);
    assert.ok(sid, `no session line${dump(r)}`);
    const head = r.out.slice(0, sid.index);
    assert.ok(head.includes(lang === "ru" ? "Материалы: 1, объём 1 символов" : "Materials: 1, size 1 characters"), `summary${dump(r)}`);
    for (const k of kindFiles) assert.ok(head.includes(`  all/${k.base} — ${m.kindReason(k.kind)}`), `no skipped line for ${k.base}${dump(r)}`);
    assert.ok(head.includes(`  all/koi.txt — ${m.encodingUnknown}`), `no skipped line for koi.txt${dump(r)}`);
    if (lang === "en") assert.ok(!CYR.test(head), `Cyrillic in the en block${dump(r)}`);
    const journal = readFileSync(join(homes(lang).cli, "sessions", sid[1]!, "events.jsonl"), "utf8");
    const events = journal.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
    assert.equal(events.find((e) => e.type === "session_finished")?.status, "consensus", "the session did not reach consensus");
    const created = events.find((e) => e.type === "session_created")!.session;
    assert.deepEqual(created.materials.map((x: { name: string }) => x.name), ["all/a.md"]);
  });
}

// ---- step 5: MCP over stdio ----
async function mcp(lang: Lang) {
  const m = msgs(lang);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, "packages/mcp/src/main.ts")], cwd: repo, stderr: "pipe", env: { ...baseEnv, COUNCIL_LANG: lang, COUNCIL_HOME: homes(lang).mcp } });
  const client = new Client({ name: "file-kinds-check", version: "0" });
  type Res = { isError?: boolean; content: { text: string }[] };
  const start = async (attachments: string[]) => (await client.callTool({ name: "council_start", arguments: { topic: "What is in the files?", participants: [{ providerId: "scripted", model: "consensus/p1.json" }, { providerId: "scripted", model: "consensus/p2.json" }], maxRounds: 3, attachments } })) as Res;
  try {
    await client.connect(transport);
    await check(`5 [${lang}] tools/list: attachments description holds the formats list in ${lang}`, async () => {
      const tool = (await client.listTools()).tools.find((x) => x.name === "council_start")!;
      const desc = (tool.inputSchema.properties as Record<string, { description?: string }>)["attachments"]!.description ?? "";
      assert.ok(desc.includes(m.supportedFormats), desc);
    });
    for (const k of kindFiles.filter((x) => ["mp3", "rar", "xls", "unknown"].includes(x.kind))) {
      await check(`5 [${lang}] council_start with ${k.base}: tool error, «${k.base}»: ${m.kindReason(k.kind)}`, async () => {
        const r = await start([k.file]);
        assert.ok(r.isError, `no tool error: ${r.content[0]?.text}`);
        assert.ok(r.content[0]!.text.includes(`«${k.base}»: ${m.kindReason(k.kind)}`), r.content[0]!.text);
      });
    }
    await check(`5 [${lang}] council_start with the folder: started, materials.skipped holds the kind reasons`, async () => {
      const r = await start([join(fx, "all")]);
      assert.ok(!r.isError, r.content[0]?.text);
      const s = JSON.parse(r.content[0]!.text) as { materials: { count: number; skipped: { name: string; reason: string }[] } };
      assert.equal(s.materials.count, 1);
      for (const k of kindFiles) assert.ok(s.materials.skipped.some((x) => x.name === `all/${k.base}` && x.reason === m.kindReason(k.kind)), `no skipped ${k.base} in ${JSON.stringify(s.materials.skipped).slice(0, 400)}`);
    });
  } finally {
    try { await client.close(); } catch { /* killed below */ }
    try { if (transport.pid) process.kill(transport.pid, "SIGKILL"); } catch { /* gone */ }
  }
}

// ---- step 6: main-process modules of the app ----
async function desktop(lang: Lang) {
  const m = msgs(lang);
  const draft = createMaterialsDraft({ limits: () => ({ materialsChars: 60000, materialsIgnore: [] }) });
  for (const k of kindFiles) {
    await check(`6 [${lang}] app attach ${k.base}: «${k.base}»: ${m.kindReason(k.kind)}`, () => {
      draft.clear();
      const v = draft.attach([k.file]);
      assert.ok(v.error?.includes(`«${k.base}»: ${m.kindReason(k.kind)}`), `error: ${v.error}`);
    });
  }
  await check(`6 [${lang}] app attach: mp3 named notes.txt, damaged docx, KOI8-R, 150 MiB ZIP`, () => {
    for (const [f, reason] of [[notesTxt, m.kindReason("mp3")], [brokenDocx, m.docDamaged], [koi, m.encodingUnknown], [hugeZip, m.zipTooLarge(100)]] as const) {
      draft.clear();
      assert.ok(draft.attach([f]).error?.includes(`«${basename(f)}»: ${reason}`), `${basename(f)}`);
    }
  });
  await check(`6 [${lang}] app attach folder: a.md collected, skipped rows with kind reasons`, () => {
    draft.clear();
    const v = draft.attach([join(fx, "all")]);
    assert.equal(v.error, null);
    assert.deepEqual(v.items.map((i) => i.name), ["all/a.md"]);
    for (const k of kindFiles) assert.ok(v.skipped.some((x) => x.name === `all/${k.base}` && x.reason === m.kindReason(k.kind)), `no skipped ${k.base}`);
  });
}

// ---- step 8: one list of formats, accepted files for every format, refused files for every kind ----
function formatFiles(): { token: string; file: string }[] {
  const out: { token: string; file: string }[] = [];
  const add = (token: string, name: string, data: Uint8Array | string) => out.push({ token, file: put(`formats/${name}`, data) });
  add("UTF-8", "utf8.txt", TEXT);
  add("UTF-16", "utf16.txt", utf16le(TEXT));
  add("Windows-1251", "win1251.txt", enc1251(TEXT));
  add("PDF", "text.pdf", makePdf(["Первая страница"]));
  add("DOCX", "a.docx", makeDocx({ body: p("Первая строка") }));
  add("DOCM", "a.docm", makeDocx({ body: p("Первая строка"), macro: true }));
  const sheet = { sheets: [{ name: "S", rows: [[{ inline: "Товар" }, 40]] }] };
  add("XLSX", "a.xlsx", makeXlsx(sheet));
  add("XLSM", "a.xlsm", makeXlsx({ ...sheet, macro: true }));
  const deck = { slides: [{ shapes: sp(["Название доклада"], "title") }] };
  add("PPTX", "a.pptx", makePptx(deck));
  add("PPTM", "a.pptm", makePptx({ ...deck, macro: true }));
  add("ODT", "a.odt", makeOdf({ kind: "text", body: odtP("Абзац") }));
  add("ODS", "a.ods", makeOdf({ kind: "spreadsheet", body: odsTable("Итоги", [["Статья", "Сумма"]]) }));
  add("ODP", "a.odp", makeOdf({ kind: "presentation", body: odpPage(["Заголовок слайда"]) }));
  add("EPUB", "a.epub", makeEpub({ chapters: [{ path: "OEBPS/ch1.xhtml", html: xhtml("<p>Глава первая</p>") }] }));
  add("RTF", "a.rtf", makeRtf(["Первая строка"]));
  add("ZIP", "a.zip", makeZip([{ name: "a.txt", data: "a" }]));
  if (legacyDoc) out.push({ token: "DOC", file: legacyDoc });
  if (darwin) {
    add("PDF", "scan.pdf", makeScanPdf([["Scan page one"]]));
    add("pictures", "shot.png", makeImage("png", ["Договор поставки", "Срок оплаты"]));
  }
  return out;
}
async function formats() {
  const en = msgs("en");
  const helpOf = async (lang: Lang) => (await cli(lang, ["--help"])).out;
  for (const lang of LANGS) {
    const list = msgs(lang).supportedFormats;
    await check(`8 council --help [${lang}] holds the list of formats`, async () => assert.ok((await helpOf(lang)).includes(list)));
  }
  await check("8 skill/osen/SKILL.md and docs/materials.md hold the en list", () => {
    for (const f of ["skill/osen/SKILL.md", "docs/materials.md"]) assert.ok(readFileSync(join(repo, f), "utf8").includes(en.supportedFormats), f);
  });
  const files = formatFiles();
  const list = en.supportedFormats;
  const tokens = new Set(files.map((x) => x.token));
  await check("8 every format of the list has a generated file", () => {
    for (const token of ["UTF-8", "UTF-16", "Windows-1251", "PDF", "DOCX", "DOCM", "XLSX", "XLSM", "PPTX", "PPTM", "ODT", "ODS", "ODP", "EPUB", "RTF", "ZIP", ...(darwin ? ["DOC", "pictures"] : [])]) {
      assert.ok(list.includes(token), `${token} is not in the list`);
      assert.ok(tokens.has(token), `no file for ${token}`);
    }
  });
  const results = await mapLimit(files, 4, async (x) => ({ x, r: await cli("en", ["--attach", x.file, "--preview-materials"]) }));
  for (const { x, r } of results) {
    await check(`8 format ${x.token} (${basename(x.file)}) accepted: exit 0, one material`, () => {
      assert.equal(r.code, 0, `exit code ${r.code}${dump(r)}`);
      assert.match(r.out, /^Materials: 1,/m, dump(r));
    });
  }
  await check("8 no accepted file is also a table kind: no byte-for-byte overlap", () => {
    const accepted = new Set(files.map((x) => readFileSync(x.file).toString("hex")));
    for (const k of kindFiles) if (k.kind !== "unknown") assert.ok(!accepted.has(Buffer.from(k.bytes).toString("hex")), `${k.name} is also an accepted file`);
  });
}

// ---- main ----
const guard = setTimeout(() => { console.error("FAILED: the stand did not finish within 900 seconds"); for (const k of kids) k.kill("SIGKILL"); process.exit(1); }, 900_000);
try {
  if (mutant) {
    cpSync(join(repo, "packages/core/src"), mutantDir, { recursive: true });
    const kinds = join(mutantDir, "documents/kinds.ts");
    const src = readFileSync(kinds, "utf8");
    const lines = src.split("\n");
    const kept = lines.filter((l) => !l.includes('kind: "rar"'));
    assert.equal(lines.length - kept.length, 1, "the RAR record was not found in the copy of kinds.ts");
    writeFileSync(kinds, kept.join("\n"));
    console.log("mutant: the RAR record is removed from KIND_SIGNATURES in the copy of packages/core/src");
  }
  for (const lang of LANGS) {
    await refusals(lang);
    await accepted(lang);
    await folder(lang);
    if (!mutant) { await mcp(lang); await desktop(lang); }
  }
  await formats();
} finally {
  clearTimeout(guard);
  for (const k of kids) k.kill("SIGKILL");
  if (mutant) { rmSync(mutantDir, { recursive: true, force: true }); rmSync(fx, { recursive: true, force: true }); if (!given) rmSync(work, { recursive: true, force: true }); }
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failed:`);
  for (const f of failures) console.log(`  - ${f.split("\n")[0]}`);
  const rar = failures.some((f) => f.toLowerCase().includes("rar"));
  if (mutant) console.log(rar ? "MUTANT DETECTED: the RAR failure is named above" : "MUTANT NOT NAMED: failures do not mention RAR");
  console.error(`FAILED (${checks} checks passed, ${failures.length} failed)${mutant ? "" : `\nFixtures left in ${fx}; data in ${work}`}`);
  process.exit(1);
}
if (mutant) { console.error(`MUTANT SURVIVED: no check failed on the copy without the RAR record (${checks} checks)`); process.exit(1); }
rmSync(fx, { recursive: true, force: true });
if (!given) rmSync(work, { recursive: true, force: true });
console.log(`PASS (${checks} checks, 0 model calls)`);
process.exit(0);
