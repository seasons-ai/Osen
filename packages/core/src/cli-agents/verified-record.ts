import { accessSync, constants, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { describeIssue } from "../messages/zod.ts";
import { providerMessages } from "../messages/providers.ts";
import builtin from "./verified-record.json" with { type: "json" };
import { CLI_AGENTS } from "./types.ts";
import type { CliAgent } from "./types.ts";

export const VERIFIED_FILE = "cli-verified.json";
export type VerifiedLevel = "interface" | "real";
export interface VerifiedEntry {
  agent: CliAgent;
  version: string;
  level: VerifiedLevel;
  checkedAt: string;
  os: string;
  osenVersion: string;
  sha256?: string;
  modelCalls?: number;
}
export type ParsedRecord = { ok: true; entries: VerifiedEntry[] } | { ok: false; reason: string };

const nonEmpty = z.string().min(1);
const EntrySchema = z
  .strictObject({
    agent: z.enum(CLI_AGENTS),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    level: z.enum(["interface", "real"]),
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    os: nonEmpty,
    osenVersion: nonEmpty,
    sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    modelCalls: z.number().int().min(1).optional(),
  })
  .superRefine((e, ctx) => {
    const m = providerMessages();
    if (e.level === "real" && e.modelCalls === undefined) ctx.addIssue({ code: "custom", path: ["modelCalls"], message: m.recordModelCallsRequired });
    if (e.level === "interface" && e.modelCalls !== undefined) ctx.addIssue({ code: "custom", path: ["modelCalls"], message: m.recordModelCallsForbidden });
  });
const RecordSchema = z.strictObject({ schemaVersion: z.literal(1), entries: z.array(EntrySchema) });

// Reason text names the base file name and the first invalid place; never a sha256 value or an absolute path.
function reject(file: string, where: string, why: string): { ok: false; reason: string } {
  return { ok: false, reason: providerMessages().recordRejected(file, where, why) };
}
const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file;

export function parseVerifiedRecord(data: unknown, file: string): ParsedRecord {
  const name = baseName(file);
  const r = RecordSchema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0]!;
    return reject(name, i.path.join(".") || providerMessages().recordWhereFile, describeIssue(i));
  }
  const seen = new Set<string>();
  for (const [n, e] of r.data.entries.entries()) {
    const key = `${e.agent}@${e.version}`;
    if (seen.has(key)) return reject(name, `entries.${n}`, providerMessages().recordDuplicate(e.agent, e.version));
    seen.add(key);
  }
  return { ok: true, entries: r.data.entries };
}

function parseBuiltin(): VerifiedEntry[] {
  const p = parseVerifiedRecord(builtin, "verified-record.json");
  if (!p.ok) throw new Error(p.reason);
  return p.entries;
}
export const BUILTIN_RECORD: readonly VerifiedEntry[] = parseBuiltin();

export type LocalRecordState = { state: "absent" } | { state: "loaded"; entries: VerifiedEntry[] } | { state: "rejected"; reason: string };

export function readLocalRecord(dataDir: string): LocalRecordState {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, VERIFIED_FILE), "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown";
    if (code === "ENOENT") return { state: "absent" };
    return { state: "rejected", ...reject(VERIFIED_FILE, providerMessages().recordWhereFile, providerMessages().recordUnreadable(code)) };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { state: "rejected", ...reject(VERIFIED_FILE, providerMessages().recordWhereFile, providerMessages().recordNotJson) };
  }
  const p = parseVerifiedRecord(data, VERIFIED_FILE);
  return p.ok ? { state: "loaded", entries: p.entries } : { state: "rejected", reason: p.reason };
}

const RANK: Record<VerifiedLevel, number> = { interface: 0, real: 1 };
const keyOf = (e: { agent: string; version: string }) => `${e.agent}@${e.version}`;
const versionParts = (v: string) => v.split(".").map(Number);

function compareEntries(a: VerifiedEntry, b: VerifiedEntry): number {
  if (a.agent !== b.agent) return a.agent < b.agent ? -1 : 1;
  const [x, y] = [versionParts(a.version), versionParts(b.version)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

// One entry per (agent, version): higher level wins, then later checkedAt, then the local entry.
export function mergeRecords(builtinEntries: readonly VerifiedEntry[], local: readonly VerifiedEntry[]): VerifiedEntry[] {
  const out = new Map<string, VerifiedEntry>();
  const put = (e: VerifiedEntry) => {
    const cur = out.get(keyOf(e));
    if (!cur || RANK[e.level] > RANK[cur.level] || (RANK[e.level] === RANK[cur.level] && e.checkedAt >= cur.checkedAt)) out.set(keyOf(e), e);
  };
  builtinEntries.forEach(put);
  local.forEach(put); // ties go to the local entry
  return [...out.values()].sort(compareEntries);
}

export interface VerifiedRecord {
  entries: VerifiedEntry[];
  rejected?: string;
}

export function loadVerifiedRecord(dataDir?: string): VerifiedRecord {
  const local = dataDir === undefined ? ({ state: "absent" } as const) : readLocalRecord(dataDir);
  if (local.state === "loaded") return { entries: mergeRecords(BUILTIN_RECORD, local.entries) };
  const entries = mergeRecords(BUILTIN_RECORD, []);
  return local.state === "rejected" ? { entries, rejected: local.reason } : { entries };
}

export function lookupVerified(record: VerifiedRecord, agent: CliAgent, version: string): VerifiedEntry | undefined {
  return record.entries.find((e) => e.agent === agent && e.version === version);
}

export type AddResult = { ok: true; changed: boolean } | { ok: false; reason: string };

// A higher level is never replaced; the same level only with replaceSameLevel (re-acceptance).
export function addLocalEntry(dataDir: string, entry: VerifiedEntry, opts: { replaceSameLevel?: boolean } = {}): AddResult {
  const checked = EntrySchema.safeParse(entry);
  if (!checked.success) {
    const i = checked.error.issues[0]!;
    return reject(VERIFIED_FILE, ["entries", ...i.path].join("."), describeIssue(i));
  }
  const local = readLocalRecord(dataDir);
  if (local.state === "rejected") return { ok: false, reason: local.reason };
  const existing = local.state === "loaded" ? local.entries : [];
  const cur = existing.find((e) => keyOf(e) === keyOf(entry));
  if (cur && (RANK[cur.level] > RANK[entry.level] || (RANK[cur.level] === RANK[entry.level] && !opts.replaceSameLevel))) return { ok: true, changed: false };
  const entries = cur ? existing.map((e) => (e === cur ? checked.data : e)) : [...existing, checked.data];
  const file = join(dataDir, VERIFIED_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    if (existsSync(file)) accessSync(file, constants.W_OK); // a rename would also replace a read-only file
    writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    return { ok: false, reason: providerMessages().recordWriteFailed(VERIFIED_FILE, (e as NodeJS.ErrnoException).code ?? "unknown") };
  }
  return { ok: true, changed: true };
}
