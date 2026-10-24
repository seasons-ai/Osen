import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import ignore from "ignore";
import type { Ignore } from "ignore";
import { FOLDER_LIMITS, folderStats } from "./protocol/folder.ts";
import type { FolderFile } from "./protocol/folder.ts";
import { CFB_SIGNATURE } from "./documents/cfb.ts";
import { DOC_LIMITS, documentReason, readDocumentText } from "./documents/extract.ts";
import { nonTextReason, TAIL_BYTES } from "./documents/kinds.ts";
import { expandArchive } from "./materials-archive.ts";
import { newPdfOcrBudget, PDF_LIMITS, pdfReason, readPdfText } from "./pdf/extract.ts";
import { imageSignature, type ImageFormat } from "./ocr/image-header.ts";
import { imageReason, OCR_LIMITS, readImageText } from "./ocr/run.ts";
import { decodeFileText } from "./text-encoding.ts";
import { materialsMessages } from "./messages/materials.ts";

export interface CollectedMaterial {
  id: string;
  name: string;
  chars: number;
  sha256: string;
  text: string;
}

export interface SkippedMaterial {
  name: string;
  reason: string;
  /** Absolute path of an element excluded by a .gitignore rule; accepted by CollectOptions.include. Does not go further than the prepared set. */
  excludedPath?: string;
  /** The rule that excluded the element, as written in .gitignore; present together with excludedPath. The reason text depends on the language, the rule does not. */
  rule?: string;
}

export interface MaterialSet {
  materials: CollectedMaterial[];
  skipped: SkippedMaterial[];
}

export interface CollectOptions {
  materialsChars: number;
  materialsIgnore: readonly string[];
  /** false — .gitignore files of the attached folder are not read; by default the rules apply. */
  gitignore?: boolean;
  /** Absolute paths returned from exclusion by rules; a path that the rules did not exclude makes collection fail. */
  include?: readonly string[];
}

export class MaterialsError extends Error {
  override name = "MaterialsError";
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join("\n"));
    this.reasons = reasons;
  }
}

const HEAD_BYTES = 8192;

const RULES_MAX_BYTES = 2 ** 20;

function readRules(abs: string): string {
  // O_NONBLOCK: a queue (FIFO) substituted for a file does not hang the collection
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(materialsMessages().notRegularFile);
    if (st.size > RULES_MAX_BYTES) throw new Error(materialsMessages().rulesTooLarge(RULES_MAX_BYTES / 2 ** 20));
    return readFileSync(fd, "utf8").replace(/^\uFEFF/, "");
  } finally {
    closeSync(fd);
  }
}

// A nested .gitignore rule is rewritten into a path from the attached folder: all rules lie in one list, and the "deeper — later" order gives git's priority.
export function rebaseRule(line: string, base: string): string {
  if (line.trim() === "" || line.startsWith("#")) return line;
  const negative = line.startsWith("!");
  const body = negative ? line.slice(1) : line;
  // linear form of /\/*\s*$/: the old regex is quadratic on a long whitespace run (.gitignore of an archive is third-party input)
  let core = body.trimEnd();
  while (core.endsWith("/")) core = core.slice(0, -1);
  if (core === "") return ""; // "!", "/", "!/" match nothing in git, while the parser would take "!" as return-everything
  if (base === "") return line;
  const anchored = core.includes("/");
  const prefix = base.replace(/[\\*?[\]]/g, "\\$&");
  return `${negative ? "!" : ""}/${prefix}/${anchored ? body.replace(/^\//, "") : `**/${body}`}`;
}

export function isEnvName(name: string): boolean {
  const lower = name.toLowerCase(); // case-insensitive: on APFS .ENV and .env are one file
  return lower === ".env" || lower.startsWith(".env.");
}

export function sha256Of(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export function errText(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  return err.code ?? err.message;
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function decodeText(bytes: Buffer): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return /[\x00-\x08\x0e-\x1f\x7f]/.test(text) ? undefined : text;
}

// The last TAIL_BYTES of the file (DMG trailer); read only for a file that is not text
function readTail(fd: number): Buffer | undefined {
  const size = fstatSync(fd).size;
  if (size < TAIL_BYTES) return undefined;
  const tail = Buffer.alloc(TAIL_BYTES);
  return readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES) === TAIL_BYTES ? tail : undefined;
}

// string — text, { refused } — not text or the PDF, document or image was refused with a reason (archive: true — a ZIP archive in a folder, defer), { image } — an image whose recognition is deferred (defer)
function readText(abs: string, defer = false): string | { refused: string; archive?: true } | { image: ImageFormat } | { pdf: true } | { archive: true } {
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(materialsMessages().notRegularFile);
    const head = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, head, 0, HEAD_BYTES, 0);
    if (head.subarray(0, Math.min(n, 5)).toString("latin1") === "%PDF-") {
      if (defer) return { pdf: true };
      const r = readPdfText(fd);
      return r.ok ? r.text : { refused: pdfReason(r) };
    }
    // an empty ZIP is only the end record: it goes to the archive reader, which refuses it as empty
    if (n === 22 && head.readUInt32LE(0) === 0x06054b50) return defer ? { refused: materialsMessages().archiveInFolder, archive: true } : { archive: true };
    if (n >= 4 && head.readUInt32LE(0) === 0x04034b50) {
      const r = readDocumentText(fd);
      if (r.ok) return r.text;
      if (r.code === "bytes") return { refused: materialsMessages().zipTooLarge(DOC_LIMITS.bytes / 2 ** 20) };
      if (r.code === "unsupported") return defer ? { refused: materialsMessages().archiveInFolder, archive: true } : { archive: true };
      return { refused: documentReason(r) };
    }
    // RTF is ASCII, so this check comes before the plain-text decode; CFB covers DOC and encrypted Office files
    const bom = n >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
    const rtf = head.subarray(bom, Math.min(n, bom + 5)).toString("latin1") === "{\\rtf";
    if (rtf || (n >= 8 && head.subarray(0, 8).equals(CFB_SIGNATURE))) {
      const r = readDocumentText(fd);
      if (r.ok) return r.text;
      if (r.code === "unsupported") return { refused: nonTextReason(head.subarray(0, n), readTail(fd)) };
      return { refused: documentReason(r) };
    }
    const image = imageSignature(head.subarray(0, n), fstatSync(fd).size);
    if (image) {
      if (defer) return { image };
      const r = readImageText(fd, image);
      return r.ok ? r.text : { refused: imageReason(r) };
    }
    // ponytail: a large text file is read entirely before the limit check; a streaming count — if folders with gigabyte logs become normal
    const text = decodeFileText(head.subarray(0, n), () => readFileSync(fd));
    return typeof text === "string" ? text : { refused: nonTextReason(head.subarray(0, n), readTail(fd), text?.refused) };
  } finally {
    closeSync(fd);
  }
}

// Recognition of an image or PDF found during a folder walk: the files are opened again after the folder is sorted
function readDeferred<T>(abs: string, read: (fd: number) => T): T {
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(materialsMessages().notRegularFile);
    return read(fd);
  } finally {
    closeSync(fd);
  }
}

function findSymlink(abs: string): string | undefined {
  const root = parse(abs).root;
  let current = root;
  for (const part of abs.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) return current;
  }
  return undefined;
}

export const nameKey = (s: string) => s.normalize("NFC").toLowerCase();

/** Names of the attached folders in materials: same-named ones are told apart by the suffix " (N)". folders — absolute paths in attachment order; result: path → name. */
export function folderPrefixes(folders: readonly string[]): Map<string, string> {
  const unique = [...new Set(folders)];
  const reserved = new Set(unique.map((f) => nameKey(basename(f))));
  const assigned = new Set<string>();
  const out = new Map<string, string>();
  for (const f of unique) {
    const base = basename(f);
    let prefix = base;
    if (assigned.has(nameKey(base))) {
      let n = 2;
      while (assigned.has(nameKey(`${base} (${n})`)) || reserved.has(nameKey(`${base} (${n})`))) n++;
      prefix = `${base} (${n})`;
    }
    assigned.add(nameKey(prefix));
    out.set(f, prefix);
  }
  return out;
}

/** Names only for folders: attached files get no suffixes and reserve no names. */
export function attachedFolderPrefixes(paths: readonly string[]): Map<string, string> {
  const dirs = [...new Set(paths.map((p) => resolve(p)))].filter((a) => {
    try {
      return lstatSync(a).isDirectory();
    } catch {
      return false;
    }
  });
  return folderPrefixes(dirs);
}

type WalkOut = { rel: string; text?: string; skip?: string; excludedPath?: string; rule?: string; abs?: string; image?: ImageFormat; pdf?: true }[];

export function collectMaterials(paths: readonly string[], options: CollectOptions): MaterialSet {
  const m = materialsMessages();
  const reasons: string[] = [];
  let found: { name: string; text: string }[] = [];
  const skipped: SkippedMaterial[] = [];
  const seen = new Set<string>();
  const include = new Set((options.include ?? []).map((p) => resolve(p)));
  const explicit = new Set(paths.map((p) => resolve(p)));
  const returned = new Set<string>();
  const shownRule = new Map<string, string>();
  const prefixes = attachedFolderPrefixes(paths);
  const archiveKeys = new Set([...prefixes.values()].map(nameKey));
  // an archive prefix is the file name; same-named ones are told apart by " (N)" like folders
  function archivePrefix(base: string): string {
    let prefix = base;
    for (let n = 2; archiveKeys.has(nameKey(prefix)); n++) prefix = `${base} (${n})`;
    archiveKeys.add(nameKey(prefix));
    return prefix;
  }

  function addRules(parent: Ignore, dir: string, rel: string): Ignore {
    const lines = readRules(join(dir, ".gitignore")).split(/\r?\n/);
    const rebased = lines.map((l) => rebaseRule(l, rel));
    rebased.forEach((r, i) => shownRule.set(r.trim(), lines[i]!.trim()));
    return ignore({ allowRelativePaths: true }).add(parent).add(rebased);
  }

  function addFile(abs: string, name: string, text: string): void {
    seen.add(abs);
    found.push({ name, text });
  }

  // rules === undefined: the rules do not apply (disabled, or the folder was returned whole); inherited — the rule of an excluded folder inside which the returned path lies
  function walk(dir: string, rootName: string, rel: string, out: WalkOut, rules: Ignore | undefined, inherited?: string): void {
    const shown = (r: string) => (r ? `${rootName}/${r}` : rootName);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // the root is named explicitly by the owner — refusal; a subfolder found during the walk — a skip
      if (rel === "") reasons.push(m.pathNamed(shown(rel), m.readFailed(errText(e))));
      else out.push({ rel, skip: m.readFailed(errText(e)) });
      return;
    }
    let unread: string | undefined;
    if (rules && inherited === undefined && entries.some((e) => e.name === ".gitignore" && (e.isFile() || e.isSymbolicLink()))) {
      try {
        rules = addRules(rules, dir, rel);
      } catch (e) {
        unread = errText(e);
      }
    }
    for (const entry of entries) {
      const eRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      const isDir = entry.isDirectory();
      const skip = (reason: string) => out.push({ rel: eRel, skip: reason });
      if (!isDir && isEnvName(entry.name)) skip(m.envSkipped);
      else if (entry.name.startsWith(".")) skip(entry.name === ".gitignore" && unread !== undefined ? m.readFailed(unread) : m.hiddenName);
      else if (options.materialsIgnore.includes(entry.name)) skip(m.ignoredByList);
      else {
        let below = rules;
        let belowInherited: string | undefined;
        let hit: ReturnType<Ignore["test"]> | undefined;
        try {
          if (inherited === undefined) hit = rules?.test(isDir ? `${eRel}/` : eRel);
        } catch {
          // a rule the parser could not apply does not make collection fail: the path counts as not excluded
        }
        const pattern = (hit?.rule?.pattern ?? "").trim();
        const rule = inherited ?? (hit?.ignored ? (shownRule.get(pattern) ?? pattern) : undefined);
        if (rule !== undefined) {
          if (include.has(abs)) {
            returned.add(abs);
            below = undefined;
          } else if (isDir && [...include].some((p) => p.startsWith(abs + sep))) belowInherited = rule;
          else {
            out.push({ rel: isDir ? `${eRel}/` : eRel, skip: m.excludedByRule(rule), excludedPath: abs, rule });
            continue;
          }
        }
        if (entry.isSymbolicLink()) skip(m.symlink);
        else if (isDir) walk(abs, rootName, eRel, out, below, belowInherited);
        else if (!entry.isFile()) skip(m.notRegularFile);
        else if (!seen.has(abs)) {
          try {
            const text = readText(abs, true);
            if (typeof text === "object" && "image" in text) out.push({ rel: eRel, abs, image: text.image });
            else if (typeof text === "object" && "pdf" in text) out.push({ rel: eRel, abs, pdf: true });
            else if (typeof text === "object") {
              // an archive attached separately by the same path is expanded under its own prefix, not skipped here
              const { refused, archive } = text as { refused: string; archive?: true };
              if (!(archive && explicit.has(abs))) skip(refused);
            }
            else {
              seen.add(abs);
              out.push({ rel: eRel, text });
            }
          } catch (e) {
            skip(m.readFailed(errText(e)));
          }
        }
      }
    }
  }

  // first folders, then explicit files: a file that includes the walk of a folder is named with the folder whatever the order of paths; the place in the set is by the index of the input path
  const buckets = paths.map((): typeof found => []);
  const isFolder = (i: number) => Number(prefixes.has(resolve(paths[i]!)));
  // a path named again (same resolved path) is taken once: by its first occurrence, before any walk or reason
  const firstIndex = new Map<string, number>();
  paths.forEach((p, i) => {
    const r = resolve(p);
    if (!firstIndex.has(r)) firstIndex.set(r, i);
  });
  for (const i of paths.map((_, i) => i).sort((a, b) => isFolder(b) - isFolder(a))) {
    const p = paths[i]!;
    found = buckets[i]!;
    const abs = resolve(p);
    if (firstIndex.get(abs) !== i) continue;
    const base = basename(abs);
    if (isEnvName(base)) {
      reasons.push(m.pathNamed(p, m.envRefused));
      continue;
    }
    try {
      const link = findSymlink(abs);
      if (link !== undefined) {
        reasons.push(m.pathNamed(p, m.pathThroughSymlink(link)));
        continue;
      }
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        const out: WalkOut = [];
        walk(abs, prefixes.get(abs) ?? base, "", out, options.gitignore === false ? undefined : ignore({ allowRelativePaths: true }));
        out.sort((a, b) => compare(a.rel, b.rel));
        // images are recognized in the final name order: the first folderImages that reach the helper; refusals by size and header take no slot
        let recognized = 0;
        const pdfBudget = newPdfOcrBudget(); // one recognition budget per attached folder, spent in the same name order
        for (const o of out) {
          if (o.pdf) {
            try {
              const r = readDeferred(o.abs!, (fd) => readPdfText(fd, PDF_LIMITS, pdfBudget));
              if (r.ok) {
                seen.add(o.abs!);
                o.text = r.text;
              } else o.skip = pdfReason(r);
            } catch (e) {
              o.skip = m.readFailed(errText(e));
            }
            continue;
          }
          if (!o.image) continue;
          if (recognized >= OCR_LIMITS.folderImages) {
            o.skip = m.imgFolderLimit(OCR_LIMITS.folderImages);
            continue;
          }
          try {
            const r = readDeferred(o.abs!, (fd) => readImageText(fd, o.image!));
            if (!(!r.ok && (r.code === "bytes" || r.code === "pixels" || r.code === "damaged"))) recognized++;
            if (r.ok) {
              seen.add(o.abs!);
              o.text = r.text;
            } else o.skip = imageReason(r);
          } catch (e) {
            o.skip = m.readFailed(errText(e));
          }
        }
        for (const o of out) {
          const name = `${prefixes.get(abs) ?? base}/${o.rel}`;
          if (o.skip !== undefined) skipped.push({ name, reason: o.skip, ...(o.excludedPath !== undefined ? { excludedPath: o.excludedPath, rule: o.rule! } : {}) });
          else found.push({ name, text: o.text! });
        }
      } else if (!st.isFile()) {
        reasons.push(m.pathNamed(p, m.notFileNorFolder));
      } else if (!seen.has(abs)) {
        const text = readText(abs);
        if (typeof text === "object" && "archive" in text) {
          const r = expandArchive(abs, archivePrefix(base), options);
          if ("refused" in r) for (const reason of r.refused) reasons.push(m.pathNamed(p, reason));
          else {
            seen.add(abs);
            found.push(...r.materials);
            skipped.push(...r.skipped);
          }
        } else if (typeof text === "object") reasons.push(m.pathNamed(p, (text as { refused: string }).refused)); // an image is deferred only in folders
        else addFile(abs, base, text);
      }
    } catch (e) {
      reasons.push(m.pathNamed(p, isMissing(e) ? m.pathNotFound : m.readFailed(errText(e))));
    }
  }

  for (const abs of include) {
    if (returned.has(abs) || [...returned].some((r) => abs.startsWith(r + sep))) continue; // a path inside a returned folder is already returned
    // the name from the attached folder, as in the summary: the absolute path does not get into the reason
    const root = paths.map((p) => resolve(p)).find((r) => abs.startsWith(r + sep));
    reasons.push(m.pathNamed(root ? `${prefixes.get(root) ?? basename(root)}/${abs.slice(root.length + 1)}` : basename(abs), m.notExcluded));
  }

  // an explicitly attached file is not excluded by the rules: there is no record of it among the excluded ones
  const shownSkipped = skipped.filter((s) => s.excludedPath === undefined || !seen.has(s.excludedPath));

  const materials = buckets.flat().map((f, i) => ({
    id: `m${i + 1}`,
    name: f.name,
    chars: f.text.length,
    sha256: sha256Of(f.text),
    text: f.text,
  }));
  if (reasons.length === 0) {
    const over = limitProblem(materials, options.materialsChars);
    if (over) reasons.push(over);
  }
  if (reasons.length > 0) throw new MaterialsError(reasons);
  return { materials, skipped: shownSkipped };
}

function largestThree(items: readonly { name: string; chars: number }[]): string {
  return items
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.chars - a.m.chars || a.i - b.i)
    .slice(0, 3)
    .map(({ m }) => `${m.name} — ${m.chars}`)
    .join(", ");
}

function limitProblem(materials: readonly CollectedMaterial[], limit: number): string | undefined {
  const total = materials.reduce((sum, m) => sum + m.chars, 0);
  if (total <= limit) return undefined;
  return materialsMessages().materialsOverLimit(total, limit, largestThree(materials));
}

export function verifyMaterials(materials: readonly CollectedMaterial[], limit: number | undefined): string[] {
  const problems: string[] = [];
  const vm = materialsMessages();
  materials.forEach((m, i) => {
    if (m.id !== `m${i + 1}`) problems.push(vm.idMismatch(i + 1, m.id));
    if (m.name.trim() === "") problems.push(vm.emptyName(m.id));
    if (m.chars !== m.text.length) problems.push(vm.charsMismatch(m.id));
    if (m.sha256 !== sha256Of(m.text)) problems.push(vm.checksumMismatch(m.id));
  });
  if (materials.length > 0) {
    if (limit === undefined) problems.push(vm.limitNotSet);
    else {
      const over = limitProblem(materials, limit);
      if (over) problems.push(over);
    }
  }
  return problems;
}

export interface LeftMaterial { name: string; reason: string }

/** Extensions treated as descriptions when a folder is over the limit; also printed in `council --help`. */
export const DESCRIPTION_EXTENSIONS = [
  "md", "markdown", "mdx", "txt", "rst", "adoc", "pdf", "docx", "docm", "dotx", "dotm", "pptx", "pptm", "potx", "potm",
  "ppsx", "ppsm", "odt", "ott", "odp", "otp", "epub", "rtf", "doc",
] as const;
const DOC_EXT = new RegExp(`\\.(${DESCRIPTION_EXTENSIONS.join("|")})$`, "i");
const total = (ms: readonly CollectedMaterial[]) => ms.reduce((s, m) => s + m.chars, 0);

/** "Always included": without "/" in the name — an explicitly attached file; otherwise only if the file path is named and explicit. roots — absolute paths. */
export function isPinnedMaterial(m: Pick<CollectedMaterial, "name">, roots: readonly string[]): boolean {
  return pinnedBy(roots)(m);
}

// the file path is named explicitly: a name "<folder name>/<path>" is parsed by folder names, not by dirname
function pinnedBy(roots: readonly string[]): (m: Pick<CollectedMaterial, "name">) => boolean {
  const prefixes = [...attachedFolderPrefixes(roots)];
  return (m) =>
    !m.name.includes("/") || prefixes.some(([r, p]) => m.name.startsWith(`${p}/`) && roots.includes(join(r, m.name.slice(p.length + 1))));
}

/** Selection under the limit. room — how many characters are available to this set (the limit minus what the caller has already taken). */
export function selectMaterials(
  source: readonly CollectedMaterial[], roots: readonly string[], room: number,
): { taken: CollectedMaterial[]; left: LeftMaterial[] } {
  const isPinned = pinnedBy(roots);
  const pinned = source.filter(isPinned);
  const folder = source.filter((m) => !isPinned(m));
  let left = room - total(pinned);
  const reasons = new Map<CollectedMaterial, string>();
  const sm = materialsMessages();
  const taken = new Set<CollectedMaterial>(pinned);
  if (total(folder) <= left) folder.forEach((m) => taken.add(m));
  else {
    const docs = folder.filter((m) => DOC_EXT.test(m.name));
    const candidates = new Set(docs.length > 0 ? docs : folder);
    const byDepth = [...candidates].map((m, i) => ({ m, i, depth: m.name.split("/").length })).sort((x, y) => x.depth - y.depth || x.i - y.i);
    for (const { m } of byDepth) {
      if (m.chars <= left) {
        left -= m.chars;
        taken.add(m);
      }
    }
    for (const m of folder) {
      if (taken.has(m)) continue;
      reasons.set(m, candidates.has(m) ? sm.didNotFit(m.chars) : sm.notDescription);
    }
  }
  return {
    taken: source.filter((m) => taken.has(m)),
    left: source.filter((m) => reasons.has(m)).map((m) => ({ name: m.name, reason: reasons.get(m)! })),
  };
}

/** The text keeps only the last segments of paths: first the input paths themselves, then their ancestor folders (a path through a symbolic link). */
export function scrubPaths(text: string, paths: readonly string[]): string {
  const ancestors = new Set<string>();
  for (const p of paths) for (let d = dirname(p); dirname(d) !== d; d = dirname(d)) ancestors.add(d);
  const byLength = (xs: Iterable<string>) => [...xs].sort((a, b) => b.length - a.length);
  let out = text;
  for (const p of byLength(new Set(paths))) out = out.split(p).join(basename(p));
  for (const a of byLength(ancestors)) out = out.split(a).join(basename(a));
  return out;
}

export interface SessionMaterialSet {
  materials: CollectedMaterial[]; // the source set, ids m1..mN in order
  workspace: FolderFile[]; // all files of the attached folders (the name contains "/"), both those in the set and those not in it
  skipped: SkippedMaterial[];
  left: LeftMaterial[]; // files of the folder not in the source set, with a reason
}

/** extra — explicitly attached materials not from the filesystem (links): a name without "/", a common limit with the attached files, the rest of the limit goes to folder files. */
export function collectSessionMaterials(
  paths: readonly string[], options: CollectOptions, extra: readonly Omit<CollectedMaterial, "id">[] = [],
): SessionMaterialSet {
  const bad = extra.find((m) => m.name.includes("/"));
  if (bad) throw new Error(materialsMessages().extraNameSlash(bad.name));
  const roots = paths.map((p) => resolve(p));
  let set: MaterialSet;
  try {
    set = collectMaterials(paths, { ...options, materialsChars: Number.MAX_SAFE_INTEGER });
  } catch (e) {
    if (e instanceof MaterialsError) throw new MaterialsError(e.reasons.map((r) => scrubPaths(r, [...paths, ...roots])));
    throw e;
  }
  const reasons: string[] = [];
  const isPinned = pinnedBy(roots);
  const over = limitProblem([...set.materials.filter(isPinned), ...extra.map((m) => ({ ...m, id: "" }))], options.materialsChars);
  if (over) reasons.push(over);
  const workspace = set.materials.filter((m) => m.name.includes("/")).map((m) => ({ name: m.name, text: m.text }));
  const { chars } = folderStats(workspace);
  if (chars > FOLDER_LIMITS.snapshotChars) {
    reasons.push(materialsMessages().folderOverSnapshot(chars, FOLDER_LIMITS.snapshotChars, largestThree(workspace.map((f) => ({ name: f.name, chars: f.text.length })))));
  }
  if (reasons.length > 0) throw new MaterialsError(reasons);
  const { taken, left } = selectMaterials(set.materials, roots, options.materialsChars - extra.reduce((s, m) => s + m.chars, 0));
  return { materials: [...taken, ...extra].map((m, i) => ({ ...m, id: `m${i + 1}` })), workspace, skipped: set.skipped, left };
}
