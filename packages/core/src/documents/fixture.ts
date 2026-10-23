import { crc32, deflateRawSync } from "node:zlib";

/** name as raw bytes and utf8Flag (general purpose bit 11) let tests build names a real archiver would write; any other method number stores the body as given */
export interface ZipPart { name: string | Uint8Array; utf8Flag?: boolean; data: Uint8Array | string; method?: number; declaredSize?: number; encrypted?: boolean; unixMode?: number }

export function makeZip(parts: ZipPart[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const raw = typeof part.data === "string" ? Buffer.from(part.data, "utf8") : Buffer.from(part.data);
    const method = part.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = typeof part.name === "string" ? Buffer.from(part.name, "utf8") : Buffer.from(part.name);
    const size = part.declaredSize ?? raw.length;
    const flags = (part.encrypted ? 1 : 0) | (part.utf8Flag ? 0x800 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE(part.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    rec.writeUInt16LE(20, 6);
    rec.writeUInt16LE(flags, 8);
    rec.writeUInt16LE(method, 10);
    rec.writeUInt32LE(crc32(raw), 16);
    rec.writeUInt32LE(body.length, 20);
    rec.writeUInt32LE(size, 24);
    rec.writeUInt16LE(name.length, 28);
    if (part.unixMode !== undefined) rec.writeUInt32LE((part.unixMode << 16) >>> 0, 38);
    rec.writeUInt32LE(offset, 42);
    central.push(rec, name);
    chunks.push(local, name, body);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, end]);
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const p = (text: string): string => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
export function table(rows: string[][]): string {
  return `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${p(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
}

export interface DocxSpec { body: string; footnotes?: string; endnotes?: string; macro?: boolean; header?: string; comments?: string; extraParts?: ZipPart[] }

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WML = "application/vnd.openxmlformats-officedocument.wordprocessingml";
const xml = (s: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`;
const sep = (tag: string, type: string, id: number): string => `<w:${tag} w:type="${type}" w:id="${id}"><w:p><w:r><w:separator/></w:r></w:p></w:${tag}>`;

export function makeDocx(spec: DocxSpec): Uint8Array {
  const rels: string[] = [];
  const overrides: string[] = [];
  const parts: ZipPart[] = [];
  const add = (id: string, type: string, file: string, ct: string, content: string): void => {
    rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${file}"/>`);
    overrides.push(`<Override PartName="/word/${file}" ContentType="${WML}.${ct}+xml"/>`);
    parts.push({ name: `word/${file}`, data: xml(content) });
  };
  if (spec.footnotes !== undefined) {
    add("rId1", "footnotes", "footnotes.xml", "footnotes",
      `<w:footnotes ${W}>${sep("footnote", "separator", -1)}${sep("footnote", "continuationSeparator", 0)}${spec.footnotes}</w:footnotes>`);
  }
  if (spec.endnotes !== undefined) {
    add("rId2", "endnotes", "endnotes.xml", "endnotes",
      `<w:endnotes ${W}>${sep("endnote", "separator", -1)}${sep("endnote", "continuationSeparator", 0)}${spec.endnotes}</w:endnotes>`);
  }
  if (spec.header !== undefined) add("rId3", "header", "header1.xml", "header", `<w:hdr ${W}>${spec.header}</w:hdr>`);
  if (spec.comments !== undefined) add("rId4", "comments", "comments.xml", "comments", `<w:comments ${W}>${spec.comments}</w:comments>`);
  const mainType = spec.macro ? "application/vnd.ms-word.document.macroEnabled.main+xml" : `${WML}.document.main+xml`;
  return makeZip([
    {
      name: "[Content_Types].xml",
      data: xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mainType}"/>${overrides.join("")}</Types>`),
    },
    {
      name: "_rels/.rels",
      data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`),
    },
    {
      name: "word/_rels/document.xml.rels",
      data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`),
    },
    { name: "word/document.xml", data: xml(`<w:document ${W}><w:body>${spec.body}</w:body></w:document>`) },
    ...(spec.macro ? [{ name: "word/vbaProject.bin", data: "not a real macro" }] : []),
    ...parts,
    ...(spec.extraParts ?? []),
  ]);
}

// RTF text: \ { } escaped, non-ASCII as \uN? with signed 16-bit UTF-16 code units (a surrogate pair is two \uN)
export function makeRtf(paragraphs: string[]): string {
  const esc = (s: string): string => {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x5c || c === 0x7b || c === 0x7d) out += `\\${s[i]}`;
      else if (c === 0x0a) out += "\\line ";
      else if (c < 0x80) out += s[i];
      else out += `\\u${c > 32767 ? c - 65536 : c}?`;
    }
    return out;
  };
  return `{\\rtf1\\ansi\\deff0 ${paragraphs.map((t) => `${esc(t)}\\par\n`).join("")}}`;
}

export interface CfbSpec {
  /** Names of the empty streams under the root entry, in any order */
  streams: string[];
  /** The last directory sector points back at the first one */
  loop?: boolean;
  /** The last directory sector points outside the file */
  outside?: boolean;
  /** Sector shift in the header (9 when absent) */
  shift?: number;
}

// Minimal CFB writer: 512-byte sectors, FAT sectors first, then the directory chain; streams are empty.
export function makeCfb(spec: CfbSpec): Uint8Array {
  const entries = 1 + spec.streams.length;
  const nDir = Math.ceil(entries / 4);
  let nFat = 1;
  while (nFat * 128 < nFat + nDir) nFat++;
  if (nFat > 109) throw new Error("too many streams for the fixture");
  const out = Buffer.alloc(512 * (1 + nFat + nDir), 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(out);
  out.writeUInt16LE(0x3e, 0x18);
  out.writeUInt16LE(3, 0x1a);
  out.writeUInt16LE(0xfffe, 0x1c);
  out.writeUInt16LE(spec.shift ?? 9, 0x1e);
  out.writeUInt16LE(6, 0x20);
  out.writeUInt32LE(nFat, 0x2c);
  out.writeUInt32LE(nFat, 0x30);
  out.writeUInt32LE(0x1000, 0x38);
  out.writeUInt32LE(0xfffffffe, 0x3c);
  out.writeUInt32LE(0xfffffffe, 0x44);
  for (let i = 0; i < 109; i++) out.writeUInt32LE(i < nFat ? i : 0xffffffff, 0x4c + i * 4);
  const fat = new Array<number>(nFat * 128).fill(0xffffffff);
  for (let i = 0; i < nFat; i++) fat[i] = 0xfffffffd;
  for (let i = 0; i < nDir; i++) fat[nFat + i] = i === nDir - 1 ? (spec.loop ? nFat : spec.outside ? 99_999 : 0xfffffffe) : nFat + i + 1;
  fat.forEach((v, i) => out.writeUInt32LE(v, 512 + i * 4));
  const dir = 512 * (1 + nFat);
  const put = (id: number, name: string, type: number, left: number, right: number, child: number): void => {
    const e = dir + id * 128;
    out.write(name, e, "utf16le");
    out.writeUInt16LE(name === "" ? 0 : name.length * 2 + 2, e + 0x40);
    out[e + 0x42] = type;
    out.writeUInt32LE(left, e + 0x44);
    out.writeUInt32LE(right, e + 0x48);
    out.writeUInt32LE(child, e + 0x4c);
    out.writeUInt32LE(0xfffffffe, e + 0x74);
  };
  // balanced tree over the stream order; entries beyond the list stay unallocated (no-stream links)
  const build = (lo: number, hi: number): number => {
    if (lo >= hi) return 0xffffffff;
    const mid = (lo + hi) >> 1;
    put(mid + 1, spec.streams[mid]!, 2, build(lo, mid), build(mid + 1, hi), 0xffffffff);
    return mid + 1;
  };
  put(0, "Root Entry", 5, 0xffffffff, 0xffffffff, build(0, spec.streams.length));
  for (let id = entries; id < nDir * 4; id++) put(id, "", 0, 0xffffffff, 0xffffffff, 0xffffffff);
  return out;
}

// ---- XLSX ----

const attr = (s: string): string => esc(s).replace(/"/g, "&quot;");
const SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

// A string is a shared string; the objects pick another encoding.
export type XlsxCell =
  | null | string | number | boolean
  | { inline: string }
  | { f: string; v?: string | number | boolean; t?: "str" | "b" | "e" }
  | { error: string }
  | { raw: string };

export interface XlsxSheet { name: string; hidden?: boolean | "very"; rows?: XlsxCell[][]; noRefs?: boolean; sheetData?: string; chartsheet?: boolean }
export interface XlsxSpec { sheets: XlsxSheet[]; macro?: boolean; scramble?: boolean; sharedXml?: string; noSharedPart?: boolean; extraParts?: ZipPart[] }

export const colName = (col: number): string => {
  let s = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function makeXlsx(spec: XlsxSpec): Uint8Array {
  const shared: string[] = [];
  const cell = (c: XlsxCell, ref: string): string => {
    const r = ref === "" ? "" : ` r="${ref}"`;
    if (c === null) return "";
    if (typeof c === "string") { shared.push(c); return `<c${r} t="s"><v>${shared.length - 1}</v></c>`; }
    if (typeof c === "number") return `<c${r}><v>${c}</v></c>`;
    if (typeof c === "boolean") return `<c${r} t="b"><v>${c ? 1 : 0}</v></c>`;
    if ("inline" in c) return `<c${r} t="inlineStr"><is><t xml:space="preserve">${esc(c.inline)}</t></is></c>`;
    if ("f" in c) {
      const t = c.t ?? (typeof c.v === "string" ? "str" : typeof c.v === "boolean" ? "b" : undefined);
      const v = c.v === undefined ? "" : `<v>${esc(typeof c.v === "boolean" ? (c.v ? "1" : "0") : String(c.v))}</v>`;
      return `<c${r}${t ? ` t="${t}"` : ""}><f>${esc(c.f)}</f>${v}</c>`;
    }
    if ("error" in c) return `<c${r} t="e"><v>${esc(c.error)}</v></c>`;
    return c.raw;
  };
  const parts: ZipPart[] = [];
  const overrides: string[] = [];
  const sheetRels: string[] = [];
  const sheetTags: string[] = [];
  const n = spec.sheets.length;
  spec.sheets.forEach((sheet, i) => {
    const file = spec.scramble ? n - i : i + 1;
    const kind = sheet.chartsheet ? "chartsheet" : "worksheet";
    const path = sheet.chartsheet ? `xl/chartsheets/sheet${file}.xml` : `xl/worksheets/sheet${file}.xml`;
    sheetRels.push(`<Relationship Id="rId${i + 1}" Type="${REL}/${kind}" Target="/${path}"/>`);
    const state = sheet.hidden === "very" ? ' state="veryHidden"' : sheet.hidden ? ' state="hidden"' : "";
    sheetTags.push(`<sheet name="${attr(sheet.name)}" sheetId="${i + 1}"${state} r:id="rId${i + 1}"/>`);
    if (sheet.chartsheet) { parts.push({ name: path, data: xml(`<chartsheet xmlns="${SML}"/>`) }); return; }
    const data = sheet.sheetData ?? (sheet.rows ?? []).map((row, ri) =>
      `<row r="${ri + 1}">${row.map((c, ci) => cell(c, sheet.noRefs ? "" : `${colName(ci + 1)}${ri + 1}`)).join("")}</row>`).join("");
    overrides.push(`<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    parts.push({ name: path, data: xml(`<worksheet xmlns="${SML}"><sheetData>${data}</sheetData></worksheet>`) });
  });
  // the generated sheets are written in file-name order, so scrambled files come out in the reverse of the workbook order
  parts.sort((a, b) => (a.name as string).localeCompare(b.name as string, "en", { numeric: true }));
  if (!spec.noSharedPart && (shared.length > 0 || spec.sharedXml !== undefined)) {
    sheetRels.push(`<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`);
    parts.push({ name: "xl/sharedStrings.xml", data: xml(`<sst xmlns="${SML}">${spec.sharedXml ?? shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`) });
  }
  const mainType = spec.macro ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  return makeZip([
    {
      name: "[Content_Types].xml",
      data: xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${mainType}"/>${overrides.join("")}</Types>`),
    },
    { name: "_rels/.rels", data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: "xl/_rels/workbook.xml.rels", data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels.join("")}</Relationships>`) },
    { name: "xl/workbook.xml", data: xml(`<workbook xmlns="${SML}" xmlns:r="${REL}"><sheets>${sheetTags.join("")}</sheets></workbook>`) },
    ...(spec.macro ? [{ name: "xl/vbaProject.bin", data: "not a real macro" }] : []),
    ...parts,
    ...(spec.extraParts ?? []),
  ]);
}

// ---- PPTX ----

const PML = "application/vnd.openxmlformats-officedocument.presentationml";
const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

// A paragraph; a "\n" inside the text becomes a:br.
export const para = (text: string): string =>
  `<a:p>${text.split("\n").map((t) => `<a:r><a:t>${esc(t)}</a:t></a:r>`).join("<a:br/>")}</a:p>`;
export const sp = (paras: string[], ph?: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph === undefined ? "" : `<p:ph type="${ph}"/>`}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras.map(para).join("")}</p:txBody></p:sp>`;
export const grp = (inner: string): string => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${inner}</p:grpSp>`;
export const pptxTable = (rows: string[][]): string =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData><a:tbl>${
    rows.map((r) => `<a:tr>${r.map((c) => `<a:tc><a:txBody><a:bodyPr/>${c.split("\n\n").map(para).join("")}</a:txBody></a:tc>`).join("")}</a:tr>`).join("")
  }</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

export interface PptxSlide { shapes: string; hidden?: boolean; notes?: string }
// fileOrder[i] is the number of the slide file that holds presentation slide i (default i + 1).
export interface PptxSpec { slides: PptxSlide[]; fileOrder?: number[]; macro?: boolean; extraParts?: ZipPart[] }

export function makePptx(spec: PptxSpec): Uint8Array {
  const parts: ZipPart[] = [];
  const overrides: string[] = [];
  const presRels: string[] = [];
  const ids: string[] = [];
  spec.slides.forEach((slide, i) => {
    const k = spec.fileOrder?.[i] ?? i + 1;
    presRels.push(`<Relationship Id="rId${i + 1}" Type="${REL}/slide" Target="slides/slide${k}.xml"/>`);
    ids.push(`<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`);
    overrides.push(`<Override PartName="/ppt/slides/slide${k}.xml" ContentType="${PML}.slide+xml"/>`);
    parts.push({ name: `ppt/slides/slide${k}.xml`, data: xml(`<p:sld ${P_NS}${slide.hidden ? ' show="0"' : ""}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${slide.shapes}</p:spTree></p:cSld></p:sld>`) });
    const rels = [`<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`];
    if (slide.notes !== undefined) {
      rels.push(`<Relationship Id="rId2" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide${k}.xml"/>`);
      overrides.push(`<Override PartName="/ppt/notesSlides/notesSlide${k}.xml" ContentType="${PML}.notesSlide+xml"/>`);
      parts.push({ name: `ppt/notesSlides/notesSlide${k}.xml`, data: xml(`<p:notes ${P_NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${slide.notes}</p:spTree></p:cSld></p:notes>`) });
    }
    parts.push({ name: `ppt/slides/_rels/slide${k}.xml.rels`, data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`) });
  });
  parts.sort((a, b) => (a.name as string).localeCompare(b.name as string, "en", { numeric: true }));
  const mainType = spec.macro ? "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml" : `${PML}.presentation.main+xml`;
  return makeZip([
    {
      name: "[Content_Types].xml",
      data: xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="${mainType}"/>${overrides.join("")}</Types>`),
    },
    { name: "_rels/.rels", data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`) },
    { name: "ppt/_rels/presentation.xml.rels", data: xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${presRels.join("")}</Relationships>`) },
    { name: "ppt/presentation.xml", data: xml(`<p:presentation ${P_NS}><p:sldIdLst>${ids.join("")}</p:sldIdLst></p:presentation>`) },
    ...(spec.macro ? [{ name: "ppt/vbaProject.bin", data: "not a real macro" }] : []),
    ...parts,
    ...(spec.extraParts ?? []),
  ]);
}
