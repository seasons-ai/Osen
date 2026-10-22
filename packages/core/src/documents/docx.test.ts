import { describe, expect, it } from "vitest";
import { docxText } from "./docx.ts";
import { makeDocx, makeZip, p, table, type DocxSpec } from "./fixture.ts";
import { openZip } from "./zip.ts";

const text = (spec: DocxSpec): string => docxText(openZip(makeDocx(spec)));

describe("DOCX text", () => {
  it("Документ со ссылкой: a hyperlink and an external picture give only the text, not the addresses", () => {
    const body = `<w:p><w:hyperlink r:id="rId90"><w:r><w:t>link text</w:t></w:r></w:hyperlink><w:r><w:drawing><a:blip r:link="rId91"/></w:drawing></w:r></w:p>`;
    expect(text({ body })).toBe("link text");
  });

  it("a table row is one line: breaks and tabs inside a cell become spaces", () => {
    const cell = `<w:tc><w:p><w:r><w:t>A</w:t><w:br/><w:t>B</w:t><w:tab/><w:t>C</w:t></w:r></w:p></w:tc>`;
    expect(text({ body: `<w:tbl><w:tr>${cell}<w:tc>${p("D")}</w:tc></w:tr></w:tbl>` })).toBe("A B C\tD");
  });

  it("w:del excluded: a deleted table cell (w:cellDel) is dropped", () => {
    const body = `<w:tbl><w:tr><w:tc><w:tcPr><w:cellDel w:id="1"/></w:tcPr>${p("GONE")}</w:tc><w:tc>${p("kept")}</w:tc></w:tr></w:tbl>`;
    expect(text({ body })).toBe("kept");
  });

  it("embedded objects are not taken: a text box inside w:object stays out", () => {
    const body = `<w:p><w:r><w:t>host</w:t></w:r><w:r><w:object><w:txbxContent>${p("OLE")}</w:txbxContent></w:object></w:r></w:p>`;
    expect(text({ body })).toBe("host");
  });

  it("separator notes are skipped, including continuationNotice", () => {
    expect(text({ body: p("main"), footnotes: `<w:footnote w:type="continuationNotice" w:id="5">${p("NOTICE")}</w:footnote><w:footnote w:id="1">${p("note")}</w:footnote>` })).toBe("main\n\nnote");
  });

  it("mc:AlternateContent nested inside w:drawing gives the text box once (mc:Fallback skipped)", () => {
    const box = (t: string) => `<w:txbxContent>${p(t)}</w:txbxContent>`;
    const body = `<w:p><w:r><w:t>host</w:t></w:r><w:r><w:drawing><mc:AlternateContent><mc:Choice Requires="wps">${box("box")}</mc:Choice><mc:Fallback>${box("box")}</mc:Fallback></mc:AlternateContent></w:drawing></w:r></w:p>`;
    expect(text({ body })).toBe("host\nbox");
  });

  it("Абзацы и таблица: paragraphs in order, then table rows with tab-separated cells", () => {
    expect(text({ body: p("Первый") + p("Второй") + table([["a", "b"], ["c", "d"]]) })).toBe("Первый\nВторой\na\tb\nc\td");
  });

  it("joins paragraphs inside a table cell with a space and keeps document order around the table", () => {
    const cell = `<w:tbl><w:tr><w:tc>${p("x")}${p("y")}</w:tc><w:tc>${p("z")}</w:tc></w:tr></w:tbl>`;
    expect(text({ body: p("before") + cell + p("after") })).toBe("before\nx y\tz\nafter");
  });

  it("Правки и сноски: inserted text stays, deleted text goes, notes follow after an empty line", () => {
    const body = `<w:p><w:r><w:t>keep </w:t></w:r><w:ins><w:r><w:t>added</w:t></w:r></w:ins><w:del><w:r><w:delText>removed</w:delText></w:r></w:del></w:p>`;
    const out = text({ body, footnotes: `<w:footnote w:id="1">${p("Note one")}</w:footnote>`, endnotes: `<w:endnote w:id="1">${p("End one")}</w:endnote>` });
    expect(out).toBe("keep added\n\nNote one\nEnd one");
  });

  it("вставленные правки (w:ins) входят, удалённые (w:del) не входят: a deleted table row is dropped", () => {
    const row = `<w:tr><w:trPr><w:del w:id="1"/></w:trPr><w:tc>${p("GONE")}</w:tc></w:tr>`;
    expect(text({ body: `<w:tbl>${row}<w:tr><w:tc>${p("kept")}</w:tc></w:tr></w:tbl>` })).toBe("kept");
  });

  it("collects rows and cells wrapped in content controls and customXml", () => {
    const sdt = (inner: string): string => `<w:sdt><w:sdtPr/><w:sdtContent>${inner}</w:sdtContent></w:sdt>`;
    const row = (cells: string): string => `<w:tr>${cells}</w:tr>`;
    const tc = (t: string): string => `<w:tc>${p(t)}</w:tc>`;
    const body = `<w:tbl>${sdt(row(tc("a") + tc("b")))}<w:customXml>${row(sdt(tc("c")) + `<w:customXml>${tc("d")}</w:customXml>`)}</w:customXml></w:tbl>`;
    expect(text({ body })).toBe("a\tb\nc\td");
  });

  it("skips w:moveFrom (old position of a move) and keeps w:moveTo", () => {
    const run = (t: string): string => `<w:r><w:t>${t}</w:t></w:r>`;
    expect(text({ body: `<w:p>${run("x")}<w:moveFrom>${run("MOVED")}</w:moveFrom><w:moveTo>${run("MOVED")}</w:moveTo></w:p><w:moveFrom>${p("BLOCK")}</w:moveFrom>` })).toBe("xMOVED");
  });

  it("skips separator notes: a document with empty notes gets no tail", () => {
    expect(text({ body: p("only"), footnotes: "", endnotes: "" })).toBe("only");
  });

  it("Колонтитулы и комментарии: header and comment text never appear", () => {
    const out = text({
      body: p("body"), header: p("HEADER-TEXT"),
      comments: `<w:comment w:id="0">${p("COMMENT-TEXT")}</w:comment>`,
    });
    expect(out).toBe("body");
  });

  it("Кириллица и знаки вне BMP: text is kept and chars count an emoji as 2", () => {
    const out = text({ body: p("Привет, мир 😀") });
    expect(out).toBe("Привет, мир 😀");
    expect(out.length).toBe("Привет, мир ".length + 2);
  });

  it("maps tab, break, carriage return and non-breaking hyphen", () => {
    const body = `<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t><w:cr/><w:noBreakHyphen/><w:t>d</w:t></w:r></w:p>`;
    expect(text({ body })).toBe("a\tb\nc\n-d");
  });

  it("takes one variant of mc:AlternateContent and a text box exactly once", () => {
    const box = (t: string): string => `<w:txbxContent>${p(t)}</w:txbxContent>`;
    const body = `<w:p><w:r><w:t>lead</w:t></w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:r><w:drawing><wps:txbx>${box("BOX")}</wps:txbx></w:drawing></w:r></mc:Choice>` +
      `<mc:Fallback><w:r><w:pict><v:textbox>${box("BOX")}</v:textbox></w:pict></w:r></mc:Fallback></mc:AlternateContent></w:p>` +
      `<w:p><w:r><w:drawing><a:blip/></w:drawing></w:r></w:p>`;
    const out = text({ body });
    expect(out.split("BOX")).toHaveLength(2);
    expect(out).toBe("lead\nBOX\n");
  });

  it("gives DOCM the same text as DOCX", () => {
    const spec = { body: p("same") + table([["1", "2"]]), footnotes: `<w:footnote w:id="1">${p("n")}</w:footnote>` };
    expect(text({ ...spec, macro: true })).toBe(text(spec));
  });

  it("falls back to word/document.xml without _rels/.rels and strips control characters", () => {
    const zip = openZip(makeZip([{ name: "word/document.xml", data: `<w:document xmlns:w="w"><w:body>${p("a\u0001b\u000bc")}</w:body></w:document>` }]));
    expect(docxText(zip)).toBe("abc");
  });

  it("replaces lone surrogates", () => {
    expect(text({ body: p("a\ud800b") })).toBe("a\ufffdb");
  });

  it("returns no visible text for empty paragraphs", () => {
    expect(text({ body: p("") + p("  ") }).trim()).toBe("");
  });
});

// Property "Текст DOCX": a seeded generator, the extracted text equals the paragraphs joined by a newline.
describe("DOCX text property", () => {
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const words = ["Привет", "мир", "😀", "a<b", "x&y", "дом", "Ё"];

  it("equals the generated paragraphs joined by newline", () => {
    const next = rng(2080);
    for (let c = 0; c < 100; c++) {
      const expected: string[] = [];
      let body = "";
      for (let n = 1 + Math.floor(next() * 8); n > 0; n--) {
        let line = "", xml = "";
        for (let k = Math.floor(next() * 4); k > 0; k--) {
          const w = words[Math.floor(next() * words.length)]!;
          const esc = w.replace(/&/g, "&amp;").replace(/</g, "&lt;");
          const sep = next();
          xml += `<w:r><w:t>${esc}</w:t>${sep < 0.2 ? "<w:tab/>" : sep < 0.4 ? "<w:br/>" : ""}</w:r>`;
          line += w + (sep < 0.2 ? "\t" : sep < 0.4 ? "\n" : "");
        }
        expected.push(line);
        body += `<w:p>${xml}</w:p>`;
      }
      expect(text({ body }), `case ${c}`).toBe(expected.join("\n"));
    }
  });
});
