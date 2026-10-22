import { describe, expect, it } from "vitest";
import { extractDocument } from "./detect.ts";
import { DOC_LIMITS, extractDocumentText } from "./extract.ts";
import { makeZip } from "./fixture.ts";
import { makeOdf, odpPage, odsTable, odtH, odtP, odtTable } from "./odf-fixture.ts";

const run = (bytes: Uint8Array, chars: number = DOC_LIMITS.chars) => extractDocument(bytes, { ...DOC_LIMITS, chars });
const text = (bytes: Uint8Array): string => {
  const r = run(bytes);
  if (!r.ok) throw new Error(`failed: ${r.code}`);
  return r.text;
};
const body = (kind: string, inner: string): Uint8Array => makeOdf({ kind, body: inner });

describe("Текст OpenDocument", () => {
  it("Текстовый документ с таблицей: heading, paragraphs and a 2x2 table; template accepted", () => {
    const inner = odtH("Заголовок") + odtP("Первый абзац") + odtP("Второй абзац") + odtTable([["a", "b"], ["c", "d"]]);
    expect(run(body("text", inner))).toEqual({ ok: true, text: "Заголовок\nПервый абзац\nВторой абзац\na\tb\nc\td", format: "odt" });
    expect(run(body("text-template", inner))).toMatchObject({ ok: true, format: "odt" });
  });

  it("inline rules: whitespace collapse, text:s, tab, line-break, span and link recursion", () => {
    const p = `<text:p>a  \n  b<text:s text:c="3"/>c<text:tab/>d<text:line-break/>e<text:span> f</text:span><text:a xlink:href="http://x.test/SECRET">g</text:a></text:p>`;
    expect(text(body("text", p))).toBe("a b   c\td\ne fg");
  });

  it("Сноски и заметки докладчика: a footnote in mid-paragraph goes after all main text", () => {
    const note = `<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body>${odtP("Сноска")}</text:note-body></text:note>`;
    const inner = `<text:p>до ${note}после</text:p>` + odtP("конец");
    expect(text(body("text", inner))).toBe("до после\nконец\n\nСноска");
  });

  it("Комментарии и удалённые правки: annotation and deleted text are gone, inserted text stays", () => {
    const ann = `<office:annotation><dc:creator>Рецензент</dc:creator><dc:date>2024-01-02T00:00:00</dc:date>${odtP("КОММЕНТАРИЙ")}</office:annotation><office:annotation-end/>`;
    const tracked = `<text:tracked-changes><text:changed-region text:id="c1"><text:deletion><office:change-info><dc:creator>Автор</dc:creator><dc:date>2024-01-03</dc:date></office:change-info>${odtP("удалено")}</text:deletion></text:changed-region></text:tracked-changes>`;
    const inner = tracked + `<text:p>остаётся ${ann}<text:change-start text:change-id="c2"/>вставлено</text:p>`;
    const out = text(body("text", inner));
    expect(out).toBe("остаётся вставлено");
    for (const bad of ["КОММЕНТАРИЙ", "Рецензент", "удалено", "Автор", "2024"]) expect(out).not.toContain(bad);
  });

  it("text boxes after the paragraph, pictures and embedded objects skipped", () => {
    const frame = `<draw:frame><draw:text-box>${odtP("в рамке")}</draw:text-box></draw:frame><draw:frame><draw:image><text:p>IMG</text:p></draw:image><svg:title>T</svg:title></draw:frame><draw:object><text:p>OBJ</text:p></draw:object>`;
    expect(text(body("text", `<text:p>host${frame}</text:p>`))).toBe("host\nв рамке");
  });

  it("Листы таблицы и страницы презентации: ODS sheets, skipped empty rows, dropped trailing cells, kept middle gap", () => {
    const inner = odsTable("Итоги", [["a", "", "c", "", ""], ["", ""], ["d"]]) + odsTable("Детали", [["x"]]);
    expect(text(body("spreadsheet", inner))).toBe("# Итоги\na\t\tc\nd\n\n# Детали\nx");
  });

  it("Листы таблицы: repeats of empty rows and cells make no text and are instant; repeated non-empty row is output N times", () => {
    const inner = `<table:table table:name="S"><table:table-row table:number-rows-repeated="1048576"><table:table-cell table:number-columns-repeated="1000000"/></table:table-row>`
      + `<table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"><text:p>z</text:p></table:table-cell><table:table-cell table:number-columns-repeated="1000000"/></table:table-row></table:table>`;
    const t0 = Date.now();
    expect(text(body("spreadsheet", inner))).toBe("# S\nz\tz\nz\tz");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("a non-empty cell repeated a million times is refused with chars, never truncated", () => {
    const inner = `<table:table table:name="S"><table:table-row><table:table-cell table:number-columns-repeated="1000000"><text:p>x</text:p></table:table-cell></table:table-row></table:table>`;
    expect(run(body("spreadsheet", inner), 1000)).toEqual({ ok: false, code: "chars" });
    const rows = `<table:table table:name="S"><table:table-row table:number-rows-repeated="1000000"><table:table-cell><text:p>x</text:p></table:table-cell></table:table-row></table:table>`;
    expect(run(body("spreadsheet", rows), 1000)).toEqual({ ok: false, code: "chars" });
    expect(run(body("text", `<text:p>a<text:s text:c="999999999"/></text:p>`), 1000)).toEqual({ ok: false, code: "chars" });
  });

  it("ODS: a header row group and sheets with an empty sheet keep the sheet header; all-empty spreadsheet is no_text", () => {
    const grouped = `<table:table table:name="G"><table:table-header-rows><table:table-row><table:table-cell><text:p>h</text:p></table:table-cell></table:table-row></table:table-header-rows><table:table-rows><table:table-row-group><table:table-row><table:table-cell><text:p>v</text:p></table:table-cell></table:table-row></table:table-row-group></table:table-rows></table:table>`;
    expect(text(body("spreadsheet", grouped + odsTable("E", [])))).toBe("# G\nh\nv\n\n# E");
    expect(run(body("spreadsheet", odsTable("A", [["", ""]]) + odsTable("B", [])))).toEqual({ ok: false, code: "no_text" });
  });

  it("Листы таблицы и страницы презентации: ODP pages with text and a note, thumbnail not in text", () => {
    const inner = odpPage(["Один", "Раз"], "Заметка") + odpPage(["Два"]);
    expect(text(body("presentation", inner))).toBe("# 1\nОдин\nРаз\n\nЗаметка\n\n# 2\nДва");
    expect(text(body("presentation", inner))).not.toContain("THUMB");
    expect(run(body("presentation", odpPage([]) + odpPage([])))).toEqual({ ok: false, code: "no_text" });
    expect(text(body("presentation", odpPage([]) + odpPage(["x"])))).toBe("# 1\n\n# 2\nx");
  });

  it("Формат по содержимому: mimetype need not be the first entry; other and long mimetype are unsupported", () => {
    expect(run(makeOdf({ kind: "text", body: odtP("hi"), mimetypeFirst: false }))).toMatchObject({ ok: true, format: "odt" });
    const content = makeZip([{ name: "mimetype", data: "application/x-foo", method: 0 }, { name: "content.xml", data: "<a/>" }]);
    expect(run(content)).toEqual({ ok: false, code: "unsupported" });
    const long = "application/vnd.oasis.opendocument.text" + " ".repeat(200);
    expect(run(makeZip([{ name: "mimetype", data: long, method: 0 }]))).toEqual({ ok: false, code: "unsupported" });
    expect(run(makeOdf({ kind: "application/vnd.oasis.opendocument.text-master", body: "" }))).toEqual({ ok: false, code: "odf_kind", detail: "text-master" });
    expect(run(makeOdf({ kind: "application/vnd.oasis.opendocument.textual", body: "" }))).toEqual({ ok: false, code: "unsupported" });
  });

  it("Зашифрованный и неподдерживаемый вид: graphics kinds name the kind; encrypted is refused before content.xml is read", () => {
    expect(run(body("graphics", ""))).toEqual({ ok: false, code: "odf_kind", detail: "graphics" });
    expect(run(body("graphics-template", ""))).toEqual({ ok: false, code: "odf_kind", detail: "graphics" });
    for (const kind of ["text", "spreadsheet", "presentation"]) expect(run(makeOdf({ kind, body: "", encrypted: true }))).toEqual({ ok: false, code: "encrypted" });
    expect(run(makeOdf({ kind: "text", body: odtP("ok"), manifest: false }))).toMatchObject({ ok: true });
    expect(run(makeOdf({ kind: "text", body: odtP("ok") }))).toMatchObject({ ok: true });
  });

  it("damaged: DOCTYPE in content.xml, missing content.xml, wrong body; empty text is no_text", () => {
    const doctype = makeZip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 }, { name: "content.xml", data: "<!DOCTYPE x><a/>" }]);
    expect(run(doctype)).toEqual({ ok: false, code: "damaged" });
    expect(run(makeZip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 }]))).toEqual({ ok: false, code: "damaged" });
    const wrong = makeOdf({ kind: "application/vnd.oasis.opendocument.text", body: "" });
    expect(run(wrong)).toEqual({ ok: false, code: "no_text" });
    const mismatch = makeZip([{ name: "mimetype", data: "application/vnd.oasis.opendocument.spreadsheet", method: 0 },
      { name: "content.xml", data: '<office:document-content xmlns:office="o"><office:body><office:text/></office:body></office:document-content>' }]);
    expect(run(mismatch)).toEqual({ ok: false, code: "damaged" });
  });

  it("real child process: extractDocumentText accepts an ODT", () => {
    expect(extractDocumentText(body("text", odtP("через процесс")))).toMatchObject({ ok: true, text: "через процесс", format: "odt" });
  });

  it("Текст OpenDocument: порядок абзацев и листов", () => {
    let seed = 20241022;
    const rnd = (): number => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const word = (): string => (rnd() < 0.2 ? "" : Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => "абвгдежзик&<x"[Math.floor(rnd() * 13)]).join(""));
    for (let i = 0; i < 200; i++) {
      const paras = Array.from({ length: 1 + Math.floor(rnd() * 12) }, word);
      if (!paras.some((x) => x !== "")) paras.push("z");
      expect(text(body("text", paras.map(odtP).join("")))).toBe(paras.join("\n"));
      const sheets = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, k) => ({ name: `Лист${k}${word()}`, cells: Array.from({ length: Math.floor(rnd() * 4) }, () => [word() || "q", word() || "w"]) }));
      if (!sheets.some((s) => s.cells.length)) sheets[0]!.cells.push(["k", "m"]);
      const want = sheets.map((s) => [`# ${s.name}`, ...s.cells.map((r) => r.join("\t"))].join("\n")).join("\n\n");
      expect(text(body("spreadsheet", sheets.map((s) => odsTable(s.name, s.cells)).join("")))).toBe(want);
    }
  });
});
