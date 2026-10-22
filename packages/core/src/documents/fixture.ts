import { crc32, deflateRawSync } from "node:zlib";

export interface ZipPart { name: string; data: Uint8Array | string; method?: 0 | 8; declaredSize?: number; encrypted?: boolean }

export function makeZip(parts: ZipPart[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const raw = typeof part.data === "string" ? Buffer.from(part.data, "utf8") : Buffer.from(part.data);
    const method = part.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(part.name, "utf8");
    const size = part.declaredSize ?? raw.length;
    const flags = part.encrypted ? 1 : 0;
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
    rec.writeUInt16LE(20, 4);
    rec.writeUInt16LE(20, 6);
    rec.writeUInt16LE(flags, 8);
    rec.writeUInt16LE(method, 10);
    rec.writeUInt32LE(crc32(raw), 16);
    rec.writeUInt32LE(body.length, 20);
    rec.writeUInt32LE(size, 24);
    rec.writeUInt16LE(name.length, 28);
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
