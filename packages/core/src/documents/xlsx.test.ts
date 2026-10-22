import { describe, expect, it } from "vitest";
import { extractDocument } from "./detect.ts";
import { DOC_LIMITS, documentReason, extractDocumentText } from "./extract.ts";
import { makeXlsx, makeZip, type XlsxSpec } from "./fixture.ts";

const run = (spec: XlsxSpec) => extractDocument(makeXlsx(spec), DOC_LIMITS);
const text = (spec: XlsxSpec): string => {
  const r = run(spec);
  if (!r.ok) throw new Error(r.code);
  return r.text;
};

describe("XLSX text", () => {
  it("two sheets in workbook order, not file order", () => {
    const spec: XlsxSpec = { scramble: true, sheets: [{ name: "Продажи", rows: [["Товар", "Цена"], ["Хлеб", 40]] }, { name: "План", rows: [["x"]] }] };
    expect(text(spec)).toBe("# Продажи\nТовар\tЦена\nХлеб\t40\n\n# План\nx");
    expect(run(spec)).toMatchObject({ ok: true, format: "xlsx" });
  });

  it("formula gives the cached value, boolean TRUE/FALSE, a date stays a serial number, an error keeps its code", () => {
    const rows = [[{ f: "A2*2", v: 42 }, true, false, 45292, { error: "#DIV/0!" }, { f: "B1", v: "кэш" }, { f: "1+1" }, "после"]];
    expect(text({ sheets: [{ name: "S", rows }] })).toBe("# S\n42\tTRUE\tFALSE\t45292\t#DIV/0!\tкэш\t\tпосле");
  });

  it("a formula without a cached value is an empty cell and its text is never shown", () => {
    expect(text({ sheets: [{ name: "S", rows: [["a", { f: "SECRET()" }, "c"]] }] })).toBe("# S\na\t\tc");
  });

  it("hidden and veryHidden sheets stay, chartsheets are skipped, empty rows and right tails drop out", () => {
    const sheets = [
      { name: "A", rows: [["x", null, null], [null, null], [], [null, "y", ""]] },
      { name: "H", hidden: true as const, rows: [["h"]] },
      { name: "Chart", chartsheet: true },
      { name: "V", hidden: "very" as const, rows: [["v"]] },
      { name: "Empty", rows: [] },
    ];
    expect(text({ sheets })).toBe("# A\nx\n\ty\n\n# H\nh\n\n# V\nv\n\n# Empty");
  });

  it("columns come from the cell reference: gaps keep their tab positions; cells without r follow the previous column", () => {
    const sheetData = '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="C1" t="inlineStr"><is><t>c</t></is></c></row>'
      + '<row r="2"><c t="inlineStr"><is><t>p</t></is></c><c t="inlineStr"><is><t>q</t></is></c><c r="E2" t="inlineStr"><is><t>e</t></is></c><c><v>6</v></c></row>';
    expect(text({ sheets: [{ name: "S", sheetData }] })).toBe("# S\na\t\tc\np\tq\t\t\te\t6");
  });

  it("tabs and newlines inside a cell become one space each and the row stays one line", () => {
    const spec: XlsxSpec = { sheets: [{ name: "S", rows: [["A", "x\ty\nz\r\nw\rv", "C"]] }] };
    expect(text(spec)).toBe("# S\nA\tx y z w v\tC");
  });

  it("shared rich text runs are joined, phonetic hints are ignored, inline strings follow the same rule", () => {
    const sharedXml = '<si><r><t>Hel</t></r><r><rPr/><t>lo</t></r><rPh sb="0"><t>PHON</t></rPh></si><si><t>plain</t><phoneticPr/></si>';
    const sheetData = '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><r><t>in</t></r><r><t>line</t></r><rPh><t>X</t></rPh></is></c></row>';
    expect(text({ sharedXml, sheets: [{ name: "S", sheetData }] })).toBe("# S\nHello\tplain\tinline");
  });

  it("prefixed SpreadsheetML names are read like unprefixed ones", () => {
    const sheetData = '<x:row><x:c r="A1" t="inlineStr"><x:is><x:t>pref</x:t></x:is></x:c></x:row>';
    expect(text({ sheets: [{ name: "S", sheetData }] })).toBe("# S\npref");
  });

  it("XLSM gives the same text as XLSX and the macro is not read", () => {
    const sheets = [{ name: "S", rows: [["a", 1, true]] }];
    const xlsx = text({ sheets });
    expect(text({ sheets, macro: true })).toBe(xlsx);
    expect(run({ sheets, macro: true })).toMatchObject({ ok: true, format: "xlsx" });
  });

  it("a workbook without a non-empty cell is no_text", () => {
    expect(run({ sheets: [{ name: "A", rows: [[null, ""], []] }, { name: "B" }] })).toEqual({ ok: false, code: "no_text" });
  });

  it("damaged: a missing sheet part, a bad shared string index, a dangling relationship, broken XML", () => {
    expect(run({ sheets: [{ name: "S", sheetData: '<row><c r="A1" t="s"><v>5</v></c></row>' }], sharedXml: "<si><t>a</t></si>" })).toEqual({ ok: false, code: "damaged" });
    expect(run({ sheets: [{ name: "S", sheetData: '<row><c r="A1" t="s"><v>x</v></c></row>' }], sharedXml: "<si><t>a</t></si>" })).toEqual({ ok: false, code: "damaged" });
    expect(run({ sheets: [{ name: "S", sheetData: '<row><c r="XFE1" t="inlineStr"><is><t>a</t></is></c></row>' }] })).toEqual({ ok: false, code: "damaged" });
    expect(run({ sheets: [{ name: "S", sheetData: "<row><c>" }] })).toEqual({ ok: false, code: "damaged" });
    const noSheet = makeZip([
      { name: "[Content_Types].xml", data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>' },
      { name: "_rels/.rels", data: '<Relationships><Relationship Id="1" Type="x/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", data: '<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId9"/></sheets></workbook>' },
      { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    ]);
    expect(extractDocument(noSheet, DOC_LIMITS)).toEqual({ ok: false, code: "damaged" });
    const missingPart = makeZip([
      { name: "[Content_Types].xml", data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>' },
      { name: "_rels/.rels", data: '<Relationships><Relationship Id="1" Type="x/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", data: '<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>' },
      { name: "xl/_rels/workbook.xml.rels", data: '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    ]);
    expect(extractDocument(missingPart, DOC_LIMITS)).toEqual({ ok: false, code: "damaged" });
  });

  it("a macro-free template or binary workbook type stays unsupported", () => {
    const zip = makeZip([
      { name: "[Content_Types].xml", data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml"/></Types>' },
      { name: "_rels/.rels", data: '<Relationships><Relationship Id="1" Type="x/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    ]);
    expect(extractDocument(zip, DOC_LIMITS)).toEqual({ ok: false, code: "unsupported" });
  });
});

describe("XLSX cells limit", () => {
  // distinct values keep the compression ratio far below 200
  const big = (cells: number): Uint8Array => {
    const rows: string[] = [];
    for (let i = 0; i < cells; i += 10) {
      let row = "";
      for (let j = 0; j < Math.min(10, cells - i); j++) row += `<c r="${String.fromCharCode(65 + j)}${i / 10 + 1}"><v>${(i + j) * 7919 % 1000003}.${(i * 31 + j) % 977}</v></c>`;
      rows.push(`<row r="${i / 10 + 1}">${row}</row>`);
    }
    return makeXlsx({ sheets: [{ name: "Big", sheetData: rows.join("") }] });
  };

  it("exactly 1 000 000 non-empty cells pass, 1 000 001 are refused with the cells reason, through the child process", () => {
    expect(extractDocumentText(big(1_000_000))).toMatchObject({ ok: true, format: "xlsx" });
    const over = extractDocumentText(big(1_000_001));
    expect(over).toEqual({ ok: false, code: "cells" });
    expect(documentReason({ code: "cells" })).toBe("в таблице больше 1000000 ячеек");
  }, 120_000);

  it("the count is a sum over all sheets", () => {
    const rows = [["a", "b"]];
    const bytes = makeXlsx({ sheets: [{ name: "A", rows }, { name: "B", rows }] });
    expect(extractDocument(bytes, { ...DOC_LIMITS, cells: 4 })).toMatchObject({ ok: true });
    expect(extractDocument(bytes, { ...DOC_LIMITS, cells: 3 })).toEqual({ ok: false, code: "cells" });
  });
});

describe("XLSX chars limit and whitespace", () => {
  const xfd = (rows: number): Uint8Array => makeXlsx({ sheets: [{ name: "W", sheetData: Array.from({ length: rows }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}" t="inlineStr"><is><t>v${i}</t></is></c></row>`).join("") }] });

  it("padded rows count against chars: refused as chars with a small limit, accepted with a large one", () => {
    const bytes = xfd(3);
    expect(extractDocument(bytes, { ...DOC_LIMITS, chars: 1000 })).toEqual({ ok: false, code: "chars" });
    expect(extractDocument(bytes, { ...DOC_LIMITS, chars: 100_000 })).toMatchObject({ ok: true });
  });

  it("a few XML bytes that fan out to gigabytes stop at chars before the text is built", () => {
    const t = Date.now();
    expect(extractDocument(xfd(100_000), DOC_LIMITS)).toEqual({ ok: false, code: "chars" });
    expect(Date.now() - t).toBeLessThan(5000);
  }, 30_000);

  it("the limit is exact on the output length", () => {
    const bytes = makeXlsx({ sheets: [{ name: "S", rows: [["ab", "c"]] }] });
    const len = "# S\nab\tc".length;
    expect(extractDocument(bytes, { ...DOC_LIMITS, chars: len })).toMatchObject({ ok: true });
    expect(extractDocument(bytes, { ...DOC_LIMITS, chars: len - 1 })).toEqual({ ok: false, code: "chars" });
  });

  it("a book whose only cell is whitespace is no_text, like DOCX", () => {
    expect(run({ sheets: [{ name: "S", rows: [[{ inline: " " }]] }] })).toEqual({ ok: false, code: "no_text" });
    expect(run({ sheets: [{ name: "S", rows: [[{ inline: "\t\n" }]] }] })).toEqual({ ok: false, code: "no_text" });
  });
});
