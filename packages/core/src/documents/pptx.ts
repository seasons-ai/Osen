import { posix } from "node:path";
import { cleanText, kids, relationships, resolve, xmlPart } from "./docx.ts";
import { DocError } from "./limits.ts";
import type { XmlElement } from "./xml.ts";
import type { Zip } from "./zip.ts";

export const PPTX_TYPES = [
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
  // POTX, POTM, PPSX and PPSM: templates and slideshows are read as a presentation (change 222)
  "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml", "application/vnd.ms-powerpoint.template.macroEnabled.main+xml",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml", "application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml",
];

// ponytail: the prefixes p:, a:, mc: and r: are taken literally (PowerPoint always writes them), as docx.ts does for w:.
const EXCLUDED = ["ftr", "dt", "sldNum"];
const child = (el: XmlElement, name: string): XmlElement | undefined => kids(el).find((c) => c.name === name);
const own = (el: XmlElement): string => el.children.filter((c): c is string => typeof c === "string").join("");

// One line of text per paragraph; a:br is a line break inside it.
function paragraphs(txBody: XmlElement | undefined): string[] {
  if (!txBody) return [];
  return kids(txBody).filter((p) => p.name === "a:p").map((p) => kids(p).map((c) =>
    c.name === "a:br" ? "\n" : c.name === "a:r" || c.name === "a:fld" ? kids(c).filter((t) => t.name === "a:t").map(own).join("") : "").join(""));
}

function tables(el: XmlElement, out: string[]): void {
  for (const c of kids(el)) {
    if (c.name !== "a:tbl") { tables(c, out); continue; }
    for (const tr of kids(c).filter((r) => r.name === "a:tr")) {
      const line = kids(tr).filter((tc) => tc.name === "a:tc")
        .map((tc) => paragraphs(child(tc, "a:txBody")).filter((t) => t !== "").join(" ").replace(/[\t\n]/g, " ")).join("\t");
      if (line !== "") out.push(line);
    }
  }
}

// Shapes in tree order. onlyBody is for notes pages: only the body placeholder is the speaker's text.
function shapes(container: XmlElement, onlyBody: boolean, out: string[]): void {
  for (const c of kids(container)) {
    switch (c.name) {
      case "p:sp": {
        const type = child(child(child(c, "p:nvSpPr") ?? c, "p:nvPr") ?? c, "p:ph")?.attrs.type;
        if (onlyBody ? type !== "body" : type !== undefined && EXCLUDED.includes(type)) break;
        out.push(...paragraphs(child(c, "p:txBody")).filter((t) => t !== ""));
        break;
      }
      case "p:grpSp": shapes(c, onlyBody, out); break;
      case "p:graphicFrame": if (!onlyBody) tables(c, out); break;
      case "mc:AlternateContent": { const ch = child(c, "mc:Choice"); if (ch) shapes(ch, onlyBody, out); break; }
    }
  }
}

function slideLines(zip: Zip, part: string, onlyBody: boolean): string[] {
  if (!zip.entries.has(part)) throw new DocError("damaged");
  const tree = child(child(xmlPart(zip, part), "p:cSld") ?? { name: "", attrs: {}, children: [] }, "p:spTree");
  const out: string[] = [];
  if (tree) shapes(tree, onlyBody, out);
  return out;
}

export function pptxText(zip: Zip): string {
  let main = "ppt/presentation.xml";
  const root = relationships(zip, "_rels/.rels").find((r) => r.type.endsWith("/officeDocument"));
  if (root) main = resolve("x", root.target);
  if (!zip.entries.has(main)) throw new DocError("damaged");
  const relsOf = (part: string) => relationships(zip, posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`));
  const rels = relsOf(main);
  const ids = child(xmlPart(zip, main), "p:sldIdLst");
  const slides: string[] = [];
  let any = false;
  for (const [i, sld] of (ids ? kids(ids).filter((s) => s.name === "p:sldId") : []).entries()) {
    const rel = rels.find((r) => r.id === sld.attrs["r:id"]);
    if (!rel) throw new DocError("damaged");
    const part = resolve(main, rel.target);
    const lines = [`# ${i + 1}`];
    const body = slideLines(zip, part, false);
    lines.push(...body);
    const notesRel = relsOf(part).find((r) => r.type.endsWith("/notesSlide"));
    const notes = notesRel ? slideLines(zip, resolve(part, notesRel.target), true) : [];
    if (notes.length > 0) lines.push("", ...notes);
    if ([...body, ...notes].some((l) => /\S/.test(l))) any = true;
    slides.push(lines.join("\n"));
  }
  return any ? cleanText(slides.join("\n\n")) : "";
}
