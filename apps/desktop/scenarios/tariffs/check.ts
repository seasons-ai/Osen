// Check of the tariff-based spend estimate: the real app bridge and the core (readUsageSummary) on fixture journals and a local tariffs.json, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/tariffs/check.ts
//   ... --seed-only   only prepare the folder for the app window
// Writes only to COUNCIL_HOME (journals and tariffs.json) and does not remove it. No models are called, no network is used.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger, ensureDataDir, readUsageSummary, sessionsDir, tariffsPath, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry, UsageSummary } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { historyItems } from "../../src/main/history.ts";
import { checkEnglish } from "../usage/english.ts";
import { seedJournals, V1, writeTariffs } from "./fixture.ts";

const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only");
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/tariffs/check.ts");
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
const logger = createLogger(dir, "desktop", env);

// network: counters are attached before the first request, the originals are called as before
let netCalls = 0;
const origConnect = net.Socket.prototype.connect, origFetch = globalThis.fetch;
net.Socket.prototype.connect = function (this: net.Socket, ...a: never[]) { netCalls++; return (origConnect as (...x: unknown[]) => net.Socket).apply(this, a); } as never;
globalThis.fetch = ((...a: Parameters<typeof fetch>) => { netCalls++; return origFetch(...a); }) as typeof fetch;

const stub = <T>(v: T) => () => v;
const bridge = createBridge({
  listSessions: () => historyItems(dir, new Map(), new Set()), sessionExists: stub(false), sessionDrafts: stub([]),
  usageSummary: (from: string, to: string) => readUsageSummary(dir, from, to),
  watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }), send: () => {}, logger,
} as never);
type R = { ok: true; value: unknown } | { ok: false; error: string };
const answers: { action: string; json: string }[] = [];
const usage = async (from = "2026-10-09", to = "2026-10-09"): Promise<UsageSummary> => {
  const r = (await bridge.call("usageSummary", [from, to])) as R;
  answers.push({ action: "usageSummary", json: JSON.stringify(r) });
  assert.ok(r.ok, `usageSummary: success expected, got: ${r.ok ? "" : r.error}`);
  return r.value as UsageSummary;
};
const grp = (s: UsageSummary, id: string | null) => s.groups.find((x) => x.providerId === id)!;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const hashes = () => Object.fromEntries(readdirSync(sessionsDir(dir)).sort().map((d) => [d, sha(join(sessionsDir(dir), d, "events.jsonl"))]));
// logs/ is the app log (written by the bridge logger); tariffs.json is checked separately
const files = (d = dir): string[] => readdirSync(d, { withFileTypes: true }).filter((e) => !(d === dir && (e.name === "logs" || e.name === "tariffs.json"))).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)).map((f) => `${e.name}/${f}`) : [e.name])).sort();
const strip = (s: UsageSummary) => ({ from: s.from, to: s.to, groups: s.groups.map(({ estimate, ...g }) => g), total: (({ estimate, ...t }) => t)(s.total) });
const near = (a: number | null, b: number, what: string) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${what}: expected ${b}, got ${a}`);
const skipped = (s: { estimate: { skipped: Record<string, number> } | null }) => s.estimate!.skipped;
const cur = (s: { estimate: { byCurrency: { currency: string; amount: number; records: number }[] } | null }) => s.estimate!.byCurrency;

writeRegistry(ensureDataDir(dir), {
  providers: [],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] },
} as unknown as Registry);
seedJournals(dir);
writeTariffs(dir, V1);
const tp = tariffsPath(dir), cfgPath = join(dir, "config.json");
const cfgHash = () => (existsSync(cfgPath) ? sha(cfgPath) : "no file");
if (seedOnly) {
  console.log(`Data folder prepared: ${dir}`);
  for (const [id, h] of Object.entries(hashes())) console.log(`sha256 ${id}: ${h}`);
  console.log(`sha256 tariffs.json: ${sha(tp)}`);
  console.log(`cd "${resolve(import.meta.dirname, "../../../..")}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" npm run desktop`);
  process.exit(0);
}

const hBefore = hashes(), filesBefore = files(), cfgBefore = cfgHash();

// 1
const s1 = await usage();
const base = strip(s1);
const L = grp(s1, "local-llm");
assert.equal(L.costUsd, 3);
assert.deepEqual(cur(L), [{ currency: "USD", amount: 4, records: 1 }]);
const applied = s1.tariffs.applied.find((x) => x.providerId === "local-llm")!;
assert.equal(applied.source, "Локальная проверочная fixture");
assert.equal(applied.asOf, "2026-10-09");
ok("version 1: local-llm reports 3 USD (costUsd 3) and a separate estimate of 4 USD; applied has the source \"Локальная проверочная fixture\", date 2026-10-09");

// 2
assert.deepEqual([L.records, L.inputTokens, L.outputTokens, L.missing.outputTokens, L.missing.costUsd], [3, 1005900, 500100, 1, 2]);
assert.deepEqual(skipped(L), { no_model: 0, default_model: 0, no_tariff: 1, no_split: 1 });
const E = grp(s1, "eu-llm"), C = grp(s1, "claude"), N = grp(s1, null);
assert.equal(E.records, 1); assert.equal(E.costUsd, null);
assert.deepEqual(cur(E), [{ currency: "EUR", amount: 0.5, records: 1 }]);
assert.deepEqual(skipped(E), { no_model: 0, default_model: 0, no_tariff: 0, no_split: 0 });
assert.equal(C.records, 1); near(C.costUsd, 0.421, "claude.costUsd");
assert.deepEqual(cur(C), []); assert.deepEqual(skipped(C), { no_model: 0, default_model: 1, no_tariff: 0, no_split: 0 });
assert.equal(N.records, 1); assert.deepEqual(cur(N), []); assert.deepEqual(skipped(N), { no_model: 1, default_model: 0, no_tariff: 0, no_split: 0 });
assert.equal(s1.groups.length, 4);
assert.equal(s1.total.records, 6); near(s1.total.costUsd, 3.421, "total.costUsd");
assert.deepEqual(cur(s1.total), [{ currency: "EUR", amount: 0.5, records: 1 }, { currency: "USD", amount: 4, records: 1 }]);
assert.deepEqual(skipped(s1.total), { no_model: 1, default_model: 1, no_tariff: 1, no_split: 1 });
assert.equal(s1.tariffs.state, "loaded"); assert.deepEqual(s1.tariffs.warnings, []);
assert.deepEqual(s1.tariffs.applied.map((x) => [x.providerId, x.model]), [["eu-llm", "mistral-small"], ["local-llm", "qwen3-coder"]]);
ok("version 1: skips by reason (local-llm: no tariff 1, no split 1; claude: default 1; record without a model: 1), EUR separate from USD (two items in the total, no common sum), applied without a tariff for default");

// 3
const s08 = await usage("2026-10-08", "2026-10-08");
assert.equal(s08.total.records, 0); assert.deepEqual(s08.tariffs.applied, []);
ok("period 2026-10-08 without records: records 0, applied is empty");

// 4
writeTariffs(dir, [t2(), V1[1], V1[2]]);
function t2() { return { ...V1[0], source: "Локальная проверочная fixture, новая цена", asOf: "2026-10-12", inputPerMillion: 3, outputPerMillion: 6 }; }
const s4 = await usage();
assert.deepEqual(cur(grp(s4, "local-llm")), [{ currency: "USD", amount: 6, records: 1 }]);
const a4 = s4.tariffs.applied.find((x) => x.providerId === "local-llm")!;
assert.equal(a4.source, "Локальная проверочная fixture, новая цена"); assert.equal(a4.asOf, "2026-10-12");
assert.deepEqual(strip(s4), base, "the tariff change altered the reported part");
assert.deepEqual(hashes(), hBefore);
ok("version 2 (prices 3 and 6): the local-llm estimate became 6 USD, applied has the new source and date 2026-10-12; the reported part of the summary and the journal sha256 are the same");

// 5
writeTariffs(dir, [{ ...V1[0], inputPerMillion: -1 }, V1[1], V1[2]]);
const tBefore = sha(tp);
const s5 = await usage();
assert.deepEqual(s5.tariffs.warnings, ["tariffs.json: запись 1 не применяется — inputPerMillion: конечное число не меньше 0"]);
assert.deepEqual(cur(grp(s5, "local-llm")), []);
assert.equal(skipped(grp(s5, "local-llm")).no_tariff, 3);
assert.deepEqual(cur(grp(s5, "eu-llm")), [{ currency: "EUR", amount: 0.5, records: 1 }]);
assert.deepEqual(strip(s5), base);
assert.equal(sha(tp), tBefore, "reading changed tariffs.json");
ok("invalid price: exactly one warning, local-llm has no estimate (3 records in no_tariff), eu-llm is still 0.5 EUR, the reported part is unchanged, tariffs.json is unchanged");

// 6
writeTariffs(dir, [{ ...V1[0], asOf: "2026-02-30" }, V1[1], V1[2]]);
const s6 = await usage();
assert.deepEqual(s6.tariffs.warnings, ["tariffs.json: запись 1 не применяется — asOf: дата ГГГГ-ММ-ДД"]);
assert.deepEqual(strip(s6), base);
ok("invalid date 2026-02-30: exactly one warning about asOf, the summary is not broken");

// 7
writeFileSync(tp, "{ \"tariffs\": [");
const tBad = sha(tp);
const s7 = await usage();
assert.equal(s7.tariffs.state, "unreadable"); assert.deepEqual(s7.tariffs.warnings, ["tariffs.json: не JSON"]);
assert.equal(s7.total.estimate, null); assert.ok(s7.groups.every((g) => g.estimate === null));
assert.deepEqual(strip(s7), strip({ ...s1, total: { ...s1.total }, groups: s1.groups }));
assert.equal(sha(tp), tBad);
ok("file is not JSON: state unreadable, warning \"tariffs.json: не JSON\", estimate null for the total and all groups, the reported part is unchanged, the file bytes are unchanged");

// 8
rmSync(tp);
const s8 = await usage();
assert.equal(s8.tariffs.state, "absent"); assert.deepEqual(s8.tariffs.warnings, []);
assert.equal(s8.total.estimate, null); assert.ok(s8.groups.every((g) => g.estimate === null));
assert.deepEqual(strip(s8), base);
assert.equal(existsSync(tp), false, "the tariffs file appeared");
ok("no file: state absent, no warnings, estimate null, the reported part is unchanged, the file did not appear after the request");

// 9
assert.equal(netCalls, 0, `network calls: ${netCalls}`);
net.Socket.prototype.connect = origConnect; globalThis.fetch = origFetch;
ok("network: net.Socket.connect and fetch were never called");

// 10
assert.equal(cfgHash(), cfgBefore, "config.json changed");
assert.deepEqual(hashes(), hBefore, "journals changed");
assert.deepEqual(files(), filesBefore, "the file list of the data folder changed");
ok(`disk: config.json (${cfgBefore === "no file" ? "does not exist" : "same sha256"}), sha256 of ${Object.keys(hBefore).length} journals and the list of ${filesBefore.length} files (excluding logs/ and tariffs.json) are the same`);

// 11
const forbidden: [string, string][] = [["data folder path", dir], ["COUNCIL_HOME path as given", resolve(home)], ["home folder", homedir()]];
for (const { action, json } of answers) for (const [what, v] of forbidden) assert.ok(!json.includes(JSON.stringify(v).slice(1, -1)) && !json.includes(v), `bridge response ${action} contains ${what}`);
ok(`bridge responses checked: ${answers.length}, none contains the data folder path or the home folder`);

// 12
checkEnglish(dir, s1, ok);

writeTariffs(dir, V1);
console.log(`Result: ${checks} checks, all passed; real model calls 0; network calls 0; data folder ${dir}`);
