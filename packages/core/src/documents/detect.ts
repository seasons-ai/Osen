import { posix } from "node:path";
import { docxText, DOCX_TYPES } from "./docx.ts";
import { CFB_SIGNATURE, cfbStreams } from "./cfb.ts";
import { DocError, type DocFailure, type DocLimits } from "./limits.ts";
import { decodeXml, parseXml, type XmlElement } from "./xml.ts";
import { checkZip, openZip, type Zip } from "./zip.ts";

// One entry per format: add a record here and a builder file next to it.
export interface DocFormat { id: string; test(mainType: string): boolean; build(zip: Zip): string }
export const FORMATS: DocFormat[] = [{ id: "docx", test: (t) => DOCX_TYPES.includes(t), build: docxText }];

export type DocResult = { ok: true; text: string; format: string } | { ok: false; code: DocFailure };

// "<!DOCTYPE" and "<!ENTITY" as UTF-8, UTF-16LE and UTF-16BE bytes: XML parts may be written in either encoding.
const DECLARATIONS = ["<!DOCTYPE", "<!ENTITY"].flatMap((d) => [Buffer.from(d), Buffer.from(d, "utf16le"), Buffer.from(d, "utf16le").swap16()]);

const elements = (el: XmlElement): XmlElement[] => el.children.filter((c): c is XmlElement => typeof c !== "string");

// Content type of the main part, or undefined when the package does not say.
function mainType(zip: Zip): string | undefined {
  if (!zip.entries.has("[Content_Types].xml")) return undefined;
  const types = elements(parseXml(decodeXml(zip.read("[Content_Types].xml"))));
  let main = "/word/document.xml";
  if (zip.entries.has("_rels/.rels")) {
    const rel = elements(parseXml(decodeXml(zip.read("_rels/.rels"))))
      .find((e) => e.name === "Relationship" && (e.attrs.Type ?? "").endsWith("/officeDocument"));
    if (rel?.attrs.Target) main = rel.attrs.Target.startsWith("/") ? rel.attrs.Target : posix.join("/", rel.attrs.Target);
  }
  return types.find((e) => e.name === "Override" && e.attrs.PartName === main)?.attrs.ContentType;
}

export function extractDocument(bytes: Uint8Array, limits: Pick<DocLimits, "chars" | "parts" | "unpackedBytes" | "ratio">): DocResult {
  try {
    const zip = openZip(bytes, limits);
    // A ZIP with [Content_Types].xml is an OPC package (every OOXML format): from here on its trouble is a damaged document.
    const type = mainType(zip);
    const format = type === undefined ? undefined : FORMATS.find((f) => f.test(type));
    if (!format) throw new DocError("unsupported");
    checkZip(zip, limits);
    // A DTD or an entity declaration in any XML part makes the document damaged, even in parts the builder never parses.
    // Pictures (an SVG carries its own DOCTYPE) are not XML parts of the document and are not checked.
    for (const name of zip.entries.keys()) {
      if (!/\.(xml|rels|vml)$/i.test(name)) continue;
      const raw = Buffer.from(zip.read(name));
      if (DECLARATIONS.some((d) => raw.includes(d))) throw new DocError("damaged");
    }
    const text = format.build(zip);
    if (text.length > limits.chars) throw new DocError("chars");
    if (!/\S/.test(text)) throw new DocError("no_text");
    return { ok: true, text, format: format.id };
  } catch (e) {
    return { ok: false, code: e instanceof DocError ? e.code : "damaged" };
  }
}

// CFB files: the first stream name found decides the kind, in this order. Change 216 appends Workbook/Book and PowerPoint Document here.
export const CFB_KINDS: { stream: string; kind: "encrypted" | "doc" }[] = [{ stream: "EncryptedPackage", kind: "encrypted" }, { stream: "WordDocument", kind: "doc" }];

/** The kind of a file handled by a system tool: "rtf", "doc", or undefined when the bytes are neither RTF nor CFB (the ZIP path goes on). Throws DocError. */
export function systemKind(bytes: Uint8Array): "rtf" | "doc" | undefined {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 8));
  const at = head.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  if (head.subarray(at, at + 5).toString("latin1") === "{\\rtf") return "rtf";
  if (!head.equals(CFB_SIGNATURE)) return undefined;
  const streams = cfbStreams(bytes);
  const found = CFB_KINDS.find((k) => streams.includes(k.stream));
  if (!found) throw new DocError("unsupported");
  if (found.kind === "encrypted") throw new DocError("encrypted");
  return found.kind;
}
