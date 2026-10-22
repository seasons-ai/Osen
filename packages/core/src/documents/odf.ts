import { DocError } from "./limits.ts";
import type { DocFormat } from "./detect.ts";
import { decodeXml, parseXml, type XmlElement } from "./xml.ts";
import type { Zip } from "./zip.ts";

const BASE = "application/vnd.oasis.opendocument.";
const kids = (el: XmlElement): XmlElement[] => el.children.filter((c): c is XmlElement => typeof c !== "string");
const xmlPart = (zip: Zip, name: string): XmlElement => parseXml(decodeXml(zip.read(name)));

// Counts only what a repeat attribute or text:s multiplies; plain text is bounded by the unpacked size limit.
interface Ctx { used: number; chars: number; notes: string[] }
function charge(ctx: Ctx, n: number): void {
  ctx.used += n;
  if (ctx.used > ctx.chars) throw new DocError("chars");
}
// Attribute count of a repeat: a missing or invalid value means 1.
const count = (v: string | undefined): number => {
  const n = v !== undefined && /^\d+$/.test(v) ? Number(v) : 1;
  return n < 1 ? 1 : n;
};

// ponytail: the prefixes office:, text:, table:, draw: are taken literally (LibreOffice and Word always write them); resolving namespaces is not needed yet.
const SKIP = new Set(["text:tracked-changes", "office:forms", "text:sequence-decls", "table:named-expressions", "office:annotation", "office:annotation-end",
  "draw:image", "draw:object", "draw:object-ole", "svg:title", "svg:desc", "draw:page-thumbnail", "presentation:notes", "text:note-citation"]);
const ROW_GROUPS = new Set(["table:table-header-rows", "table:table-rows", "table:table-row-group"]);

function block(el: XmlElement, out: string[], ctx: Ctx): void {
  for (const c of kids(el)) {
    if (SKIP.has(c.name)) continue;
    if (c.name === "text:p" || c.name === "text:h") paragraph(c, out, ctx);
    else if (c.name === "table:table") table(c, out, ctx);
    else block(c, out, ctx);
  }
}

function paragraph(p: XmlElement, out: string[], ctx: Ctx): void {
  let text = "";
  const boxes: string[] = [];
  const inline = (el: XmlElement): void => {
    for (const c of el.children) {
      if (typeof c === "string") { text += c.replace(/[ \t\r\n]+/g, " "); continue; }
      if (c.name === "text:s") { const n = count(c.attrs["text:c"]); charge(ctx, n); text += " ".repeat(n); }
      else if (c.name === "text:tab") text += "\t";
      else if (c.name === "text:line-break") text += "\n";
      else if (c.name === "text:note") {
        const body = kids(c).find((x) => x.name === "text:note-body");
        if (body) { const lines: string[] = []; block(body, lines, ctx); if (lines.length) ctx.notes.push(lines.join("\n")); }
      } else if (c.name === "draw:frame") {
        for (const x of kids(c)) if (x.name === "draw:text-box") block(x, boxes, ctx);
      } else if (!SKIP.has(c.name)) inline(c);
    }
  };
  inline(p);
  out.push(text, ...boxes);
}

function table(t: XmlElement, out: string[], ctx: Ctx): void {
  const rows = (el: XmlElement): void => {
    for (const c of kids(el)) {
      if (c.name === "table:table-row") row(c);
      else if (ROW_GROUPS.has(c.name)) rows(c);
    }
  };
  const row = (tr: XmlElement): void => {
    let line = "", started = false, gap = 0;
    for (const tc of kids(tr)) {
      if (tc.name !== "table:table-cell" && tc.name !== "table:covered-table-cell") continue;
      const lines: string[] = [];
      block(tc, lines, ctx);
      const text = lines.join(" ").replace(/[\t\n]/g, " ");
      const n = count(tc.attrs["table:number-columns-repeated"]);
      if (!/\S/.test(text)) { gap += n; continue; }
      charge(ctx, gap + (n - 1) * (text.length + 1));
      line += "\t".repeat(started ? gap + 1 : gap) + (text + "\t").repeat(n - 1) + text;
      started = true;
      gap = 0;
    }
    if (!started) return;
    const n = count(tr.attrs["table:number-rows-repeated"]);
    charge(ctx, (n - 1) * (line.length + 1));
    for (let i = 0; i < n; i++) out.push(line);
  };
  rows(t);
}

function body(zip: Zip, tag: string): XmlElement {
  if (!zip.entries.has("content.xml")) throw new DocError("damaged");
  const root = xmlPart(zip, "content.xml");
  const found = root.name === "office:document-content" ? kids(root).find((e) => e.name === "office:body") : undefined;
  const main = found && kids(found).find((e) => e.name === tag);
  if (!main) throw new DocError("damaged");
  return main;
}

function finish(text: string): string {
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return (text as string & { toWellFormed(): string }).toWellFormed();
}

function odtText(zip: Zip, chars: number): string {
  const ctx: Ctx = { used: 0, chars, notes: [] };
  const lines: string[] = [];
  block(body(zip, "office:text"), lines, ctx);
  let text = lines.join("\n");
  if (ctx.notes.length) text += `\n\n${ctx.notes.join("\n")}`;
  return finish(text);
}

function odsText(zip: Zip, chars: number): string {
  const ctx: Ctx = { used: 0, chars, notes: [] };
  let any = false;
  const sections = kids(body(zip, "office:spreadsheet")).filter((t) => t.name === "table:table").map((t) => {
    const rows: string[] = [];
    table(t, rows, ctx);
    if (rows.length) any = true;
    return rows.length ? `# ${t.attrs["table:name"] ?? ""}\n${rows.join("\n")}` : `# ${t.attrs["table:name"] ?? ""}`;
  });
  return any ? finish(sections.join("\n\n")) : "";
}

function odpText(zip: Zip, chars: number): string {
  const ctx: Ctx = { used: 0, chars, notes: [] };
  let any = false;
  const pages = kids(body(zip, "office:presentation")).filter((d) => d.name === "draw:page").map((page, i) => {
    const lines: string[] = [];
    block(page, lines, ctx);
    const nl: string[] = [];
    for (const n of kids(page)) if (n.name === "presentation:notes") block(n, nl, ctx);
    const text = lines.join("\n"), notes = nl.join("\n");
    if (/\S/.test(text) || /\S/.test(notes)) any = true;
    return `# ${i + 1}${text !== "" ? `\n${text}` : ""}${/\S/.test(notes) ? `\n\n${notes}` : ""}`;
  });
  return any ? finish(pages.join("\n\n")) : "";
}

// Any encryption-data element in the manifest means the content is encrypted and content.xml is not readable.
function hasEncryption(el: XmlElement): boolean {
  return el.name === "manifest:encryption-data" || kids(el).some(hasEncryption);
}
function checkEncryption(zip: Zip): void {
  if (zip.entries.has("META-INF/manifest.xml") && hasEncryption(xmlPart(zip, "META-INF/manifest.xml"))) throw new DocError("encrypted");
}

const typeOf = (zip: Zip): string => Buffer.from(zip.read("mimetype")).toString("latin1").trim();
const OTHER = new RegExp(`^${BASE.replace(/\./g, "\\.")}(graphics|formula|chart|database|image|text-master|text-web)(-template)?$`);
const is = (kind: string) => (t: string): boolean => t === BASE + kind || t === `${BASE}${kind}-template`;

export const ODF_FORMATS: DocFormat[] = [
  { id: "odt", test: is("text"), check: checkEncryption, build: (zip, l) => odtText(zip, l.chars) },
  { id: "ods", test: is("spreadsheet"), check: checkEncryption, build: (zip, l) => odsText(zip, l.chars) },
  { id: "odp", test: is("presentation"), check: checkEncryption, build: (zip, l) => odpText(zip, l.chars) },
  { id: "odf-other", test: (t) => OTHER.test(t), build: (zip) => { throw new DocError("odf_kind", OTHER.exec(typeOf(zip))?.[1]); } },
];
