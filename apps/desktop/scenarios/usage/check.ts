// Check of the usage summary on fixture journals: the real app bridge, the core (readUsageSummary) and the main history fold, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder>" node apps/desktop/scenarios/usage/check.ts
//   ... --seed-only   only prepare the folder for the app window
//   ... --append      on a prepared folder, append a turn to session C and compare the growth of group beta for today (repeatable)
// Writes only to COUNCIL_HOME and does not delete it. No models are called.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendEvent, createLogger, ensureDataDir, eventsPath, readEvents, readUsageSummary, sessionsDir, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry, UsageSummary } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { historyItems } from "../../src/main/history.ts";
import { checkEnglish } from "./english.ts";
import { done, EXPECTED, IDS, LISTED, seedFixtures, started, toEvent } from "./fixture.ts";

const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only"), append = process.argv.includes("--append");
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Usage: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/usage/check.ts");
  process.exit(2);
}
const exists = existsSync(resolve(home));
if (append) {
  if (!exists || !existsSync(eventsPath(resolve(home), IDS.C))) {
    console.error(`--append: there are no fixtures in ${resolve(home)}. First: ... check.ts --seed-only on a new empty folder.`);
    process.exit(2);
  }
} else if (exists && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const dir = realpathSync(resolve(home));
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };
const logger = createLogger(dir, "desktop", env);

const stub = <T>(v: T) => () => v;
const bridge = createBridge({
  listSessions: () => historyItems(dir, new Map(), new Set()), sessionExists: stub(false), sessionDrafts: stub([]),
  usageSummary: (from: string, to: string) => readUsageSummary(dir, from, to),
  watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }), send: () => {}, logger,
} as never);
type R = { ok: true; value: unknown } | { ok: false; error: string };
const answers: { action: string; json: string }[] = [];
const call = async (a: string, ...args: unknown[]): Promise<R> => {
  const r = (await bridge.call(a, args)) as R;
  answers.push({ action: a, json: JSON.stringify(r) });
  return r;
};
async function good<T>(a: string, ...args: unknown[]): Promise<T> {
  const r = await call(a, ...args);
  assert.ok(r.ok, `${a}: success expected, got: ${r.ok ? "" : r.error}`);
  return r.value as T;
}
async function bad(what: string, a: string, ...args: unknown[]): Promise<string> {
  const r = await call(a, ...args);
  assert.ok(!r.ok, `${what}: a rejection was expected`);
  return r.error;
}
const usage = (from: string, to: string) => good<UsageSummary>("usageSummary", from, to);
const grp = (s: UsageSummary, id: string | null) => s.groups.find((x) => x.providerId === id)!;
const hashes = () => Object.fromEntries(readdirSync(sessionsDir(dir)).sort().map((d) => [d, createHash("sha256").update(readFileSync(join(sessionsDir(dir), d, "events.jsonl"))).digest("hex")]));
// logs/ is the app's own log (written by the bridge logger), not part of the comparison
const files = (d = dir): string[] => readdirSync(d, { withFileTypes: true }).filter((e) => !(d === dir && e.name === "logs")).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)).map((f) => `${e.name}/${f}`) : [e.name])).sort();
const strip = (s: UsageSummary) => ({ from: s.from, to: s.to, groups: s.groups, total: s.total });

if (!append) {
  writeRegistry(ensureDataDir(dir), {
    providers: [], // empty registry: gone-llm is not there, like a provider removed from settings
    defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] },
  } as unknown as Registry);
  seedFixtures(dir);
  if (seedOnly) {
    console.log(`Data folder prepared: ${dir}`);
    for (const [id, h] of Object.entries(hashes())) console.log(`sha256 ${id}: ${h}`);
    console.log(`cd "${resolve(import.meta.dirname, "../../../..")}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" npm run desktop`);
    process.exit(0);
  }
}

if (append) {
  const moscowToday = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const before = await usage(moscowToday, moscowToday), hBefore = hashes();
  const evs = readEvents(dir, IDS.C)!.events;
  const turn = Math.max(...evs.map((e) => ("turn" in e ? e.turn : 0))) + 1;
  const now = () => new Date().toISOString();
  const seq = evs[evs.length - 1]!.seq;
  appendEvent(dir, IDS.C, toEvent({ ...started(now(), turn, "p1") }, seq + 1));
  appendEvent(dir, IDS.C, toEvent({ ...done(now(), turn, { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }, "p1") }, seq + 2));
  const after = await usage(moscowToday, moscowToday);
  const b0 = before.groups.find((x) => x.providerId === "beta"), b1 = grp(after, "beta");
  assert.equal(b1.inputTokens, (b0?.inputTokens ?? 0) + 100, "beta: input tokens");
  assert.equal(b1.outputTokens, (b0?.outputTokens ?? 0) + 50, "beta: output tokens");
  assert.ok(Math.abs((b1.costUsd ?? 0) - ((b0?.costUsd ?? 0) + 0.01)) < 1e-9, `beta: cost ${b0?.costUsd} -> ${b1.costUsd}`);
  assert.equal(b1.records, (b0?.records ?? 0) + 1, "beta: records");
  ok(`turn ${turn} of session C appended (seq ${seq + 1}–${seq + 2}); for ${moscowToday} beta grew by exactly 100 / 50 / 0.01 and one record`);
  const hAfter = hashes();
  for (const id of Object.keys(hBefore)) if (id !== IDS.C) assert.equal(hAfter[id], hBefore[id], `journal ${id} changed`);
  ok("journals of the other sessions did not change");
  // 15
checkEnglish(dir, s1, ok);

console.log(`Result: ${checks} checks, all passed; 0 real model calls; data folder ${dir}`);
  process.exit(0);
}

const hBefore = hashes(), filesBefore = files();
const P = EXPECTED;

// 1
const list = await good<{ id: string }[]>("listSessions");
assert.deepEqual(list.map((i) => i.id).sort(), [...LISTED].sort());
ok(`listSessions: ${list.length} sessions (${LISTED.join(", ")}), the unreadable ${IDS.E} is not included, no errors`);

// 2
const s1 = await usage(P.p1.from, P.p1.to);
assert.deepEqual(s1.groups, P.p1.groups);
assert.deepEqual(s1.total, P.p1.total);
ok("period 2026-10-09: groups and total match the EXPECTED table entirely");

// 3
assert.equal(grp(s1, "beta").inputTokens! - 40, 20, "turn 2 of session A for beta: 20 + 10, not 26/30+..."); // 60 = 40 (C, turn 1) + 20 (A, turn 2)
assert.equal(grp(s1, "beta").outputTokens, 10, "beta output: 10 of turn 2 A (the 6+4 of the failure are not added)");
const alpha1 = grp(s1, "alpha");
assert.equal(alpha1.inputTokens! + alpha1.outputTokens!, 28 + 2 + 7, "alpha: draft d1 B 16 + 12 = 28 (not 35), F 1 + 1, H 5 + 2");
ok("turn with a retry: 20 + 10 = 30, not 40 (attempt 6 + 4 not added); draft with a retry: 16 + 12 = 28, not 35 (attempt 4 + 3 not added)");

// 4
const s2 = await usage(P.p2.from, P.p2.to), s08 = await usage("2026-10-08", "2026-10-08");
assert.equal(s08.total.records, 1);
assert.deepEqual([grp(s08, "alpha").inputTokens, grp(s08, "alpha").outputTokens, grp(s08, "alpha").costUsd], [100, 50, 0.01]);
assert.equal(s08.groups.some((x) => x.providerId === "beta"), false, "21:00:00Z fell into 08.10");
assert.equal(s2.total.records, s1.total.records + 1);
assert.equal(grp(s2, "alpha").inputTokens, grp(s1, "alpha").inputTokens! + 100);
ok("day boundary: 20:59:59Z (turn 1 A) is 08.10 and is not in the 09.10 period; 21:00:00Z (turn 2 A) is 09.10 and is included; the 08.10–08.10 query gives exactly one record 100 / 50 / 0.01");

// 5
assert.equal(grp(s1, "gone-llm").costUsd, null);
assert.equal(grp(s1, "beta").costUsd, 0);
assert.equal(grp(s1, "beta").missing.costUsd, 1);
ok("unknown is not zero: gone-llm.costUsd null, beta.costUsd 0 (a reported zero) with missing.costUsd 1");

// 6
assert.deepEqual(s1.groups.map((x) => [x.providerId, x.openCalls]), [["alpha", 1], ["beta", 1], ["gone-llm", 1], [null, 0]]);
assert.equal(s1.total.openCalls, 3);
assert.deepEqual([grp(s1, "alpha").records, grp(s1, "alpha").inputTokens, grp(s1, "alpha").missing.costUsd], [4, 22, 2], "failures 2 and 3 of session H are not counted");
ok("calls without an outcome: gone-llm 1 (draft d2 of session B), beta 1 (turn 3 of session C); turn 2 of C is closed by the departure of p2; attempt 1 of turn 1 of session H without an event is a call without an outcome for alpha (alpha 1), failures 2 and 3 are counted (+5 / +2, two records)");

// 7
const mixed = grp(s1, null);
assert.deepEqual([mixed.inputTokens, mixed.outputTokens, mixed.records], [10, 8, 1]);
assert.ok(!(grp(s1, "alpha").inputTokens === 27 || grp(s1, "beta").inputTokens === 70), "the sum of the mixed slot ended up in alpha or beta");
ok("mixed slot (D, d1): one record 10 + 8 in group null; its sums are not in alpha or beta");

// 8
assert.ok(grp(s1, "gone-llm"), "no gone-llm group");
assert.equal(grp(s1, "gone-llm").records, 2);
ok("provider gone-llm, which is not in the registry, remains its own group (2 records of session C)");

// 9
const s3 = await usage(P.p3.from, P.p3.to);
assert.deepEqual(s2.groups, P.p2.groups); assert.deepEqual(s2.total, P.p2.total);
assert.deepEqual(s3.groups, P.p3.groups); assert.deepEqual(s3.total, P.p3.total);
assert.equal(s3.total.records, s2.total.records + 1);
assert.equal(grp(s3, "alpha").inputTokens, grp(s2, "alpha").inputTokens! + 7);
ok("periods 10-08…10-09 and 10-01…10-31 match EXPECTED; month boundary: turn 1 G (30.09 20:59:59Z) is not included, turn 2 G (21:00:00Z, 01.10) is included (+7 / +7 / +0.07)");

// 10
for (const s of [s1, s2, s3]) { assert.equal(s.unreadable, 1); assert.equal(s.truncated, 1); }
assert.ok(grp(s1, "alpha").records === 4 && grp(s1, "beta").records === 2);
ok("unreadable 1 (journal E) and truncated 1 (journal F) in every period; the other groups are counted, F (1 / 1 / 0) and H are counted in alpha");

// 11
const e1 = await bad("from > to", "usageSummary", "2026-10-10", "2026-10-09");
const e2 = await bad("format", "usageSummary", "09.10.2026", "2026-10-09");
const e3 = await bad("nonexistent date", "usageSummary", "2026-02-30", "2026-10-09");
for (const e of [e1, e2, e3]) assert.ok(e.length > 10);
ok(`bridge rejections with a reason: "${e1}" · "${e2}" · "${e3}"`);

// 12
assert.deepEqual(strip(await usage(P.p1.from, P.p1.to)), strip(s1));
ok("repeating the 2026-10-09 period request gives the same answer");

// 13
assert.deepEqual(hashes(), hBefore, "journals changed");
assert.deepEqual(files(), filesBefore, "the data folder file list changed");
ok(`reads change nothing: sha256 of ${Object.keys(hBefore).length} journals and the list of ${filesBefore.length} data folder files (without logs/) are the same`);

// 14
const forbidden: [string, string][] = [["data folder path", dir], ["COUNCIL_HOME path as given", resolve(home)], ["home folder", homedir()]];
for (const { action, json } of answers) for (const [what, v] of forbidden) assert.ok(!json.includes(JSON.stringify(v).slice(1, -1)) && !json.includes(v), `bridge answer ${action} contains ${what}`);
ok(`bridge answers checked: ${answers.length}, none contains the data folder path or the home folder`);

// 15
checkEnglish(dir, s1, ok);

console.log(`Result: ${checks} checks, all passed; 0 real model calls; data folder ${dir}`);
