// Check of an unreadable journal in "History": real main modules (historyItems) and the real core logger, fixture journals, no Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/unreadable-journal/check.ts
//   ... --seed-only   only prepare the folder for the app window (one session with chmod 000)
// Writes only to COUNCIL_HOME and does not delete it; restores the journal permissions itself (except --seed-only). No models are called.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { appendEvent, createLogger, createSessionJournal, ensureDataDir, eventsPath, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry, Session } from "../../../../packages/core/src/index.ts";
import { historyItems } from "../../src/main/history.ts";

const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only");
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Usage: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/unreadable-journal/check.ts");
  process.exit(2);
}
if (existsSync(resolve(home)) && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const dir = realpathSync(resolve(home));
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };

const IDS = { good1: "readable-1", good2: "readable-2", bad: "unreadable-x" } as const;
const mk = (id: string, n: number): Session => ({
  id, createdAt: `2026-10-09T08:00:0${n}Z`, origin: "cli", topic: `Тема ${id}`, templateId: null, framing: "",
  participants: ["p1", "p2"].map((p) => ({ id: p, name: p, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
});
// the core considers pid 1 alive (EPERM): the readable sessions are running, a dead pid would give "interrupted"
const seed = (id: string, n: number) => {
  createSessionJournal(dir, id);
  appendEvent(dir, id, { seq: 1, ts: mk(id, n).createdAt, type: "session_created", session: mk(id, n), pid: 1 });
};
writeRegistry(ensureDataDir(dir), {
  providers: [],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] },
} as unknown as Registry);
seed(IDS.good1, 1); seed(IDS.good2, 2); seed(IDS.bad, 3);
const restore = () => chmodSync(eventsPath(dir, IDS.bad), 0o600);

if (seedOnly) {
  chmodSync(eventsPath(dir, IDS.bad), 0o000);
  console.log(`Data folder prepared: ${dir}`);
  console.log(`Sessions: ${IDS.good1}, ${IDS.good2} (readable, running), ${IDS.bad} (events.jsonl with permissions 000)`);
  console.log(`Restore permissions: chmod 600 "${eventsPath(dir, IDS.bad)}"`);
  console.log(`cd "${resolve(import.meta.dirname, "../../../..")}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" npm run desktop`);
  process.exit(0);
}

const logger = createLogger(dir, "desktop", env);
const logFile = resolve(dir, "logs", "app.log");
const read = () => historyItems(dir, new Map(), new Set(), (id, e) => logger.error(`Session journal ${id} not read`, e));
try {
  // 1 one unreadable
  chmodSync(eventsPath(dir, IDS.bad), 0o000);
  const items = read();
  assert.deepEqual(items.map((i) => i.id).sort(), [IDS.good1, IDS.good2]);
  assert.ok(items.every((i) => i.status === "running"));
  const log = readFileSync(logFile, "utf8");
  assert.ok(log.split("\n").some((l) => l.includes(IDS.bad) && l.includes("ERROR") && l.includes("not read")), log);
  assert.ok(!log.includes(IDS.good1) && !log.includes(IDS.good2), log);
  ok(`"History" with chmod 000 on ${IDS.bad}: ${items.length} readable sessions, no exception; logs/app.log has a line with the unreadable id, no readable ones in the log`);

  // 2 the only one unreadable
  const only = resolve(dir, "only");
  mkdirSync(only);
  ensureDataDir(only);
  createSessionJournal(only, "solo");
  appendEvent(only, "solo", { seq: 1, ts: mk("solo", 1).createdAt, type: "session_created", session: mk("solo", 1), pid: 1 });
  chmodSync(eventsPath(only, "solo"), 0o000);
  const seen: string[] = [];
  try {
    assert.deepEqual(historyItems(only, new Map(), new Set(), (id) => seen.push(id)), []);
  } finally {
    chmodSync(eventsPath(only, "solo"), 0o600);
  }
  assert.deepEqual(seen, ["solo"]);
  ok("the only unreadable session: an empty list without an exception, onUnreadable received its id");

  // 3 permissions restored: the session is visible again, no new log lines
  restore();
  const lines = readFileSync(logFile, "utf8").split("\n").length;
  assert.equal(read().length, 3);
  assert.equal(readFileSync(logFile, "utf8").split("\n").length, lines);
  ok("after the permissions are restored all three sessions are visible, the log did not grow");
} finally {
  restore();
}
console.log(`Result: ${checks} checks, all passed; real model calls 0; data folder ${dir}`);
