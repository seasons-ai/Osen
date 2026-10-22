import { posix } from "node:path";
import { cleanText, kids, relationships, resolve, xmlPart } from "./docx.ts";
import { DocError, type DocLimits } from "./limits.ts";
import { decodeXml, parseXml, type XmlElement } from "./xml.ts";
import type { Zip } from "./zip.ts";

export const XLSX_TYPES = ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", "application/vnd.ms-excel.sheet.macroEnabled.main+xml"];

const MAX_COLUMN = 16384;
// SpreadsheetML is usually unprefixed but may carry a prefix: names are compared without it.
const local = (name: string): string => name.slice(name.indexOf(":") + 1);
const named = (el: XmlElement, name: string): XmlElement[] => kids(el).filter((c) => local(c.name) === name);
const own = (el: XmlElement): string => el.children.filter((c): c is string => typeof c === "string").join("");
const flat = (s: string): string => s.replace(/\r\n|[\t\n\r]/g, " ");

// Text of a shared or inline string: the t under the item and under its runs; phonetic hints (rPh) are not read.
const itemText = (si: XmlElement): string => kids(si).map((c) => {
  const n = local(c.name);
  return n === "t" ? own(c) : n === "r" ? named(c, "t").map(own).join("") : "";
}).join("");

// "C5" -> 3; undefined when the reference has no letters.
function column(ref: string): number | undefined {
  const m = /^([A-Za-z]+)/.exec(ref);
  if (!m) return undefined;
  let n = 0;
  for (const ch of m[1]!.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  if (n > MAX_COLUMN) throw new DocError("damaged");
  return n;
}

function sharedStrings(zip: Zip, name: string): string[] {
  const out: string[] = [];
  parseXml(decodeXml(zip.read(name)), (el) => {
    if (local(el.name) !== "si") return false;
    out.push(itemText(el));
    return true;
  });
  return out;
}

function cellValue(c: XmlElement, shared: string[]): string {
  const t = c.attrs.t ?? "n";
  if (t === "inlineStr") { const is = named(c, "is")[0]; return is ? itemText(is) : ""; }
  const v = named(c, "v")[0];
  if (!v) return "";
  const raw = own(v);
  if (t === "s") {
    const s = shared[Number(raw)];
    if (!/^\d+$/.test(raw) || s === undefined) throw new DocError("damaged");
    return s;
  }
  if (t === "b") return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
  return raw;
}

export function xlsxText(zip: Zip, limits: Pick<DocLimits, "cells" | "chars">): string {
  let main = "xl/workbook.xml";
  const root = relationships(zip, "_rels/.rels").find((r) => r.type.endsWith("/officeDocument"));
  if (root) main = resolve("x", root.target);
  if (!zip.entries.has(main)) throw new DocError("damaged");
  const rels = relationships(zip, posix.join(posix.dirname(main), "_rels", `${posix.basename(main)}.rels`));
  const sst = rels.find((r) => r.type.endsWith("/sharedStrings"));
  const shared = sst ? sharedStrings(zip, resolve(main, sst.target)) : [];
  const book = xmlPart(zip, main);
  const sheets = named(book, "sheets").flatMap((s) => named(s, "sheet"));
  let count = 0;
  // Length of the text as it will be joined, kept running so a book that fans out (cells at XFD, one string used many times) stops early.
  let total = 0, anyText = false;
  const out: string[] = [];
  for (const sheet of sheets) {
    const rid = Object.entries(sheet.attrs).find(([k]) => local(k) === "id")?.[1];
    const rel = rels.find((r) => r.id === rid);
    if (!rel) throw new DocError("damaged");
    if (!rel.type.endsWith("/worksheet")) continue;
    const part = resolve(main, rel.target);
    if (!zip.entries.has(part)) throw new DocError("damaged");
    const lines = [`# ${flat(sheet.attrs.name ?? "")}`];
    total += (out.length > 0 ? 2 : 0) + lines[0]!.length;
    if (total > limits.chars) throw new DocError("chars");
    // Rows are handled as they close and dropped from the tree, so memory stays bounded by one row.
    parseXml(decodeXml(zip.read(part)), (el) => {
      if (local(el.name) !== "row") return false;
      const values: string[] = [];
      let last = -1, prev = 0, width = 0;
      for (const c of named(el, "c")) {
        const col = (c.attrs.r === undefined ? undefined : column(c.attrs.r)) ?? prev + 1;
        if (col > MAX_COLUMN) throw new DocError("damaged");
        prev = col;
        const value = cellValue(c, shared);
        if (value === "") continue;
        if (++count > limits.cells) throw new DocError("cells");
        const cleaned = flat(value);
        if (/\S/.test(cleaned)) anyText = true;
        values[col - 1] = cleaned;
        last = Math.max(last, col - 1);
        width += cleaned.length;
        if (total + 1 + width + last > limits.chars) throw new DocError("chars");
      }
      if (last >= 0) total += 1 + width + last;
      if (last >= 0) lines.push(Array.from({ length: last + 1 }, (_, i) => values[i] ?? "").join("\t"));
      return true;
    });
    out.push(lines.join("\n"));
  }
  return count === 0 || !anyText ? "" : cleanText(out.join("\n\n"));
}
