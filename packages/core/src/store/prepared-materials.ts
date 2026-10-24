import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { sha256Of, verifyMaterials } from "../materials.ts";
import type { CollectedMaterial, LeftMaterial, SkippedMaterial } from "../materials.ts";
import { checkSources, decodeSources, encodeSources, SOURCES_FILE, SOURCES_MAX_BYTES } from "./material-sources.ts";
import type { MaterialSource } from "./material-sources.ts";
import { FOLDER_LIMITS, folderStats } from "../protocol/folder.ts";
import type { FolderFile } from "../protocol/folder.ts";
import { storeMessages } from "../messages/store.ts";
import { createLogger } from "./log.ts";

export const PREPARED_TTL_MS = 24 * 60 * 60 * 1000;
// ponytail: a rough byte bound — 8 bytes per character with a margin for JSON escaping; more precisely — count after reading
export const PREPARED_MAX_BYTES = 8 * FOLDER_LIMITS.snapshotChars;

export type PreparedProblem = "invalid" | "unknown" | "expired" | "corrupt" | "limit";

export class PreparedMaterialsError extends Error {
  readonly problem: PreparedProblem;
  constructor(problem: PreparedProblem, message: string) {
    super(message);
    this.name = "PreparedMaterialsError";
    this.problem = problem;
  }
}

export interface PreparedInput {
  materials: readonly CollectedMaterial[];
  workspace: readonly FolderFile[];
  skipped: readonly SkippedMaterial[];
  left: readonly LeftMaterial[];
  materialsChars: number;
  stamp: string;
  sources?: readonly MaterialSource[];
}

export interface PreparedSet {
  id: string;
  createdAt: string;
  materials: CollectedMaterial[];
  workspace: FolderFile[];
  skipped: SkippedMaterial[];
  left: LeftMaterial[];
  materialsChars: number;
  stamp: string;
  sources: MaterialSource[];
}

const SetSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string().refine((s) => !Number.isNaN(Date.parse(s))),
  materialsChars: z.number().int().nonnegative(),
  stamp: z.string(),
  materials: z.array(z.object({
    id: z.string(), name: z.string(), chars: z.number().int(), sha256: z.string(), text: z.string(),
  })),
  workspace: z.array(z.object({ name: z.string(), text: z.string() })),
  skipped: z.array(z.object({ name: z.string(), reason: z.string(), excludedPath: z.string().optional(), rule: z.string().optional() })),
  left: z.array(z.object({ name: z.string(), reason: z.string() })),
});

export function isValidPreparedId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
}

export function preparedMaterialsDir(dataDir: string): string {
  return join(dataDir, "prepared-materials");
}

const sumOf = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function limitProblems(materials: readonly CollectedMaterial[], workspace: readonly FolderFile[], materialsChars: number): string[] {
  const problems = verifyMaterials(materials, materialsChars);
  const chars = folderStats(workspace).chars;
  if (chars > FOLDER_LIMITS.snapshotChars) problems.push(storeMessages().folderTooLarge(chars, FOLDER_LIMITS.snapshotChars));
  return problems;
}

export function savePreparedMaterials(dataDir: string, input: PreparedInput, options: { now?: () => Date } = {}): PreparedSet {
  const problems = limitProblems(input.materials, input.workspace, input.materialsChars);
  if (problems.length > 0) throw new PreparedMaterialsError("limit", problems.join("\n"));
  if (input.sources?.length) {
    const bad = checkSources(input.sources, input.materials.map((m) => m.id));
    if (bad) throw new PreparedMaterialsError("limit", bad);
  }
  const set: PreparedSet = {
    id: randomBytes(16).toString("hex"),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    materials: input.materials.map((m) => ({ ...m })),
    workspace: input.workspace.map((f) => ({ ...f })),
    skipped: input.skipped.map((s) => ({ ...s })),
    left: input.left.map((l) => ({ ...l })),
    materialsChars: input.materialsChars,
    stamp: input.stamp,
    sources: input.sources?.map((x) => ({ ...x })) ?? [],
  };
  const { sources, ...body } = set;
  const json = JSON.stringify({ version: 1, ...body });
  const root = preparedMaterialsDir(dataDir);
  mkdirSync(root, { recursive: true });
  const tmp = join(root, `.tmp-${randomBytes(8).toString("hex")}`);
  try {
    mkdirSync(tmp);
    writeFileSync(join(tmp, "set.json"), json);
    writeFileSync(join(tmp, "set.sha256"), sumOf(json));
    if (sources.length > 0) writeFileSync(join(tmp, SOURCES_FILE), encodeSources(sources));
    renameSync(tmp, join(root, set.id));
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  removeExpiredSets(dataDir, set.id, options);
  return set;
}

// Removes sets older than the TTL; unreadable or damaged ones are left, and a failure never fails the prepare.
// ponytail: full parse of each set on prepare, ceiling hundreds of sets; upgrade = read only createdAt
function removeExpiredSets(dataDir: string, newId: string, options: { now?: () => Date }): void {
  const root = preparedMaterialsDir(dataDir);
  try {
    for (const id of readdirSync(root)) {
      if (id === newId || !isValidPreparedId(id)) continue;
      try {
        loadPreparedMaterials(dataDir, id, options);
      } catch (e) {
        if (!(e instanceof PreparedMaterialsError) || e.problem !== "expired") continue;
        try {
          rmSync(join(root, id), { recursive: true, force: true });
        } catch (err) {
          createLogger(dataDir, "store").error(`Could not remove the expired prepared set ${id}`, err);
        }
      }
    }
  } catch (err) {
    createLogger(dataDir, "store").error("Could not scan prepared sets for expired ones", err);
  }
}

const corrupt = () => new PreparedMaterialsError("corrupt", storeMessages().preparedCorrupt);
const unknown = () => new PreparedMaterialsError("unknown", storeMessages().preparedUnknown);

function lstatOrUnknown(path: string) {
  try {
    return lstatSync(path);
  } catch (e) {
    const c = (e as NodeJS.ErrnoException).code;
    if (c === "ENOENT" || c === "ENOTDIR") throw unknown();
    throw e;
  }
}

export function loadPreparedMaterials(dataDir: string, id: unknown, options: { now?: () => Date } = {}): PreparedSet {
  if (!isValidPreparedId(id)) throw new PreparedMaterialsError("invalid", storeMessages().preparedInvalid);
  const dir = join(preparedMaterialsDir(dataDir), id);
  const dirStat = lstatOrUnknown(dir);
  const fileStat = lstatOrUnknown(join(dir, "set.json"));
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > PREPARED_MAX_BYTES) throw corrupt();
  let bytes: Buffer;
  let sum: string;
  try {
    bytes = readFileSync(join(dir, "set.json"));
    sum = readFileSync(join(dir, "set.sha256"), "utf8").trim();
  } catch {
    throw corrupt();
  }
  if (sum !== sumOf(bytes)) throw corrupt();
  let parsed;
  try {
    parsed = SetSchema.safeParse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw corrupt();
  }
  if (!parsed.success || parsed.data.id !== id) throw corrupt();
  const { version: _v, ...set } = parsed.data;
  if (set.materials.some((m) => m.sha256 !== sha256Of(m.text) || m.chars !== m.text.length)) throw corrupt();
  if (limitProblems(set.materials, set.workspace, set.materialsChars).length > 0) throw corrupt();
  const now = (options.now ?? (() => new Date()))().getTime();
  if (now - Date.parse(set.createdAt) >= PREPARED_TTL_MS) {
    throw new PreparedMaterialsError("expired", storeMessages().preparedExpired);
  }
  return { ...set, sources: loadSources(dir, set.materials) };
}

function loadSources(dir: string, materials: readonly CollectedMaterial[]): MaterialSource[] {
  const bad = () => new PreparedMaterialsError("corrupt", storeMessages().preparedCorruptSources);
  const path = join(dir, SOURCES_FILE);
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw bad();
  }
  if (st.isSymbolicLink() || !st.isFile() || st.size > SOURCES_MAX_BYTES) throw bad();
  let sources;
  try {
    sources = decodeSources(readFileSync(path, "utf8"));
  } catch {
    throw bad();
  }
  if (!sources || checkSources(sources, materials.map((m) => m.id))) throw bad();
  return sources;
}
