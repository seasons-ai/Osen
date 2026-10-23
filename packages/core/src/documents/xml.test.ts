import { describe, expect, it } from "vitest";
import { type DocFailure } from "./limits.ts";
import { decodeXml, parseXml } from "./xml.ts";

const code = (fn: () => unknown): DocFailure | undefined => {
  try { fn(); } catch (e) { return (e as { code?: DocFailure }).code; }
  return undefined;
};

describe("XML parser", () => {
  it("only the five predefined entities: Object prototype names are unknown entities", () => {
    for (const name of ["toString", "valueOf", "__proto__", "constructor"]) expect(code(() => parseXml(`<a>&${name};</a>`))).toBe("damaged");
  });

  it("parses attributes, entities, numeric references, CDATA, comments and processing instructions", () => {
    const root = parseXml(`<?xml version="1.0"?>\n<!-- c --><w:a x="1 &amp; 2" y='&#x41;&#66;'><w:b/>t&lt;&gt;&quot;&apos;<![CDATA[<raw>&]]><?pi x?></w:a>\n`);
    expect(root.name).toBe("w:a");
    expect(root.attrs).toEqual({ x: "1 & 2", y: "AB" });
    expect(root.children).toEqual([{ name: "w:b", attrs: {}, children: [] }, `t<>"'<raw>&`]);
  });

  it("strips a BOM and rejects invalid UTF-8", () => {
    expect(parseXml(decodeXml(Buffer.from("\uFEFF<a>я</a>"))).children).toEqual(["я"]);
    expect(code(() => decodeXml(new Uint8Array([0x3c, 0xff, 0xfe])))).toBe("damaged");
  });

  it("refuses a DOCTYPE with an external entity, so nothing is fetched or read", () => {
    for (const sys of ["file:///etc/passwd", "http://127.0.0.1:1/x"]) {
      expect(code(() => parseXml(`<?xml version="1.0"?><!DOCTYPE a [<!ENTITY e SYSTEM "${sys}">]><a>&e;</a>`))).toBe("damaged");
    }
    expect(code(() => parseXml("<!DOCTYPE a><a/>"))).toBe("damaged");
    // "anywhere": even hidden in a comment or CDATA.
    expect(code(() => parseXml("<a><!-- <!DOCTYPE x> --></a>"))).toBe("damaged");
    expect(code(() => parseXml("<a><![CDATA[<!ENTITY e>]]></a>"))).toBe("damaged");
  });

  it("refuses unknown and malformed entities", () => {
    for (const bad of ["<a>&e;</a>", "<a>&#0;</a>", "<a>&#x110000;</a>", "<a>&#xD800;</a>", "<a>&amp</a>", '<a b="&nope;"/>']) {
      expect(code(() => parseXml(bad)), bad).toBe("damaged");
    }
  });

  it("refuses unclosed, mismatched and extra top-level content", () => {
    for (const bad of ["<a>", "<a><b></a></b>", "<a></b>", "<a/><b/>", "text<a/>", "<a/>text", "", "<a b></a>", "<a b=1/>", "<a"]) {
      expect(code(() => parseXml(bad)), bad).toBe("damaged");
    }
  });

  it("allows nesting 1000 deep and refuses 1001", () => {
    const deep = (n: number): string => "<a>".repeat(n) + "</a>".repeat(n);
    expect(code(() => parseXml(deep(1000)))).toBeUndefined();
    expect(code(() => parseXml(deep(1001)))).toBe("damaged");
  });

  it("finishes a 1 MiB pathological input fast", () => {
    for (const input of ["<a" + " b='".repeat(2 ** 18), "<a>" + "&".repeat(2 ** 20), "<" .repeat(2 ** 20), "<a " + "b='1' ".repeat(2 ** 17) + ">"]) {
      const t = Date.now();
      code(() => parseXml(input));
      expect(Date.now() - t).toBeLessThan(2000);
    }
  });
});

describe("onClose", () => {
  it("sees every closed element, self-closing ones too, and drops the ones it accepts", () => {
    const seen: string[] = [];
    const root = parseXml("<a>x<b>1</b>y<c/><d><b>2</b></d></a>", (el) => { seen.push(el.name); return el.name === "b" || el.name === "c"; });
    expect(seen).toEqual(["b", "c", "b", "d", "a"]);
    expect(root.children).toEqual(["xy", { name: "d", attrs: {}, children: [] }]);
  });

  it("without the callback the tree is unchanged", () => {
    expect(parseXml("<a><b/></a>").children).toHaveLength(1);
  });
});
