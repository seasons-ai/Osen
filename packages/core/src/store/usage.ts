import { readdirSync, type Dirent } from "node:fs";
import { sessionUsage, summarizeUsage } from "../protocol/usage.ts";
import type { SessionUsage, UsageSummary } from "../protocol/usage.ts";
import { readTariffs } from "./tariffs.ts";
import { isValidSessionId, readEvents, sessionsDir } from "./journal.ts";
import { storeMessages } from "../messages/store.ts";

// ponytail: the summary reads all journals on request, without a cache; the ceiling is hundreds of sessions; the upgrade is a cache of records by journal size and mtime
export interface UsageSkip { id: string; kind: "unreadable" | "truncated"; reason: string }

export function readUsageSummary(dataDir: string, from: string, to: string, onSkip?: (skip: UsageSkip) => void): UsageSummary {
  let entries: Dirent[];
  try {
    entries = readdirSync(sessionsDir(dataDir), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    entries = [];
  }
  const sessions: SessionUsage[] = [];
  let unreadable = 0, truncated = 0;
  for (const d of entries) {
    if (!d.isDirectory() || !isValidSessionId(d.name)) continue;
    let r;
    try {
      r = readEvents(dataDir, d.name);
    } catch (e) {
      unreadable++;
      // the fs error message contains the data folder path — outward only the code or the class name
      onSkip?.({ id: d.name, kind: "unreadable", reason: (e as NodeJS.ErrnoException).code ?? (e as Error)?.constructor?.name ?? "Error" });
      continue;
    }
    if (r === null || r.size === 0) continue;
    if (r.events[0]?.type !== "session_created") {
      unreadable++;
      onSkip?.({ id: d.name, kind: "unreadable", reason: storeMessages().usageNoCreated });
      continue;
    }
    sessions.push(sessionUsage(r.events));
    if (r.offset < r.size) {
      truncated++;
      onSkip?.({ id: d.name, kind: "truncated", reason: storeMessages().usageTruncated(r.offset, r.size) });
    }
  }
  return summarizeUsage(sessions, from, to, { unreadable, truncated }, readTariffs(dataDir));
}
