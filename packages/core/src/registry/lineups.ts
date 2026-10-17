import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { registryMessages } from "../messages/registry.ts";
import { zodMessages } from "../messages/zod.ts";
import { tryPidLock } from "../store/pid-lock.ts";
import { isProcessAlive } from "../store/sessions.ts";
import { describe } from "./config.ts";

/** Position of a named lineup: provider, model and role; the order of positions is set by the queue. */
export interface LineupParticipant { providerId: string; model: string; role: string | null }
export interface Lineup { id: string; name: string; participants: LineupParticipant[] }

export class LineupsError extends Error {
  override name = "LineupsError";
}

export const lineupsPath = (dataDir: string): string => join(dataDir, "lineups.json");

const NAME_MAX = 100;
const nonEmpty = z.string().min(1);
const nameSchema = z
  .string()
  .refine((n) => n.trim() !== "", { error: () => registryMessages().lnNameEmpty })
  .refine((n) => !/[\r\n]/.test(n), { error: () => registryMessages().lnNameOneLine })
  .refine((n) => n.trim().length <= NAME_MAX, { error: () => registryMessages().lnNameMax(NAME_MAX) });
const LineupSchema = z.strictObject({
  id: nonEmpty,
  name: nameSchema,
  participants: z.array(z.strictObject({ providerId: nonEmpty, model: nonEmpty, role: z.string().nullable() })).min(2),
});
const LineupsSchema = z.array(LineupSchema).superRefine((list, ctx) => {
  const m = registryMessages();
  const ids = new Set<string>();
  const names = new Map<string, number>();
  list.forEach((l, i) => {
    if (ids.has(l.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: m.lnIdRepeats(l.id) });
    ids.add(l.id);
    const first = names.get(l.name.trim());
    if (first !== undefined) ctx.addIssue({ code: "custom", path: [i, "name"], message: m.lnNameTaken(l.name, first) });
    else names.set(l.name.trim(), i);
  });
});

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Reads lineups.json. No file — an empty list; a broken file is not changed, LineupsError. */
export function readLineups(dataDir: string): Lineup[] {
  const m = registryMessages();
  const file = lineupsPath(dataDir);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT") return [];
    throw new LineupsError(m.lnReadFailed(file, errText(e)));
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new LineupsError(m.lnNotJson(errText(e)));
  }
  const parsed = LineupsSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : zodMessages().root}: ${describe(i)}`);
    throw new LineupsError(m.lnInvalid(lines.join("; ")));
  }
  return parsed.data;
}

// The lock file appears at once with the pid (a link from a ready temp file). true — taken; false — held by a live process.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Saves a new lineup. The lineups.lock lock between processes; reading, checking and writing under the lock are synchronous. */
export async function saveLineup(
  dataDir: string,
  input: { name: string; participants: readonly LineupParticipant[] },
  options: { lockWaitMs?: number } = {},
): Promise<Lineup> {
  const m = registryMessages();
  const name = input.name.trim();
  if (name === "") throw new LineupsError(m.lnSaveEmpty);
  if (/[\r\n]/.test(name)) throw new LineupsError(m.lnSaveOneLine);
  if (name.length > NAME_MAX) throw new LineupsError(m.lnSaveMax(NAME_MAX));
  if (input.participants.length < 2) throw new LineupsError(m.lnSaveMin);
  if (input.participants.some((p) => !p.providerId || !p.model)) throw new LineupsError(m.lnSaveProviderModel);

  const lock = join(dataDir, "lineups.lock");
  const deadline = Date.now() + (options.lockWaitMs ?? 2000);
  for (;;) {
    let taken: boolean;
    try {
      taken = tryPidLock(lock, isProcessAlive);
    } catch (e) {
      throw new LineupsError(m.lnLockFailed(lock, errText(e)));
    }
    if (taken) break;
    if (Date.now() >= deadline) throw new LineupsError(m.lnBusy);
    await sleep(25);
  }
  try {
    const list = readLineups(dataDir);
    const taken = list.find((l) => l.name.trim() === name);
    if (taken) throw new LineupsError(m.lnSaveTaken(name, taken.id));
    const lineup: Lineup = {
      id: randomUUID(),
      name,
      participants: input.participants.map(({ providerId, model, role }) => ({ providerId, model, role })),
    };
    const file = lineupsPath(dataDir);
    const tmp = `${file}.tmp`;
    try {
      if (existsSync(file)) accessSync(file, constants.W_OK);
      writeFileSync(tmp, `${JSON.stringify([...list, lineup], null, 2)}\n`);
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw new LineupsError(m.lnWriteFailed(file, errText(e)));
    }
    return lineup;
  } finally {
    try { unlinkSync(lock); } catch { /* already removed */ }
  }
}
