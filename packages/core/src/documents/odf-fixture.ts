import { makeZip, type ZipPart } from "./fixture.ts";

// Text and attribute values: every XML special character, quotes included.
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export const odtP = (text: string): string => `<text:p>${esc(text)}</text:p>`;
export const odtH = (text: string): string => `<text:h text:outline-level="1">${esc(text)}</text:h>`;
export const odtTable = (rows: string[][]): string =>
  `<table:table table:name="T"><table:table-column/>${rows.map((r) => `<table:table-row>${r.map((c) => `<table:table-cell>${odtP(c)}</table:table-cell>`).join("")}</table:table-row>`).join("")}</table:table>`;
export const odsCell = (text: string): string => text === "" ? "<table:table-cell/>" : `<table:table-cell office:value-type="string">${odtP(text)}</table:table-cell>`;
export const odsTable = (name: string, rows: string[][]): string =>
  `<table:table table:name="${esc(name)}">${rows.map((r) => `<table:table-row>${r.map(odsCell).join("")}</table:table-row>`).join("")}</table:table>`;
const box = (texts: string[]): string => `<draw:frame><draw:text-box>${texts.map(odtP).join("")}</draw:text-box></draw:frame>`;
// The notes carry a thumbnail with a text:p inside to prove it is skipped.
export const odpPage = (texts: string[], notes?: string): string =>
  `<draw:page draw:name="page">${box(texts)}${notes === undefined ? "" : `<presentation:notes><draw:page-thumbnail><text:p>THUMB</text:p></draw:page-thumbnail>${box([notes])}</presentation:notes>`}</draw:page>`;

const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"';
const xml = (s: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n${s}`;

export interface OdfSpec {
  kind: "text" | "spreadsheet" | "presentation" | string; // a known kind, a suffix of the OpenDocument media type, or a raw media type
  body: string; manifest?: string | false; encrypted?: boolean; mimetypeFirst?: boolean; extraParts?: ZipPart[];
}

export function makeOdf(spec: OdfSpec): Uint8Array {
  const mime = spec.kind.includes("/") ? spec.kind : `application/vnd.oasis.opendocument.${spec.kind}`;
  const wrapper = spec.kind.includes("spreadsheet") ? "office:spreadsheet" : spec.kind.includes("presentation") ? "office:presentation" : "office:text";
  const entry = (path: string, inner = ""): string => inner === "" ? `<manifest:file-entry manifest:full-path="${path}" manifest:media-type=""/>` : `<manifest:file-entry manifest:full-path="${path}" manifest:media-type="text/xml">${inner}</manifest:file-entry>`;
  const manifest = spec.manifest ?? `<manifest:manifest ${NS}>${entry("/")}${entry("content.xml", spec.encrypted ? '<manifest:encryption-data manifest:checksum-type="SHA1"/>' : "")}</manifest:manifest>`;
  const parts: ZipPart[] = [
    { name: "mimetype", data: mime, method: 0 },
    ...(manifest === false ? [] : [{ name: "META-INF/manifest.xml", data: xml(manifest) }]),
    spec.encrypted
      ? { name: "content.xml", data: Uint8Array.from([0xff, 0xfe, 0x80, 0x81, 0xc3, 0x28, 0xa0, 0xa1]), method: 0 }
      : { name: "content.xml", data: xml(`<office:document-content ${NS}><office:body><${wrapper}>${spec.body}</${wrapper}></office:body></office:document-content>`) },
    ...(spec.extraParts ?? []),
  ];
  if (spec.mimetypeFirst === false) parts.push(parts.shift()!);
  return makeZip(parts);
}
