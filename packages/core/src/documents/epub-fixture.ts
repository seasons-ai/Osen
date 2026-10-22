import { makeZip, type ZipPart } from "./fixture.ts";

export interface EpubChapter { path: string; html: string; id?: string; mediaType?: string; linear?: "no" }
export interface EpubSpec {
  chapters: EpubChapter[];
  spine?: string[];
  archiveOrder?: string[];
  opfPath?: string;
  container?: string | false;
  opf?: string;
  encryption?: string;
  extraParts?: ZipPart[];
  mimetype?: string;
}

const decl = '<?xml version="1.0" encoding="UTF-8"?>\n';

export function xhtml(body: string, opts: { title?: string; head?: string } = {}): string {
  return `<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${opts.title ?? "Book"}</title>${opts.head ?? ""}</head><body>${body}</body></html>`;
}

export function makeEpub(spec: EpubSpec): Uint8Array {
  const opfPath = spec.opfPath ?? "OEBPS/content.opf";
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const rel = (p: string): string => (dir && p.startsWith(dir) ? p.slice(dir.length) : p);
  const idOf = (c: EpubChapter, i: number): string => c.id ?? `c${i + 1}`;
  const manifest = spec.chapters.map((c, i) => `<item id="${idOf(c, i)}" href="${rel(c.path)}" media-type="${c.mediaType ?? "application/xhtml+xml"}"/>`).join("");
  const order = spec.spine ?? spec.chapters.map(idOf);
  const linear = new Map(spec.chapters.map((c, i) => [idOf(c, i), c.linear]));
  const itemrefs = order.map((id) => `<itemref idref="${id}"${linear.get(id) ? ` linear="${linear.get(id)}"` : ""}/>`).join("");
  const opf = spec.opf ?? `${decl}<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>${manifest}</manifest><spine>${itemrefs}</spine></package>`;
  const container = spec.container === undefined
    ? `${decl}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`
    : spec.container;
  const byPath = new Map(spec.chapters.map((c) => [c.path, c]));
  const names = spec.archiveOrder ?? spec.chapters.map((c) => c.path);
  const chapterParts: ZipPart[] = names.filter((n) => byPath.has(n)).map((n) => ({ name: n, data: byPath.get(n)!.html }));
  return makeZip([
    { name: "mimetype", data: spec.mimetype ?? "application/epub+zip", method: 0 },
    ...(container === false ? [] : [{ name: "META-INF/container.xml", data: container }]),
    ...(spec.encryption === undefined ? [] : [{ name: "META-INF/encryption.xml", data: spec.encryption }]),
    { name: opfPath, data: opf },
    ...chapterParts,
    ...(spec.extraParts ?? []),
  ]);
}
