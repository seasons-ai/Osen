import { describe, expect, it } from "vitest";
import { extractDocument } from "./detect.ts";
import { DOC_LIMITS } from "./extract.ts";
import { grp, makePptx, makeZip, pptxTable, sp, type PptxSpec } from "./fixture.ts";

const run = (spec: PptxSpec) => extractDocument(makePptx(spec), DOC_LIMITS);
const text = (spec: PptxSpec): string => {
  const r = run(spec);
  if (!r.ok) throw new Error(r.code);
  return r.text;
};

describe("PPTX text", () => {
  it("two slides with a title, a bullet, a 2x2 table and a speaker note", () => {
    const spec: PptxSpec = {
      slides: [
        { shapes: sp(["Заголовок"], "title") + sp(["Пункт"]) },
        { shapes: pptxTable([["a", "b"], ["c", "d"]]), notes: sp([""], "sldImg") + sp(["Заметка докладчика"], "body") + sp(["2"], "sldNum") },
      ],
    };
    expect(text(spec)).toBe("# 1\nЗаголовок\nПункт\n\n# 2\na\tb\nc\td\n\nЗаметка докладчика");
    expect(run(spec)).toMatchObject({ ok: true, format: "pptx" });
  });

  it("slides follow the presentation order, not the file order", () => {
    const slides = ["первый", "второй", "третий"].map((t) => ({ shapes: sp([t]) }));
    expect(text({ slides, fileOrder: [3, 1, 2] })).toBe("# 1\nпервый\n\n# 2\nвторой\n\n# 3\nтретий");
  });

  it("a hidden slide stays; a slide without text still gives its number", () => {
    expect(text({ slides: [{ shapes: sp(["a"]), hidden: true }, { shapes: "" }, { shapes: sp(["c"]) }] })).toBe("# 1\na\n\n# 2\n\n# 3\nc");
  });

  it("a presentation without text is no_text, with empty notes too", () => {
    expect(run({ slides: [{ shapes: sp([""]) }, { shapes: "", notes: sp([""], "body") }] })).toEqual({ ok: false, code: "no_text" });
    expect(run({ slides: [] })).toEqual({ ok: false, code: "no_text" });
  });

  it("footer, date and slide number placeholders are excluded; other placeholders stay", () => {
    const shapes = sp(["Тело"], "body") + sp(["подвал"], "ftr") + sp(["дата"], "dt") + sp(["7"], "sldNum") + sp(["подзаголовок"], "subTitle");
    expect(text({ slides: [{ shapes }] })).toBe("# 1\nТело\nподзаголовок");
  });

  it("notes take only the body placeholder (not the thumbnail, number, header or footer) and empty ones add nothing", () => {
    const notes = sp(["thumb"], "sldImg") + sp(["hdr"], "hdr") + sp(["ftr"], "ftr") + sp(["9"], "sldNum") + sp(["note"], "body");
    expect(text({ slides: [{ shapes: sp(["a"]), notes }] })).toBe("# 1\na\n\nnote");
    expect(text({ slides: [{ shapes: sp(["a"]), notes: sp([""], "body") }] })).toBe("# 1\na");
  });

  it("groups are walked in order, line breaks stay, empty paragraphs vanish, fields and runs are joined", () => {
    const shapes = sp(["before"]) + grp(sp(["in group"]) + grp(sp(["deep"]))) + sp(["one\ntwo", "", "three"])
      + '<p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>fi</a:t></a:r><a:fld id="x" type="datetime"><a:t>eld</a:t></a:fld></a:p></p:txBody></p:sp>';
    expect(text({ slides: [{ shapes }] })).toBe("# 1\nbefore\nin group\ndeep\none\ntwo\nthree\nfield");
  });

  it("table cells: paragraphs join with a space, tab and break inside a cell become spaces", () => {
    expect(text({ slides: [{ shapes: pptxTable([["x\n\ny", "a\tb"], ["p", "q"]]) }] })).toBe("# 1\nx y\ta b\np\tq");
  });

  it("mc:AlternateContent gives only the Choice", () => {
    const shapes = `<mc:AlternateContent><mc:Choice Requires="x">${sp(["choice"])}</mc:Choice><mc:Fallback>${sp(["fallback"])}</mc:Fallback></mc:AlternateContent>`;
    expect(text({ slides: [{ shapes }] })).toBe("# 1\nchoice");
  });

  it("pictures and charts give nothing", () => {
    const shapes = '<p:pic><p:txBody><a:p><a:r><a:t>PIC</a:t></a:r></a:p></p:txBody></p:pic><p:graphicFrame><a:graphic><a:graphicData><c:chart/></a:graphicData></a:graphic></p:graphicFrame>' + sp(["t"]);
    expect(text({ slides: [{ shapes }] })).toBe("# 1\nt");
  });

  it("PPTM gives the same text as PPTX", () => {
    const slides = [{ shapes: sp(["a"]), notes: sp(["n"], "body") }];
    expect(text({ slides, macro: true })).toBe(text({ slides }));
    expect(run({ slides, macro: true })).toMatchObject({ ok: true, format: "pptx" });
  });

  it("damaged: a slide listed but missing, an unknown relationship id, broken slide XML", () => {
    const ct = '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>';
    const pkg = (slide: string | undefined, rid = "rId1") => makeZip([
      { name: "[Content_Types].xml", data: ct },
      { name: "_rels/.rels", data: '<Relationships><Relationship Id="1" Type="x/officeDocument" Target="ppt/presentation.xml"/></Relationships>' },
      { name: "ppt/presentation.xml", data: `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="${rid}"/></p:sldIdLst></p:presentation>` },
      { name: "ppt/_rels/presentation.xml.rels", data: '<Relationships><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/></Relationships>' },
      ...(slide === undefined ? [] : [{ name: "ppt/slides/slide1.xml", data: slide }]),
    ]);
    expect(extractDocument(pkg(undefined), DOC_LIMITS)).toEqual({ ok: false, code: "damaged" });
    expect(extractDocument(pkg("<p:sld/>", "rId7"), DOC_LIMITS)).toEqual({ ok: false, code: "damaged" });
    expect(extractDocument(pkg("<p:sld>"), DOC_LIMITS)).toEqual({ ok: false, code: "damaged" });
    expect(extractDocument(pkg("<p:sld/>"), DOC_LIMITS)).toEqual({ ok: false, code: "no_text" });
  });
});

describe("PPTX whitespace", () => {
  it("a presentation whose only text is whitespace is no_text, also in notes", () => {
    expect(run({ slides: [{ shapes: sp(["   "]) }] })).toEqual({ ok: false, code: "no_text" });
    expect(run({ slides: [{ shapes: "", notes: sp(["  "], "body") }] })).toEqual({ ok: false, code: "no_text" });
  });
});
