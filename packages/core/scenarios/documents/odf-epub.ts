// OpenDocument (ODT, ODS, ODP) and EPUB part of the document materials stand (change 210); called from check.ts once per language.
// Real council processes and scripted participants only, 0 model calls. The fixtures are generated in code (odf-fixture.ts, epub-fixture.ts).
// Format detection is by content, so the MCP and app sub-stands written for DOCX are reused as they are:
// each format gets its own fixtures folder where report.docx holds the bytes of that format (ODT, ODS, ODP, EPUB),
// expected.txt its expected text and broken.docx a damaged document of the same format.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { makeZip } from "../../src/documents/fixture.ts";
import { makeEpub, xhtml, type EpubSpec } from "../../src/documents/epub-fixture.ts";
import { makeOdf, odpPage, odsTable, odtH, odtP, odtTable } from "../../src/documents/odf-fixture.ts";

export interface Ctx {
  lang: "ru" | "en";
  work: string;
  t: { session: RegExp; summary: (n: number, c: number) => RegExp; rejected: string; skipped: (n: number) => RegExp; leftOut: (n: number) => RegExp; nonText: string; reason: Record<string, string> };
  run: (args: string[]) => Promise<{ code: number | null; r: { out: string; err: string } }>;
  attach: (name: string, f: string, mark: string | undefined, extra?: string[]) => Promise<{ code: number | null; r: { out: string; err: string } }>;
  created: (id: string) => any;
  sessionId: (r: { out: string; err: string }) => string;
  sdir: (id: string) => string;
  journals: () => string[];
  promptLines: () => string[];
  pair: (name: string) => string[];
  parts: (p2: string[]) => string[];
  subStand: (what: string, script: string, dataDir: string, lang: string, extra: string[], fixtures: string) => Promise<{ sha256: string; chars: number; snapshot: string }>;
  dump: (r: { out: string; err: string }) => string;
  ok: (s: string) => void;
}

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const LEAK = /-секрет|2026-01-01T/;

// ---- Fixtures (language independent) ----
const ODT_TEXT = "Заголовок отчёта\nПервый абзац отчёта\nКонец абзаца\nЯчейка А1\tЯчейка Б1\nЯчейка А2\tЯчейка Б2\nАбзац со сноской\n\nСноска: источник данных";
const odt = () => makeOdf({
  kind: "text",
  body: `<text:tracked-changes><text:changed-region text:id="ct1"><text:deletion><office:change-info><dc:creator>Рецензент-секрет</dc:creator><dc:date>2026-01-01T00:00:00</dc:date></office:change-info><text:p>удалено-секрет</text:p></text:deletion></text:changed-region></text:tracked-changes>`
    + odtH("Заголовок отчёта")
    + `<text:p>Первый абзац<office:annotation><dc:creator>Рецензент-секрет</dc:creator><dc:date>2026-01-01T00:00:00</dc:date><text:p>комментарий-секрет</text:p></office:annotation> отчёта</text:p>`
    + `<text:p>Конец <text:change text:change-id="ct1"/>абзаца</text:p>`
    + odtTable([["Ячейка А1", "Ячейка Б1"], ["Ячейка А2", "Ячейка Б2"]])
    + `<text:p>Абзац со сноской<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body>${odtP("Сноска: источник данных")}</text:note-body></text:note></text:p>`,
});
const ODS_TEXT = "# Итоги\nСтатья\tСумма\nВыручка\t100\n\n# Детали\n\tСмещённая ячейка\nКлиент\tЗаказ";
const ods = () => makeOdf({
  kind: "spreadsheet",
  body: odsTable("Итоги", [["Статья", "Сумма"], ["Выручка", "100"]])
    + odsTable("Детали", [["", "Смещённая ячейка"]]).replace("</table:table>", "")
    + `<table:table-row><table:table-cell table:number-columns-repeated="1000000"/></table:table-row>`
    + `<table:table-row table:number-rows-repeated="1048576"><table:table-cell/></table:table-row>`
    + `<table:table-row><table:table-cell office:value-type="string"><text:p>Клиент</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Заказ</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1000000"/></table:table-row></table:table>`,
});
const ODP_TEXT = "# 1\nЗаголовок слайда\nТекст слайда\n\nЗаметка докладчика\n\n# 2\nВторой слайд";
const odp = () => makeOdf({ kind: "presentation", body: odpPage(["Заголовок слайда", "Текст слайда"], "Заметка докладчика") + odpPage(["Второй слайд"]) });

const ch = (n: number, body: string) => ({ path: `OEBPS/ch${n}.xhtml`, html: xhtml(body, { head: "<style>.x{color:red}</style>" }) });
const EPUB_TEXT = "Глава первая\n\nТекст первой главы\n\nГлава вторая\n\nТекст второй главы\n\nГлава третья\n\nТекст третьей главы";
const epub = () => makeEpub({
  chapters: [
    ch(1, `<h1>Глава первая</h1><p>Текст первой главы</p><p hidden="">скрытое-секрет</p><script>var x = "скрипт-секрет";</script><style>.y{content:"стиль-секрет"}</style><p><img alt="картинка-секрет" src="a.png"/></p>`),
    ch(2, "<h1>Глава вторая</h1><p>Текст второй главы</p>"),
    ch(3, "<h1>Глава третья</h1><p>Текст третьей главы</p>"),
  ],
  archiveOrder: ["OEBPS/ch3.xhtml", "OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"],
});

const ENC = (uri: string) => `<?xml version="1.0"?>\n<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="${uri}"/></CipherData></EncryptedData></encryption>`;
const book = (over: Partial<EpubSpec> = {}) => makeEpub({ chapters: [ch(1, "<p>Первая</p>"), ch(2, "<p>Вторая</p>")], ...over });
// A document with a DTD in content.xml: the XML parts are scanned as bytes, so this is damaged in every OpenDocument kind.
function odfDoctype(kind: string): Uint8Array {
  const mime = `application/vnd.oasis.opendocument.${kind}`;
  return makeZip([
    { name: "mimetype", data: mime, method: 0 },
    { name: "content.xml", data: '<?xml version="1.0"?>\n<!DOCTYPE office:document-content [<!ENTITY e "x">]>\n<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>&e;</text:p></office:text></office:body></office:document-content>' },
  ]);
}

// File, reason key in this module's table (damaged-part reasons take the part name).
const REASONS = {
  ru: { drawing: "формат не поддерживается — рисунок OpenDocument", drm: "книга защищена DRM — содержимое недоступно", part: (p: string) => `документ повреждён — ${p}` },
  en: { drawing: "format is not supported — OpenDocument drawing", drm: "book is protected by DRM — its content is not available", part: (p: string) => `document is damaged — ${p}` },
};

export async function odfEpubSuite(c: Ctx) {
  const { lang, t, tag, work } = { ...c, tag: `[${c.lang}]` };
  const R = REASONS[lang];
  const fx = join(work, "odf-fx");
  mkdirSync(fx, { recursive: true });
  const formats = [
    { id: "odt", bytes: odt(), text: ODT_TEXT, broken: odfDoctype("text") },
    { id: "ods", bytes: ods(), text: ODS_TEXT, broken: odfDoctype("spreadsheet") },
    { id: "odp", bytes: odp(), text: ODP_TEXT, broken: odfDoctype("presentation") },
    { id: "epub", bytes: epub(), text: EPUB_TEXT, broken: book({ archiveOrder: ["OEBPS/ch1.xhtml"] }) },
  ];
  for (const f of formats) {
    const d = join(fx, f.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "report.docx"), f.bytes);
    writeFileSync(join(d, "expected.txt"), f.text);
    writeFileSync(join(d, "broken.docx"), f.broken);
  }
  const bytesOf = Object.fromEntries(formats.map((f) => [f.id, f.bytes]));
  const text = Object.fromEntries(formats.map((f) => [f.id, f.text]));

  /** One accepted attach: exact m1.txt, journal hash, every turn request carries the text and none carries service content. */
  async function accepted(step: string, file: string, expected: string) {
    const before = c.promptLines().length;
    const r = await c.attach(step, file, expected);
    assert.equal(r.code, 0, `${step}: code ${r.code}${c.dump(r.r)}`);
    assert.match(r.r.out, t.summary(1, expected.length), `${step}: summary${c.dump(r.r)}`);
    const id = c.sessionId(r.r);
    const m = c.created(id).materials;
    assert.equal(m.length, 1);
    assert.deepEqual([m[0].chars, m[0].sha256], [expected.length, sha(expected)], `${step}: material`);
    assert.equal(readFileSync(join(c.sdir(id), "materials", "m1.txt"), "utf8"), expected, `${step}: m1.txt`);
    const fresh = c.promptLines().slice(before);
    assert.ok(fresh.length >= 2 && fresh.every((l) => { const q = (JSON.parse(l) as { prompt: string }).prompt; return q.includes(expected) && !LEAK.test(q); }), `${step}: turn requests`);
    return { id, turns: fresh.length };
  }

  // ---- 1. ODT / ODS / ODP under foreign names ----
  const named: [string, string][] = [["odt", "noext"], ["odt", "dat"], ["ods", "noext"], ["odp", "dat"]];
  let turns = 0;
  for (const [id, ext] of named) {
    const f = join(fx, ext === "noext" ? `${id}-noext` : `${id}-x.dat`);
    writeFileSync(f, bytesOf[id]!);
    turns += (await accepted(`o1-${id}-${ext}`, f, text[id]!)).turns;
  }
  c.ok(`${tag} 210-1: ODT (heading, table, footnote; no comment, author, date or deleted text), ODS (# sheets, 1000000-repeat empty cell, empty rows) and ODP (# pages, note after a blank line) attached as extensionless and .dat files: exact m1.txt, ${turns} turn requests carry the text`);
  const fake = join(fx, "fake.odt");
  writeFileSync(fake, makeOdf({ kind: "application/x-foo", body: odtP("x") }));
  const rf = await c.run(["--topic", "t", "--attach", fake, ...c.parts(c.pair(`${lang}-o1fake`)), "--max-rounds", "1"]);
  // a ZIP whose mimetype is no supported format is an ordinary archive since change 215: expanded, not refused
  assert.equal(rf.code, 0, c.dump(rf.r));
  assert.ok(!rf.r.err.includes(t.reason.damaged) && !rf.r.err.includes(t.nonText), c.dump(rf.r));
  c.ok(`${tag} 210-1b: a ZIP with mimetype application/x-foo named fake.odt is expanded as an archive (change 215), neither refused as damaged nor as "${t.nonText}"`);

  // ---- 2. EPUB: spine order, no service content ----
  const ep = join(fx, "book.epub");
  writeFileSync(ep, bytesOf.epub!);
  await accepted("o2", ep, EPUB_TEXT);
  c.ok(`${tag} 210-2: EPUB with chapters stored 3,1,2 and spine 1,2,3 gives the text 1,2,3 separated by blank lines; hidden element, script, style and img alt are absent`);

  // ---- 3. Parity and deleted source ----
  for (const f of formats) {
    const dir = join(fx, f.id);
    const mcp = await c.subStand(`MCP ${f.id}`, "packages/mcp/scenarios/documents/check.ts", join(work, `mcp-${f.id}-${lang}`), lang, [t.reason.damaged], dir);
    const app = await c.subStand(`app ${f.id}`, "apps/desktop/scenarios/documents/check.ts", join(work, `desktop-${f.id}-${lang}`), lang, [t.reason.damaged], dir);
    for (const [what, r] of [["MCP", mcp], ["app", app]] as const) {
      assert.equal(r.sha256, sha(f.text), `${f.id} ${what}: sha256`);
      assert.equal(r.chars, f.text.length, `${f.id} ${what}: chars`);
      assert.equal(readFileSync(r.snapshot, "utf8"), f.text, `${f.id} ${what}: snapshot`);
    }
  }
  c.ok(`${tag} 210-3a: chars and sha256 of ODT, ODS, ODP and EPUB are identical in the terminal, MCP council_start and the app main modules; the damaged document of each format is refused`);
  const src = join(work, `tmp-source-${lang}.odt`);
  copyFileSync(join(fx, "odt", "report.docx"), src);
  const rd = await c.attach("o3del", src, ODT_TEXT);
  assert.equal(rd.code, 0, c.dump(rd.r));
  const did = c.sessionId(rd.r);
  rmSync(src);
  const shown = await c.run(["show", did]);
  assert.equal(shown.code, 0, c.dump(shown.r));
  assert.equal(readFileSync(join(c.sdir(did), "materials", "m1.txt"), "utf8"), ODT_TEXT);
  c.ok(`${tag} 210-3b: after the source ODT is deleted the session is still readable (council show exit 0, m1.txt intact)`);

  // ---- 4. Explicit refusals and the same files in a folder ----
  const refused: [string, Uint8Array, string][] = [
    ["encrypted.odt", makeOdf({ kind: "text", body: "", encrypted: true }), t.reason.encrypted ?? ""],
    ["drawing.odg", makeOdf({ kind: "graphics", body: odtP("x") }), R.drawing],
    ["drm.epub", book({ encryption: ENC("OEBPS/ch2.xhtml") }), R.drm],
    ["missing-chapter.epub", book({ archiveOrder: ["OEBPS/ch1.xhtml"] }), R.part("OEBPS/ch2.xhtml")],
    ["escape.epub", book({ chapters: [ch(1, "<p>Первая</p>"), { path: "../../evil.xhtml", html: xhtml("<p>x</p>") }], archiveOrder: ["OEBPS/ch1.xhtml"] }), R.part("../../evil.xhtml")],
    ["doctype.odt", odfDoctype("text"), t.reason.damaged],
  ];
  const okPair = c.pair(`${lang}-o4`);
  const promptsBefore = c.promptLines().length, nBefore = c.journals().length;
  const dir4 = join(fx, "refused");
  mkdirSync(dir4, { recursive: true });
  writeFileSync(join(dir4, "README.md"), "Описание проекта.\n");
  for (const [name, bytes, reason] of refused) {
    const f = join(fx, name);
    writeFileSync(f, bytes);
    writeFileSync(join(dir4, name), bytes);
    const r = await c.run(["--topic", "t", "--attach", f, ...c.parts(okPair), "--max-rounds", "1"]);
    assert.equal(r.code, 2, `${name}: code ${r.code}${c.dump(r.r)}`);
    assert.equal(r.r.out, "", `${name}: stdout${c.dump(r.r)}`);
    assert.equal(r.r.err, `${t.rejected}\n  «${basename(f)}»: ${reason}\n`, `${name}: stderr${c.dump(r.r)}`);
  }
  assert.equal(c.journals().length, nBefore, "a session appeared");
  assert.equal(c.promptLines().length, promptsBefore, "a participant was called");
  c.ok(`${tag} 210-4a: ${refused.length} refusals (encrypted ODT, ODF drawing, EPUB with DRM, spine to a missing chapter, href with .., DOCTYPE in ODT): code 2, exact "${t.rejected}" + reason, no sessions, no participant calls`);
  const fonts = join(fx, "fonts.epub");
  writeFileSync(fonts, book({ encryption: ENC("OEBPS/font.otf") }));
  const rfont = await c.run(["--topic", "t", "--attach", fonts, ...c.parts(c.pair(`${lang}-o4font`)), "--max-rounds", "3"]);
  assert.equal(rfont.code, 0, c.dump(rfont.r));
  c.ok(`${tag} 210-4b: EPUB with encryption.xml only for a font is accepted`);
  const rfold = await c.attach("o4folder", dir4, undefined);
  assert.equal(rfold.code, 0, c.dump(rfold.r));
  const names = (c.created(c.sessionId(rfold.r)).materials as { name: string }[]).map((m) => m.name);
  assert.ok(names.length === 1 && names[0]!.endsWith("README.md"), `collected: ${names}`);
  assert.match(rfold.r.out, t.skipped(refused.length), c.dump(rfold.r));
  for (const [name, , reason] of refused) {
    assert.ok(rfold.r.out.split("\n").some((l) => l.includes(name) && l.includes(reason)), `${name}: no skipped line with «${reason}»${c.dump(rfold.r)}`);
  }
  c.ok(`${tag} 210-4c: the same ${refused.length} files in a folder with a README are skipped with their reasons, README collected, exit 0`);

  // ---- 5. Folder over the limit ----
  const dir5 = join(fx, "limit");
  mkdirSync(dir5, { recursive: true });
  writeFileSync(join(dir5, "README.md"), "Описание проекта.\n");
  writeFileSync(join(dir5, "notes.odt"), makeOdf({ kind: "text", body: odtP("Заметки по проекту") }));
  writeFileSync(join(dir5, "book.epub"), makeEpub({ chapters: [ch(1, "<p>Книга о проекте</p>")] }));
  writeFileSync(join(dir5, "data.ods"), makeOdf({ kind: "spreadsheet", body: odsTable("Данные", Array.from({ length: 40 }, (_, i) => [`Строка номер ${i}`, "значение"])) }));
  const r5 = await c.attach("o5", dir5, undefined, ["--materials-chars", "200"]);
  assert.equal(r5.code, 0, c.dump(r5.r));
  const names5 = (c.created(c.sessionId(r5.r)).materials as { name: string }[]).map((m) => m.name);
  for (const n of ["README.md", "notes.odt", "book.epub"]) assert.ok(names5.some((x) => x.endsWith(n)), `${n} not taken: ${names5}`);
  assert.ok(!names5.some((x) => x.endsWith("data.ods")), `data.ods taken: ${names5}`);
  assert.match(r5.r.out, t.leftOut(1), c.dump(r5.r));
  assert.ok(r5.r.out.includes("data.ods"), "data.ods is not named among the left-out files");
  c.ok(`${tag} 210-5: over the limit README, notes.odt and book.epub are in the initial set, data.ods is left out`);
}
