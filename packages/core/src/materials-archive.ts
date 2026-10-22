import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import ignore from "ignore";
import type { Ignore } from "ignore";
import { listArchiveEntries, readArchiveEntries } from "./documents/archive-run.ts";
import type { ArchiveEntry } from "./documents/archive.ts";
import { DOC_LIMITS, documentReason, extractDocumentText, type DocFailure } from "./documents/extract.ts";
import { CFB_SIGNATURE } from "./documents/cfb.ts";
import { extractPdfText, pdfReason } from "./pdf/extract.ts";
import { imageDimensions, imageSignature } from "./ocr/image-header.ts";
import { imageReason, OCR_LIMITS, runOcrHelper } from "./ocr/run.ts";
import { materialsMessages } from "./messages/materials.ts";
import { compare, decodeText, errText, isEnvName, nameKey, rebaseRule } from "./materials.ts";
import type { CollectOptions, SkippedMaterial } from "./materials.ts";

export const ARCHIVE_TOTAL_MS = 300_000;

const BATCH_BYTES = 32 * 2 ** 20;
const RULES_MAX_BYTES = 2 ** 20;
const HEAD_BYTES = 8192;
const CACHE_CHARS = 20_000_000;

export type ArchiveResult = { materials: { name: string; text: string }[]; skipped: SkippedMaterial[] } | { refused: string[] };

/** Path segments of a safe archive entry name (the trailing "/" of a folder is removed); undefined for an unsafe name. */
export function archiveEntryPath(name: string): string[] | undefined {
  if (name.includes("\\") || name.includes("\u0000") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return undefined;
  const segments = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  return segments.some((s) => s === "" || s === "." || s === "..") ? undefined : segments;
}

class Refuse extends Error {
  lines: string[];
  transient: boolean;
  constructor(lines: string[], transient = false) {
    super(lines.join("\n"));
    this.lines = lines;
    this.transient = transient;
  }
}

function failureReason(f: { code: DocFailure; detail?: string }): string {
  const m = materialsMessages();
  switch (f.code) {
    case "damaged": return m.archiveDamaged;
    case "zip_parts": return m.archiveParts(DOC_LIMITS.parts);
    case "zip_size": return m.archiveUnpacked(DOC_LIMITS.unpackedBytes / 2 ** 20);
    case "zip_ratio": return m.archiveRatio(DOC_LIMITS.ratio);
    case "bytes": return m.zipTooLarge(DOC_LIMITS.bytes / 2 ** 20);
    case "timeout": return m.archiveTimeout(DOC_LIMITS.ms / 1000);
    case "memory": return m.archiveMemory(DOC_LIMITS.rssBytes / 2 ** 20);
    default: return m.archiveFailed(f.detail ?? m.docStartError);
  }
}

const TRANSIENT: readonly DocFailure[] = ["timeout", "memory", "failed"];

type Node = { name: string; dir: boolean; idx?: number; children: Map<string, Node> };
type Out = { rel: string; text?: string; skip?: string; idx?: number };

// ponytail: this mirrors the readers of readText in materials.ts on bytes (PDF, documents, RTF/DOC of change 211, images, text); a reader added there later
// (encodings of change 212) must be wired here too.
function readEntryBytes(bytes: Uint8Array, state: { recognized: number }): { text: string } | { skip: string } {
  const m = materialsMessages();
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = buf.subarray(0, Math.min(buf.length, HEAD_BYTES));
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") {
    const r = extractPdfText(bytes);
    return r.ok ? { text: r.text } : { skip: pdfReason(r) };
  }
  // an empty ZIP is only the end record: as in readText it is an archive, here a nested one
  if (buf.length === 22 && head.readUInt32LE(0) === 0x06054b50) return { skip: m.archiveNested };
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) {
    const r = extractDocumentText(bytes);
    if (r.ok) return { text: r.text };
    if (r.code === "unsupported") return { skip: m.archiveNested };
    if (r.code === "bytes") return { skip: m.zipTooLarge(DOC_LIMITS.bytes / 2 ** 20) };
    return { skip: documentReason(r) };
  }
  // RTF (a UTF-8 BOM before it is allowed) and Compound File Binary (DOC, encrypted Office) go to the same extractor as in readText
  const bom = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  if (head.subarray(bom, bom + 5).toString("latin1") === "{\\rtf" || (head.length >= 8 && head.subarray(0, 8).equals(CFB_SIGNATURE))) {
    const r = extractDocumentText(bytes);
    if (r.ok) return { text: r.text };
    return { skip: r.code === "unsupported" ? m.notText : documentReason(r) };
  }
  const format = imageSignature(head, buf.length);
  if (format) {
    if (state.recognized >= OCR_LIMITS.folderImages) return { skip: m.imgFolderLimit(OCR_LIMITS.folderImages) };
    if (buf.length > OCR_LIMITS.bytes) return { skip: imageReason({ code: "bytes" }) };
    const dims = imageDimensions(bytes, format);
    if (!dims) return { skip: imageReason({ code: "damaged" }) };
    if (dims.width * dims.height > OCR_LIMITS.pixels) return { skip: imageReason({ code: "pixels" }) };
    state.recognized++;
    const r = runOcrHelper({ mode: "image", ms: OCR_LIMITS.ms, rssBytes: OCR_LIMITS.rssBytes }, bytes);
    return r.ok ? { text: r.text } : { skip: imageReason(r) };
  }
  if (head.includes(0)) return { skip: m.notText };
  const text = decodeText(buf);
  return text === undefined ? { skip: m.notText } : { text };
}

// Reads the items (with an idx) in the given order in batches of at most BATCH_BYTES of declared size; one entry over it is its own batch.
function readBatches<T extends { idx?: number }>(
  bytes: Uint8Array, entries: readonly ArchiveEntry[], items: readonly T[], checkTime: () => void,
  each: (item: T, data: Uint8Array | DocFailure | undefined) => void,
): void {
  const flush = (batch: T[], declared: number): void => {
    if (batch.length === 0) return;
    checkTime();
    const r = readArchiveEntries(bytes, batch.map((o) => o.idx!), declared);
    if (!r.ok) throw new Refuse([failureReason(r)], TRANSIENT.includes(r.code));
    for (const o of batch) {
      checkTime();
      each(o, r.entries.get(o.idx!));
    }
  };
  let batch: T[] = [];
  let declared = 0;
  for (const o of items) {
    const size = entries[o.idx!]!.size;
    if (batch.length > 0 && declared + size > BATCH_BYTES) {
      flush(batch, declared);
      batch = [];
      declared = 0;
    }
    batch.push(o);
    declared += size;
  }
  flush(batch, declared);
}

const cache = new Map<string, ArchiveResult>();
let cacheChars = 0;

export function expandArchive(abs: string, prefix: string, options: CollectOptions, totalMs = ARCHIVE_TOTAL_MS): ArchiveResult {
  const m = materialsMessages();
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  let key: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(m.notRegularFile);
    key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${prefix}:${JSON.stringify([options.materialsIgnore, options.gitignore !== false])}:${m.archiveEmpty}`;
    const hit = cache.get(key);
    if (hit) return hit;
    if (st.size > DOC_LIMITS.bytes) return { refused: [m.zipTooLarge(DOC_LIMITS.bytes / 2 ** 20)] };
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  const deadline = Date.now() + totalMs;
  const checkTime = () => {
    if (Date.now() >= deadline) throw new Refuse([m.archiveTimeout(totalMs / 1000)], true);
  };
  let result: ArchiveResult;
  try {
    result = expand(bytes, prefix, options, checkTime);
  } catch (e) {
    if (!(e instanceof Refuse)) throw e;
    result = { refused: e.lines };
    if (e.transient) return result;
  }
  cache.set(key, result);
  if ("materials" in result) cacheChars += result.materials.reduce((s, x) => s + x.text.length, 0);
  if (cacheChars > CACHE_CHARS) { cache.clear(); cacheChars = 0; }
  return result;
}

function expand(bytes: Buffer, prefix: string, options: CollectOptions, checkTime: () => void): ArchiveResult {
  const m = materialsMessages();
  const listed = listArchiveEntries(bytes);
  if (!listed.ok) throw new Refuse([failureReason(listed)], TRANSIENT.includes(listed.code));
  const { entries } = listed;
  if (entries.length === 0) return { refused: [m.archiveEmpty] };

  const out: Out[] = [];
  const dupSkip = (rel: string) => out.push({ rel, skip: m.archiveDuplicate });
  for (const name of listed.duplicates) dupSkip(name);

  // virtual tree of the safe entries; implicit parent folders come from the paths
  const root: Node = { name: "", dir: true, children: new Map() };
  entries.forEach((entry, idx) => {
    const segments = archiveEntryPath(entry.name);
    if (!segments) {
      out.push({ rel: entry.name, skip: m.archiveUnsafeName });
      return;
    }
    let cur = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      const k = nameKey(seg);
      const last = i === segments.length - 1;
      const existing = cur.children.get(k);
      const asDir = !last || entry.kind === "dir";
      if (existing) {
        if (last && !(asDir && existing.dir)) { dupSkip(segments.join("/") + (entry.kind === "dir" ? "/" : "")); return; }
        if (!last && !existing.dir) { dupSkip(segments.join("/")); return; }
        if (asDir) { cur = existing; continue; }
      }
      const node: Node = { name: seg, dir: asDir, children: new Map(), ...(asDir ? {} : { idx }) };
      cur.children.set(k, node);
      cur = node;
    }
  });

  // .gitignore files of the archive are fetched first, in one call
  const useRules = options.gitignore !== false;
  const ruleText = new Map<Node, string | { error: string }>();
  if (useRules) {
    const wanted: Node[] = [];
    const collect = (n: Node) => {
      for (const c of n.children.values()) {
        if (c.dir) collect(c);
        else if (c.name === ".gitignore") wanted.push(c);
      }
    };
    collect(root);
    const toRead: Node[] = [];
    for (const n of wanted) {
      const e = entries[n.idx!]!;
      if (e.kind !== "file") ruleText.set(n, { error: e.kind === "encrypted" ? "encrypted" : "ELOOP" });
      else if (e.size > RULES_MAX_BYTES) ruleText.set(n, { error: m.rulesTooLarge(RULES_MAX_BYTES / 2 ** 20) });
      else toRead.push(n);
    }
    readBatches(bytes, entries, toRead, checkTime, (n, d) => {
      ruleText.set(n, d instanceof Uint8Array ? Buffer.from(d).toString("utf8").replace(/^\uFEFF/, "") : { error: d ?? "failed" });
    });
  }

  const shownRule = new Map<string, string>();
  const walk = (dir: Node, rel: string, rules: Ignore | undefined): void => {
    let unread: string | undefined;
    const gi = [...dir.children.values()].find((c) => !c.dir && c.name === ".gitignore");
    if (rules && gi) {
      const t = ruleText.get(gi);
      if (typeof t === "string") {
        try {
          const lines = t.split(/\r?\n/);
          const rebased = lines.map((l) => rebaseRule(l, rel));
          const next = ignore({ allowRelativePaths: true }).add(rules).add(rebased);
          rebased.forEach((r, i) => shownRule.set(r.trim(), lines[i]!.trim()));
          rules = next;
        } catch (e) {
          unread = errText(e);
        }
      } else unread = t?.error ?? "failed";
    }
    for (const child of dir.children.values()) {
      const name = child.name;
      const eRel = rel ? `${rel}/${name}` : name;
      const entry: ArchiveEntry | undefined = child.idx === undefined ? undefined : entries[child.idx];
      const skip = (reason: string, r = eRel) => out.push({ rel: r, skip: reason });
      if (!child.dir && isEnvName(name)) skip(m.envSkipped);
      else if (name.startsWith(".")) skip(name === ".gitignore" && unread !== undefined ? m.readFailed(unread) : m.hiddenName);
      else if (options.materialsIgnore.includes(name)) skip(m.ignoredByList);
      else if (child.dir && rel === "" && name === "__MACOSX") skip(m.archiveMacos, `${eRel}/`);
      else {
        let hit: ReturnType<Ignore["test"]> | undefined;
        try {
          hit = rules?.test(child.dir ? `${eRel}/` : eRel);
        } catch {
          // a rule the parser could not apply does not make collection fail: the path counts as not excluded
        }
        if (hit?.ignored) {
          const pattern = (hit.rule?.pattern ?? "").trim();
          skip(m.excludedByRule(shownRule.get(pattern) ?? pattern), child.dir ? `${eRel}/` : eRel);
        } else if (child.dir) walk(child, eRel, rules);
        else if (entry!.kind === "symlink") skip(m.symlink);
        else if (entry!.kind === "encrypted") skip(m.docEncrypted);
        else if (entry!.size > DOC_LIMITS.bytes) skip(m.archiveEntryBytes(DOC_LIMITS.bytes / 2 ** 20));
        else out.push({ rel: eRel, idx: child.idx! });
      }
    }
  };
  walk(root, "", useRules ? ignore({ allowRelativePaths: true }) : undefined);
  out.sort((a, b) => compare(a.rel, b.rel));

  // entries are read in the final order, in batches of declared size
  const state = { recognized: 0 };
  readBatches(bytes, entries, out.filter((o) => o.idx !== undefined), checkTime, (o, data) => {
    if (data === undefined || typeof data === "string") o.skip = data === "encrypted" ? m.docEncrypted : m.archiveDamaged;
    else {
      try {
        const res = readEntryBytes(data, state);
        if ("text" in res) o.text = res.text;
        else o.skip = res.skip;
      } catch (e) {
        o.skip = m.readFailed(errText(e));
      }
    }
  });

  const materials: { name: string; text: string }[] = [];
  const skipped: SkippedMaterial[] = [];
  for (const o of out) {
    const name = `${prefix}/${o.rel}`;
    if (o.skip !== undefined || o.text === undefined) skipped.push({ name, reason: o.skip ?? m.notText });
    else materials.push({ name, text: o.text });
  }
  if (materials.length === 0) {
    return { refused: [m.archiveNoFiles(skipped.length), ...skipped.slice(0, 10).map((s) => `${s.name} — ${s.reason}`)] };
  }
  return { materials, skipped };
}
