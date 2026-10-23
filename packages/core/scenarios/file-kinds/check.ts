// Live check of reasons by file kind (change 216): real council --attach, real MCP server over stdio, real main-process materials draft of the app.
// Scripted participants only, 0 model calls. Text steps run on ru and on en.
//   COUNCIL_DEV=1 [COUNCIL_HOME=<new folder inside the project>] node packages/core/scenarios/file-kinds/check.ts [--mutant]
// Without COUNCIL_HOME the stand creates .council-data/file-kinds-<stamp> and removes it on success. A COUNCIL_HOME given is kept.
// Fixture files are generated in code (kind-fixtures.ts and the generators of changes 208-215) in a temp folder that is removed on success.
// --mutant [rar|format-list|kind-overlap]: the stand runs against a mutated copy of packages/core/src and must exit non-zero naming the cause:
//   rar (default): see below. format-list: XLSB is added to the copy of the supportedFormats list; the stand names XLSB.
//   kind-overlap: a record with PK\x03\x04 at offset 0 is added to the copy of KIND_SIGNATURES; the stand names the accepted file and the kind found.
// --mutant rar: the RAR record is removed from KIND_SIGNATURES in a copy of packages/core/src, the terminal steps run on that copy; the stand must exit non-zero and name RAR.
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

const usage = "COUNCIL_DEV=1 [COUNCIL_HOME=<new folder inside the project>] node packages/core/scenarios/file-kinds/check.ts [--mutant [rar|format-list|kind-overlap]]";
if (process.env.COUNCIL_DEV !== "1") { console.error(`Usage: ${usage}`); process.exit(2); }
const mi = process.argv.indexOf("--mutant");
const mutant = mi >= 0;
const mutantMode = !mutant ? "" : process.argv[mi + 1] && !process.argv[mi + 1]!.startsWith("--") ? process.argv[mi + 1]! : "rar";
if (mutant && !["rar", "format-list", "kind-overlap"].includes(mutantMode)) { console.error(`Unknown mutant ${mutantMode}. Usage: ${usage}`); process.exit(2); }
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
const srcDir = mutant ? mutantDir : join(repo, "packages/core/src");
const coreEntry = join(srcDir, "council.ts");
const consensus = ["p1", "p2"].flatMap((x) => ["--participant", `scripted:${join(repo, "packages/core/scenarios/consensus", `${x}.json`)}`]);
const cli = (lang: Lang, args: string[]) => run([coreEntry, ...args], { ...baseEnv, COUNCIL_LANG: lang, COUNCIL_HOME: homes(lang).cli });
const attach = (lang: Lang, paths: string[], extra: string[] = []) => cli(lang, ["--topic", "What is in the files?", ...paths.flatMap((f) => ["--attach", f]), ...consensus, "--max-rounds", "3", ...extra]);
const sessionsOf = (lang: Lang) => { const d = join(homes(lang).cli, "sessions"); return existsSync(d) ? readdirSync(d).length : 0; };

// ---- fixture files ----
const EXT: Record<FileKindId, string> = {
  mp3: "mp3", aac: "aac", m4a: "m4a", wav: "wav", aiff: "aiff", flac: "flac", ogg: "ogg", video: "mp4", rar: "rar", "7z": "7z", tar: "tar", gzip: "gz", bzip2: "bz2", xz: "xz", zstd: "zst",
  dmg: "dmg", program: "bin", sqlite: "db", font: "ttf", xls: "xls", ppt: "ppt", xlsb: "xlsb", iwork: "pages", unknown: "bin",
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
const xlsbBytes = KIND_FIXTURES.find((k) => k.kind === "xlsb")!.bytes;
const binXlsb = put("ok/bin.xlsb", xlsbBytes);
const bookZip = put("ok/book.zip", xlsbBytes);
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
    { name: "XLSB named bin.xlsb", file: binXlsb, reason: m.kindReason("xlsb"), tag: "xlsb" },
    { name: "XLSB named book.zip", file: bookZip, reason: m.kindReason("xlsb"), tag: "xlsb" },
    { name: "ZIP over 100 MiB", file: hugeZip, reason: m.zipTooLarge(100), tag: "zip" },
  ];
  const results = await mapLimit(cases, 6, async (c) => ({ c, r: await attach(lang, [c.file], ["--max-rounds", "1"]) }));
  for (const { c, r } of results) {
    await check(`2 [${lang}] ${c.tag} (${c.name}): exit 2, «${basename(c.file)}»: ${c.reason}`, () => {
      assert.equal(r.code, 2, `exit code ${r.code}${dump(r)}`);
      assert.equal(r.out, "", `stdout${dump(r)}`);
      assert.ok(r.err.startsWith(`${REJECTED[lang]}\n`) && r.err.includes(`  «${basename(c.file)}»: ${c.reason}\n`), `stderr lacks the reason "${c.reason}"${dump(r)}`);
      if (lang === "en") assert.ok(!CYR.test(r.err.split(fx).join("")), `Cyrillic in the en reason${dump(r)}`);
      if (c.name.startsWith("XLSB")) assert.ok(c.reason === (lang === "ru" ? "двоичная книга Excel (XLSB) — сохраните как XLSX" : "Excel binary workbook (XLSB) — save it as XLSX"), `XLSB reason: ${c.reason}`);
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
  put("all/bin.xlsb", xlsbBytes);
  put("all/book.zip", xlsbBytes);
  const r = await attach(lang, [dir]);
  await check(`4 [${lang}] folder with ${kindFiles.length + 2} files: exit 0, a.md collected, kind reasons before the session id, consensus`, () => {
    assert.equal(r.code, 0, `exit code ${r.code}${dump(r)}`);
    const sid = t[lang].session.exec(r.out);
    assert.ok(sid, `no session line${dump(r)}`);
    const head = r.out.slice(0, sid.index);
    assert.ok(head.includes(lang === "ru" ? "Материалы: 1, объём 1 символов" : "Materials: 1, size 1 characters"), `summary${dump(r)}`);
    for (const k of kindFiles) assert.ok(head.includes(`  all/${k.base} — ${m.kindReason(k.kind)}`), `no skipped line for ${k.base}${dump(r)}`);
    assert.ok(head.includes(`  all/koi.txt — ${m.encodingUnknown}`), `no skipped line for koi.txt${dump(r)}`);
    for (const x of ["bin.xlsb", "book.zip"]) assert.ok(head.includes(`  all/${x} — ${m.kindReason("xlsb")}`), `no XLSB skipped line for ${x}${dump(r)}`);
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
  const OO = "application/vnd.openxmlformats-officedocument", MS = "application/vnd.ms-";
  add("DOTX", "a.dotx", makeDocx({ body: p("Первая строка"), mainType: `${OO}.wordprocessingml.template.main+xml` }));
  add("DOTM", "a.dotm", makeDocx({ body: p("Первая строка"), mainType: `${MS}word.template.macroEnabledTemplate.main+xml` }));
  add("XLSX", "a.xlsx", makeXlsx(sheet));
  add("XLSM", "a.xlsm", makeXlsx({ ...sheet, macro: true }));
  const deck = { slides: [{ shapes: sp(["Название доклада"], "title") }] };
  add("PPTX", "a.pptx", makePptx(deck));
  add("PPTM", "a.pptm", makePptx({ ...deck, macro: true }));
  add("XLTX", "a.xltx", makeXlsx({ ...sheet, mainType: `${OO}.spreadsheetml.template.main+xml` }));
  add("XLTM", "a.xltm", makeXlsx({ ...sheet, mainType: `${MS}excel.template.macroEnabled.main+xml` }));
  add("POTX", "a.potx", makePptx({ ...deck, mainType: `${OO}.presentationml.template.main+xml` }));
  add("POTM", "a.potm", makePptx({ ...deck, mainType: `${MS}powerpoint.template.macroEnabled.main+xml` }));
  add("PPSX", "a.ppsx", makePptx({ ...deck, mainType: `${OO}.presentationml.slideshow.main+xml` }));
  add("PPSM", "a.ppsm", makePptx({ ...deck, mainType: `${MS}powerpoint.slideshow.macroEnabled.main+xml` }));
  add("ODT", "a.odt", makeOdf({ kind: "text", body: odtP("Абзац") }));
  add("ODS", "a.ods", makeOdf({ kind: "spreadsheet", body: odsTable("Итоги", [["Статья", "Сумма"]]) }));
  add("ODP", "a.odp", makeOdf({ kind: "presentation", body: odpPage(["Заголовок слайда"]) }));
  add("OTT", "a.ott", makeOdf({ kind: "text-template", body: odtP("Абзац") }));
  add("OTS", "a.ots", makeOdf({ kind: "spreadsheet-template", body: odsTable("Итоги", [["Статья", "Сумма"]]) }));
  add("OTP", "a.otp", makeOdf({ kind: "presentation-template", body: odpPage(["Заголовок слайда"]) }));
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
// Formats named by a supportedFormats string: elements split by ", " outside parentheses, then by "/";
// an element with parentheses gives one format per name inside; for the others the format is the first word (the explanation is dropped).
function parseFormats(list: string): string[] {
  const elements: string[] = [];
  let depth = 0, cur = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (depth === 0 && list.startsWith(", ", i)) { elements.push(cur); cur = ""; i++; continue; }
    cur += c;
  }
  elements.push(cur);
  return elements.flatMap((e) => {
    const m = /\(([^)]*)\)/.exec(e);
    if (m) return m[1]!.split(", ");
    return e.split("/").map((x) => x.trim().split(" ")[0]!);
  });
}
// The Russian list names pictures «картинки»: one table key
const CANONICAL: Record<string, string> = { "картинки": "pictures" };
async function formats() {
  // the list, the signatures and the table come from the copy of packages/core/src that the stand runs
  const { materialsMessages: listMessages } = await import(join(srcDir, "messages/materials.ts")) as typeof import("../../src/messages/materials.ts");
  const { fileKind, TAIL_BYTES } = await import(join(srcDir, "documents/kinds.ts")) as typeof import("../../src/documents/kinds.ts");
  const { DESCRIPTION_EXTENSIONS } = await import(join(srcDir, "materials.ts")) as typeof import("../../src/materials.ts");
  const HEAD_BYTES = 8192; // as the collector reads (materials.ts)
  const en = listMessages("en");
  const helpOf = async (lang: Lang) => (await cli(lang, ["--help"])).out;
  for (const lang of LANGS) {
    const list = listMessages(lang).supportedFormats;
    await check(`8 council --help [${lang}] holds the list of formats`, async () => assert.ok((await helpOf(lang)).includes(list)));
  }
  await check("8 council --help [en] descriptions list equals the collector extensions", async () => assert.ok((await helpOf("en")).includes(`descriptions (${DESCRIPTION_EXTENSIONS.join(", ")})`)));
  await check("8 skill/osen/SKILL.md and docs/materials.md hold the en list", () => {
    for (const f of ["skill/osen/SKILL.md", "docs/materials.md"]) assert.ok(readFileSync(join(repo, f), "utf8").includes(en.supportedFormats), f);
  });
  const files = formatFiles();
  const parsed = Object.fromEntries(LANGS.map((l) => [l, parseFormats(listMessages(l).supportedFormats).map((x) => CANONICAL[x] ?? x)])) as Record<Lang, string[]>;
  await check("8 the lists parse to the same formats on en and ru", () => assert.deepEqual(parsed.ru, parsed.en));
  const results = await mapLimit(files, 4, async (x) => ({ x, r: await cli("en", ["--attach", x.file, "--preview-materials"]) }));
  const accepted = (token: string) => results.filter((y) => y.x.token === token);
  for (const format of new Set([...parsed.en, ...parsed.ru])) {
    if (!darwin && ["DOC", "pictures"].includes(format)) continue;
    await check(`8 format ${format} of the list has an accepted file`, () => {
      const hits = accepted(format);
      assert.ok(hits.length > 0, `no file for the format ${format}`);
      for (const { x, r } of hits) assert.ok(r.code === 0 && /^Materials: 1,/m.test(r.out), `format ${format}: ${basename(x.file)} is not accepted${dump(r)}`);
    });
  }
  for (const { x, r } of results) {
    await check(`8 format ${x.token} (${basename(x.file)}) accepted: exit 0, one material`, () => {
      assert.equal(r.code, 0, `exit code ${r.code}${dump(r)}`);
      assert.match(r.out, /^Materials: 1,/m, dump(r));
    });
  }
  await check("8 no accepted file is read as a kind of the table (head and tail as the collector reads them)", () => {
    for (const { x } of results) {
      const buf = readFileSync(x.file);
      const kind = fileKind(buf.subarray(0, HEAD_BYTES), buf.length >= TAIL_BYTES ? buf.subarray(buf.length - TAIL_BYTES) : undefined);
      assert.equal(kind, undefined, `accepted file ${basename(x.file)} (${x.token}) is read as the kind ${kind}`);
    }
  });
}

// ---- main ----
const guard = setTimeout(() => { console.error("FAILED: the stand did not finish within 900 seconds"); for (const k of kids) k.kill("SIGKILL"); process.exit(1); }, 900_000);
try {
  if (mutant) {
    cpSync(join(repo, "packages/core/src"), mutantDir, { recursive: true });
    const edit = (rel: string, fn: (src: string) => string) => { const f = join(mutantDir, rel); writeFileSync(f, fn(readFileSync(f, "utf8"))); };
    if (mutantMode === "rar") {
      edit("documents/kinds.ts", (src) => {
        const lines = src.split("\n");
        const kept = lines.filter((l) => !l.includes('kind: "rar"'));
        assert.equal(lines.length - kept.length, 1, "the RAR record was not found in the copy of kinds.ts");
        return kept.join("\n");
      });
      console.log("mutant: the RAR record is removed from KIND_SIGNATURES in the copy of packages/core/src");
    } else if (mutantMode === "format-list") {
      edit("messages/materials.ts", (src) => {
        assert.equal(src.split(", EPUB, RTF").length - 1, 2, "the lists were not found in the copy of materials.ts");
        return src.split(", EPUB, RTF").join(", XLSB, EPUB, RTF");
      });
      console.log("mutant: XLSB is added to the supportedFormats lists in the copy of packages/core/src");
    } else {
      edit("documents/kinds.ts", (src) => {
        const marker = "export const KIND_SIGNATURES: readonly KindSignature[] = [\n";
        assert.ok(src.includes(marker), "KIND_SIGNATURES was not found in the copy of kinds.ts");
        return src.replace(marker, `${marker}  { kind: "program", offset: 0, bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },\n`);
      });
      console.log("mutant: a record with PK\\x03\\x04 at offset 0 is added to KIND_SIGNATURES in the copy of packages/core/src");
    }
  }
  for (const lang of mutantMode === "format-list" || mutantMode === "kind-overlap" ? [] : LANGS) {
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
  const named = { rar: "rar", "format-list": "xlsb", "kind-overlap": "is read as the kind program" }[mutantMode as "rar"];
  if (mutant) console.log(failures.some((f) => f.toLowerCase().includes(named!)) ? `MUTANT DETECTED: the failure naming "${named}" is above` : `MUTANT NOT NAMED: failures do not mention "${named}"`);
  console.error(`FAILED (${checks} checks passed, ${failures.length} failed)${mutant ? "" : `\nFixtures left in ${fx}; data in ${work}`}`);
  process.exit(1);
}
if (mutant) { console.error(`MUTANT SURVIVED (${mutantMode}): no check failed on the mutated copy (${checks} checks)`); process.exit(1); }
rmSync(fx, { recursive: true, force: true });
if (!given) rmSync(work, { recursive: true, force: true });
console.log(`PASS (${checks} checks, 0 model calls)`);
process.exit(0);
