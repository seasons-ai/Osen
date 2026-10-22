import { posix } from "node:path";
import { htmlToText } from "../url/html-text.ts";
import { DocError } from "./limits.ts";
import { decodeXml, parseXml, type XmlElement } from "./xml.ts";
import type { Zip } from "./zip.ts";

const CONTAINER = "META-INF/container.xml";
const ENCRYPTION = "META-INF/encryption.xml";
const CHAPTER_TYPES = ["application/xhtml+xml", "text/html"];

const local = (name: string): string => name.slice(name.indexOf(":") + 1);
const kids = (el: XmlElement, name?: string): XmlElement[] =>
  el.children.filter((c): c is XmlElement => typeof c !== "string" && (name === undefined || local(c.name) === name));
const damaged = (part: string): never => { throw new DocError("damaged", part); };

// An XML part of the package; any parse failure names the part.
function xmlPart(zip: Zip, path: string): XmlElement {
  if (!zip.entries.has(path)) return damaged(path);
  try { return parseXml(decodeXml(zip.read(path))); } catch (e) {
    if (e instanceof DocError && e.code === "damaged") return damaged(path);
    throw e;
  }
}

// href of a package or encryption entry, relative to base directory; undefined when it leaves the archive root.
function resolveHref(base: string, href: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(href.replace(/#.*$/s, "")); } catch { return undefined; }
  if (decoded === "" || decoded.startsWith("/") || decoded.includes("\\")) return undefined;
  const path = posix.normalize(posix.join(base, decoded));
  return path === ".." || path.startsWith("../") || path.startsWith("/") ? undefined : path;
}

function chapterHtml(zip: Zip, path: string): string {
  let bytes = zip.read(path);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return damaged(path); }
  const enc = /^\s*<\?xml[^>]*?\bencoding\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  if (enc !== undefined && enc.toLowerCase() !== "utf-8") damaged(path);
  return html;
}

export function epubText(zip: Zip, chars: number): string {
  const container = xmlPart(zip, CONTAINER);
  const rootfile = kids(container, "rootfiles").flatMap((r) => kids(r, "rootfile"))
    .find((e) => e.attrs["media-type"] === "application/oebps-package+xml");
  const opfPath = rootfile?.attrs["full-path"];
  if (!opfPath) return damaged(CONTAINER);
  const opf = xmlPart(zip, opfPath);
  const base = posix.dirname(opfPath);

  const manifest = new Map<string, { href: string; type: string }>();
  for (const m of kids(opf, "manifest")) for (const item of kids(m, "item")) {
    if (item.attrs.id !== undefined) manifest.set(item.attrs.id, { href: item.attrs.href ?? "", type: item.attrs["media-type"] ?? "" });
  }
  const chapters: string[] = [];
  for (const s of kids(opf, "spine")) for (const ref of kids(s, "itemref")) {
    const idref = ref.attrs.idref ?? "";
    const item = manifest.get(idref);
    if (!item) return damaged(idref);
    if (!CHAPTER_TYPES.includes(item.type)) continue;
    const path = resolveHref(base, item.href);
    if (path === undefined) return damaged(item.href);
    if (!zip.entries.has(path)) return damaged(path);
    chapters.push(path);
  }

  if (zip.entries.has(ENCRYPTION)) {
    const covered = new Set<string>();
    const walk = (el: XmlElement): void => {
      for (const c of kids(el)) {
        if (local(c.name) === "CipherReference" && c.attrs.URI !== undefined) {
          const p = resolveHref("", c.attrs.URI);
          if (p !== undefined) covered.add(p);
        } else walk(c);
      }
    };
    walk(xmlPart(zip, ENCRYPTION));
    if (chapters.some((c) => covered.has(c))) throw new DocError("drm");
  }

  // One chapter is parsed and released before the next, so memory follows the largest chapter, not the book.
  const texts: string[] = [];
  let total = 0;
  for (const path of chapters) {
    const text = htmlToText(chapterHtml(zip, path));
    if (text === "") continue;
    total += text.length + (texts.length ? 2 : 0);
    if (total > chars) throw new DocError("chars");
    texts.push(text);
  }
  return texts.join("\n\n");
}
