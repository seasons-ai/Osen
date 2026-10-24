import { posix } from "node:path";
import { DocError } from "./limits.ts";
import { decodeXml, parseXml, type XmlElement } from "./xml.ts";
import type { Zip } from "./zip.ts";

export const DOCX_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "application/vnd.ms-word.document.macroEnabled.main+xml",
  // DOTX and DOTM: templates are read as their main format (change 222)
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml", "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
];

export const kids = (el: XmlElement): XmlElement[] => el.children.filter((c): c is XmlElement => typeof c !== "string");
export const xmlPart = (zip: Zip, name: string): XmlElement => parseXml(decodeXml(zip.read(name)));

// ponytail: the prefixes w: and mc: are taken literally (Word always writes them); resolving namespaces is not needed yet.
export function relationships(zip: Zip, name: string): { id: string; type: string; target: string }[] {
  if (!zip.entries.has(name)) return [];
  return kids(xmlPart(zip, name)).filter((e) => e.name === "Relationship")
    .map((e) => ({ id: e.attrs.Id ?? "", type: e.attrs.Type ?? "", target: e.attrs.Target ?? "" }));
}

export function resolve(base: string, target: string): string {
  return target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(posix.dirname(base), target));
}

// Final cleanup shared by every document builder: control characters out, lone surrogates replaced.
export function cleanText(text: string): string {
  return (text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") as string & { toWellFormed(): string }).toWellFormed();
}

const choice = (el: XmlElement): XmlElement | undefined => kids(el).find((c) => c.name === "mc:Choice");

// Rows or cells of a table, looking through content controls and customXml wrappers.
function parts(el: XmlElement, name: string): XmlElement[] {
  return kids(el).flatMap((c) => c.name === name ? [c] : ["w:sdt", "w:sdtContent", "w:customXml"].includes(c.name) ? parts(c, name) : []);
}

// Block level: lines of text in document order.
function block(el: XmlElement, out: string[]): void {
  for (const c of kids(el)) {
    switch (c.name) {
      case "w:p": paragraph(c, out); break;
      case "w:tbl":
        for (const tr of parts(c, "w:tr")) {
          if (kids(tr).some((e) => e.name === "w:trPr" && kids(e).some((d) => d.name === "w:del"))) continue;
          out.push(parts(tr, "w:tc").filter((tc) => !kids(tc).some((e) => e.name === "w:tcPr" && kids(e).some((d) => d.name === "w:cellDel"))).map((tc) => {
            const lines: string[] = [];
            block(tc, lines);
            return lines.join(" ").replace(/[\t\n]/g, " ");
          }).join("\t"));
        }
        break;
      case "mc:AlternateContent": { const ch = choice(c); if (ch) block(ch, out); break; }
      case "w:del": case "w:moveFrom": case "w:drawing": case "w:pict": case "w:object": case "mc:Fallback": case "w:pPr": case "w:rPr": break;
      default: block(c, out);
    }
  }
}

function paragraph(p: XmlElement, out: string[]): void {
  let text = "";
  const boxes: string[] = [];
  const inline = (el: XmlElement): void => {
    for (const c of kids(el)) {
      switch (c.name) {
        case "w:t": text += c.children.filter((x): x is string => typeof x === "string").join(""); break;
        case "w:tab": text += "\t"; break;
        case "w:br": case "w:cr": text += "\n"; break;
        case "w:noBreakHyphen": text += "-"; break;
        case "mc:AlternateContent": { const ch = choice(c); if (ch) inline(ch); break; }
        case "w:drawing": case "w:pict": textBoxes(c); break;
        case "w:object": case "w:del": case "w:moveFrom": case "w:delText": case "mc:Fallback": case "w:pPr": case "w:rPr": break;
        default: inline(c);
      }
    }
  };
  const textBoxes = (el: XmlElement): void => {
    for (const c of kids(el)) { if (c.name === "w:txbxContent") block(c, boxes); else if (c.name !== "mc:Fallback") textBoxes(c); }
  };
  inline(p);
  out.push(text, ...boxes);
}

function notes(zip: Zip, name: string, tag: string): string[] {
  if (!zip.entries.has(name)) return [];
  return kids(xmlPart(zip, name)).filter((n) => n.name === tag && !["separator", "continuationSeparator", "continuationNotice"].includes(n.attrs["w:type"] ?? ""))
    .map((n) => { const lines: string[] = []; block(n, lines); return lines.join("\n"); });
}

export function docxText(zip: Zip): string {
  let main = "word/document.xml";
  const root = relationships(zip, "_rels/.rels").find((r) => r.type.endsWith("/officeDocument"));
  if (root) main = resolve("x", root.target);
  if (!zip.entries.has(main)) throw new DocError("damaged");
  const doc = xmlPart(zip, main);
  const body = kids(doc).find((e) => e.name === "w:body") ?? doc;
  const lines: string[] = [];
  block(body, lines);
  let text = lines.join("\n");
  const rels = relationships(zip, posix.join(posix.dirname(main), "_rels", `${posix.basename(main)}.rels`));
  const target = (suffix: string): string | undefined => {
    const r = rels.find((x) => x.type.endsWith(`/${suffix}`));
    return r && resolve(main, r.target);
  };
  const fn = target("footnotes"), en = target("endnotes");
  const all = [...(fn ? notes(zip, fn, "w:footnote") : []), ...(en ? notes(zip, en, "w:endnote") : [])];
  const tail = all.join("\n");
  if (tail !== "") text += `\n\n${tail}`;
  return cleanText(text);
}
