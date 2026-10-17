// Check of the owner picking an existing version.
//   Mode 1 (stand and core): COUNCIL_DEV=1 node packages/core/scenarios/owner-choice/check.ts
//   Mode 2 (after manual actions in the app): COUNCIL_DEV=1 node packages/core/scenarios/owner-choice/check.ts --after-gui "<stand>" [--events <n>]
// Mode 1 writes only to a new .council-data-owner-choice-<time> folder inside the repository and does not delete it. No models are called.
import "../language-ru.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INITIAL_MATERIALS, OwnerSelectionRejectedError, ResumeRejectedError, collectMaterials, createScriptedDriver, createSession, ensureDataDir,
  eventsPath, materialsDir, planResume, readEvents, readScenario, readSession, resumeDrivers, resumeLockPath, runResumedSession,
  runStoredSession, selectOwnerVersion,
} from "../../src/index.ts";
import type { CollectedMaterial, ParticipantDriver, Registry } from "../../src/index.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Scripted participants are available only with COUNCIL_DEV=1. Usage: COUNCIL_DEV=1 node packages/core/scenarios/owner-choice/check.ts");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const ok = (s: string) => console.log(`✓ ${s}`);
const journal = (dir: string, id: string) => readFileSync(eventsPath(dir, id));
const lockOf = (dir: string, id: string) => existsSync(resumeLockPath(dir, id));
const turnStarts = (dir: string, id: string) => readEvents(dir, id)!.events.filter((e) => e.type === "turn_started").length;
const selEvents = (dir: string, id: string) => readEvents(dir, id)!.events.filter((e) => e.type === "owner_selected_version") as any[];
const session = (dir: string, id: string) => readSession(dir, id)!;
const materialHashes = (dir: string, id: string): Record<string, string> => {
  const d = materialsDir(dir, id);
  return Object.fromEntries(readdirSync(d).sort().map((f) => [f, sha(readFileSync(join(d, f)))]));
};

// ---------- Mode 2 ----------
const argv = process.argv.slice(2);
const afterAt = argv.indexOf("--after-gui");
if (afterAt >= 0) {
  const stand = argv[afterAt + 1];
  if (!stand) { console.error("Specify the stand path: --after-gui \"<path>\""); process.exit(2); }
  const evAt = argv.indexOf("--events");
  const expected = evAt >= 0 ? Number(argv[evAt + 1]) : 1;
  if (!Number.isInteger(expected) || expected < 0) { console.error("--events: an integer not less than 0"); process.exit(2); }
  try {
    const m = JSON.parse(readFileSync(join(stand, "owner-choice-manifest.json"), "utf8"));
    const dir = stand;
    const gui = m.gui.id as string;
    const bytes = journal(dir, gui);
    assert.ok(bytes.length >= m.gui.journalBytes, "the GUI session journal is shorter than it was");
    assert.equal(sha(bytes.subarray(0, m.gui.journalBytes)), m.gui.journalSha256, "the GUI session journal prefix changed");
    ok(`GUI session journal: the first ${m.gui.journalBytes} bytes are unchanged (sha256 matches)`);
    const tail = bytes.subarray(m.gui.journalBytes).toString("utf8");
    const added = tail.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(added.length, expected, `${added.length} events after the prefix instead of ${expected}`);
    for (const e of added) assert.equal(e.type, "owner_selected_version", `after the prefix the event is ${e.type}, not owner_selected_version`);
    assert.ok(tail === "" || tail.endsWith("\n"), "the journal ends with an incomplete record");
    ok(`exactly ${expected} events after the prefix, all owner_selected_version`);
    for (const e of added) console.log(`  selection: version ${e.version}, status at selection ${e.statusAtSelection}, note ${JSON.stringify(e.note ?? null)}, ts ${e.ts}`);
    assert.equal(turnStarts(dir, gui), m.gui.turnStarted, "the number of turn_started changed");
    ok(`turn_started in the GUI session is unchanged (${m.gui.turnStarted}): participants were not called`);
    assert.deepEqual(materialHashes(dir, gui), m.gui.materials, "materials/ files of the GUI session changed");
    ok(`materials/ files of the GUI session are unchanged (${Object.keys(m.gui.materials).length})`);
    const s = session(dir, gui);
    assert.equal(s.status, "no_consensus");
    assert.equal(s.state.finish?.version, 3, "the final version is not 3");
    const last = added.at(-1);
    if (last) assert.deepEqual(s.state.ownerSelection, { version: last.version, statusAtSelection: last.statusAtSelection, note: last.note ?? null, ts: last.ts });
    else assert.equal(s.state.ownerSelection, null);
    ok(`readSession: status no_consensus, final version 3, ownerSelection ${last ? `= version ${last.version}` : "= null"}`);
    const old = m.old.id as string;
    assert.equal(sha(journal(dir, old)), m.old.journalSha256, "the old session journal changed");
    assert.equal(session(dir, old).state.ownerSelection, null);
    ok("old session: journal unchanged, ownerSelection === null");
    assert.ok(!lockOf(dir, gui), "resume.lock was left in the GUI session");
    ok("no resume.lock in the GUI session");
    console.log("Post-app check passed.");
  } catch (e) {
    console.error(`FAILED: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

// ---------- Mode 1 ----------
const pad = (n: number) => String(n).padStart(2, "0");
const d0 = new Date();
const stamp = `${d0.getFullYear()}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}-${pad(d0.getHours())}${pad(d0.getMinutes())}${pad(d0.getSeconds())}`;
const standPath = join(repoRoot, `.council-data-owner-choice-${stamp}`);
mkdirSync(standPath);
const dataDir = ensureDataDir(realpathSync(standPath));
const P = [1, 2, 3].map((i) => join(here, `p${i}.json`));
const FAIL = join(here, "fail.json");
const opts = { materialsChars: INITIAL_MATERIALS.materialsChars, materialsIgnore: INITIAL_MATERIALS.materialsIgnore };
const originals: CollectedMaterial[] = collectMaterials([join(here, "brief.md")], opts).materials;
const registry = { providers: [], defaults: {} } as unknown as Registry;

let calls = 0;
const count = (d: ParticipantDriver): ParticipantDriver => ({ async call(r) { calls++; return d.call(r); } });

async function create(models: string[]): Promise<string> {
  const s = createSession({
    topic: "Как вести еженедельную планёрку команды.", framing: "", origin: "cli", materials: originals,
    participants: models.map((model, i) => ({ name: `Участник ${i + 1}`, providerId: "scripted", model, role: null })),
    limits: { maxRounds: 2, turnTimeoutSec: 30, contextChars: 24000, materialsChars: INITIAL_MATERIALS.materialsChars },
  }, { maxParticipants: 8 });
  const drivers: Record<string, ParticipantDriver> = {};
  for (const [i, m] of models.entries()) drivers[`p${i + 1}`] = count(createScriptedDriver(await readScenario(m), process.env));
  await runStoredSession({ session: s, drivers, dataDir, materials: originals });
  return s.id;
}
const reasonOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) {
    assert.ok(e instanceof OwnerSelectionRejectedError, `expected OwnerSelectionRejectedError, got: ${e}`);
    return e.reason + "|" + e.message;
  }
  throw new Error("a rejection was expected");
};
// Selection with a check: no participant calls were added.
const select = (id: string, version: number, note?: string | null) => {
  const before = calls;
  try { return selectOwnerVersion(dataDir, id, { version, note }); } finally { assert.equal(calls, before, "the selection called a participant"); }
};
const refuse = (id: string, version: number, reason: string, note?: string | null) => {
  const bytes = journal(dataDir, id);
  const before = calls;
  const r = reasonOf(() => selectOwnerVersion(dataDir, id, { version, note }));
  assert.equal(r.split("|")[0], reason, `rejection ${r}, expected ${reason}`);
  assert.equal(calls, before, "the rejection called a participant");
  assert.ok(journal(dataDir, id).equals(bytes), "the rejection changed the journal");
  assert.ok(existsSync(eventsPath(dataDir, id)) && !lockOf(dataDir, id), "a lock was left after the rejection");
  return r.split("|").slice(1).join("|");
};

const GUI = await create(P), OLD = await create(P), CORE = await create(P), RACE_A = await create(P), RACE_B = await create(P);
const FAILED = await create([FAIL, FAIL, FAIL]);
const BROKEN = await create(P);
appendFileSync(eventsPath(dataDir, BROKEN), '{"seq":99,"ts":"2026');

// 1. Outcome
for (const [name, id] of [["GUI", GUI], ["OLD", OLD], ["CORE", CORE], ["RACE-A", RACE_A], ["RACE-B", RACE_B]] as const) {
  const s = session(dataDir, id);
  assert.equal(s.status, "no_consensus", `${name}: status ${s.status}`);
  assert.equal(s.state.versions.length, 3);
  assert.equal(s.state.finish?.version, 3);
  assert.deepEqual(s.state.finish?.agreed, ["p2", "p3"]);
  assert.equal(s.state.finish?.objectors.length, 1);
  assert.equal(s.state.finish?.objectors[0]?.participantId, "p1");
  assert.ok(s.state.finish?.objectors[0]?.reasoning?.includes("Возражаю"), `${name}: no objector argument`);
  assert.equal(s.state.ownerSelection, null);
}
ok("GUI, OLD, CORE, RACE-A, RACE-B: no_consensus, three versions, final 3, p2 and p3 agree, p1 objects with an argument, ownerSelection === null");
const f = session(dataDir, FAILED);
assert.equal(f.status, "failed");
assert.deepEqual(f.state.versions, []);
assert.equal(session(dataDir, BROKEN).status, "no_consensus");
ok("FAILED: failed, no versions; BROKEN: no_consensus before the appended truncation");

const guiBytes = journal(dataDir, GUI), oldBytes = journal(dataDir, OLD);
const manifest = {
  gui: { id: GUI, journalBytes: guiBytes.length, journalSha256: sha(guiBytes), materials: materialHashes(dataDir, GUI), turnStarted: turnStarts(dataDir, GUI) },
  old: { id: OLD, journalBytes: oldBytes.length, journalSha256: sha(oldBytes), materials: materialHashes(dataDir, OLD) },
  callsAfterCreate: calls,
};
assert.ok(Object.keys(manifest.gui.materials).length >= 1, "no material snapshots");
const callsAfterCreate = calls;
ok(`participant call counter recorded after the sessions were created: ${callsAfterCreate}`);

// 3. CORE: selecting version 1 with a note
const matCore = materialHashes(dataDir, CORE);
const coreBefore = journal(dataDir, CORE);
const finishBefore = JSON.stringify(session(dataDir, CORE).state.finish);
const r1 = select(CORE, 1, "Беру первую: она короче всех.");
const coreAfter = journal(dataDir, CORE);
assert.ok(coreAfter.subarray(0, coreBefore.length).equals(coreBefore), "the previous journal bytes are not a prefix");
const added1 = coreAfter.subarray(coreBefore.length).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
assert.equal(added1.length, 1);
assert.equal(added1[0].type, "owner_selected_version");
assert.equal(added1[0].version, 1);
assert.equal(added1[0].statusAtSelection, "no_consensus");
assert.equal(added1[0].note, "Беру первую: она короче всех.");
assert.deepEqual(r1, { version: 1, statusAtSelection: "no_consensus", note: "Беру первую: она короче всех.", ts: added1[0].ts });
const sc = session(dataDir, CORE);
assert.equal(sc.status, "no_consensus");
assert.equal(JSON.stringify(sc.state.finish), finishBefore);
assert.equal(sc.state.versions.length, 3);
assert.deepEqual(sc.state.ownerSelection, r1);
assert.deepEqual(materialHashes(dataDir, CORE), matCore);
assert.ok(!lockOf(dataDir, CORE));
ok("CORE: selecting version 1 with a note — one event, journal prefix, status and result unchanged, three versions, material snapshots unchanged, no lock");

// 4. Repeat and restart
const sizeBefore = journal(dataDir, CORE).length;
const r1b = select(CORE, 1, "Беру первую: она короче всех.");
assert.deepEqual(r1b, r1);
assert.equal(journal(dataDir, CORE).length, sizeBefore);
assert.deepEqual(session(dataDir, CORE).state.ownerSelection, r1);
ok("CORE: repeating the same selection added no events; after reading from disk the selection is the same");

// 5. A different selection
const prefix = journal(dataDir, CORE);
const r2 = select(CORE, 2, "Передумал: вторая подробнее.");
assert.equal(r2.version, 2);
const evs = selEvents(dataDir, CORE);
assert.equal(evs.length, 2);
assert.equal(evs[0].version, 1);
assert.ok(journal(dataDir, CORE).subarray(0, prefix.length).equals(prefix), "the first selection event changed");
assert.deepEqual(session(dataDir, CORE).state.ownerSelection, r2);
ok("CORE: a different selection (version 2) — second event, both in the journal, the first unchanged, ownerSelection.version === 2");

// 6. Rejections
{
  const ghost = "net-takoj-sessii";
  assert.equal(reasonOf(() => selectOwnerVersion(dataDir, ghost, { version: 1 })).split("|")[0], "not_found");
  assert.ok(!existsSync(join(dataDir, "sessions", ghost)), "the rejection created a session folder");
}
ok("rejection not_found: unknown id, session folder not created");
refuse(CORE, 99, "unknown_version");
ok("rejection unknown_version: version 99, journal and lock unchanged");
const msg = refuse(FAILED, 1, "unknown_version");
assert.ok(msg.includes("нет ни одной версии"), `message: ${msg}`);
ok(`rejection unknown_version for FAILED: "${msg}"`);
refuse(BROKEN, 1, "corrupted");
ok("rejection corrupted: truncated record at the end of the BROKEN journal");
refuse(CORE, 1, "bad_note", "я".repeat(2001));
ok("rejection bad_note: a 2001-character note");

// 7. RACE-A: resume goes first
const planA = planResume(dataDir, RACE_A, { rounds: 1 });
const { drivers: dA } = await resumeDrivers(planA, { registry, env: process.env, dataDir });
const wrappedA = Object.fromEntries(Object.entries(dA).map(([k, d]) => [k, count(d)]));
const beforeRunA = journal(dataDir, RACE_A);
const runA = runResumedSession({ dataDir, plan: planA, drivers: wrappedA });
for (let i = 0; i < 250 && !lockOf(dataDir, RACE_A); i++) await new Promise((r) => setTimeout(r, 20));
assert.ok(lockOf(dataDir, RACE_A), "the resume did not take the lock");
await new Promise((r) => setTimeout(r, 300));
const midBytes = journal(dataDir, RACE_A).length;
const rA = reasonOf(() => selectOwnerVersion(dataDir, RACE_A, { version: 1, note: "во время продолжения" })).split("|")[0]!;
assert.ok(rA === "running" || rA === "busy", `rejection ${rA}`);
assert.equal(journal(dataDir, RACE_A).length, midBytes, "the rejection changed the journal");
assert.ok(lockOf(dataDir, RACE_A), "the resume lock was released by the rejection");
const resA = await runA;
assert.equal(resA.state.finish?.status, "consensus");
assert.equal(selEvents(dataDir, RACE_A).length, 0);
const afterA = journal(dataDir, RACE_A);
assert.ok(afterA.subarray(0, beforeRunA.length).equals(beforeRunA));
assert.ok(readEvents(dataDir, RACE_A)!.events.some((e) => e.type === "session_resumed"));
assert.ok(!lockOf(dataDir, RACE_A));
ok(`RACE-A: selection during resume rejected (${rA}), no selection event, resume finished normally (consensus), lock released`);

// 8. RACE-B: selection goes first
const stalePlan = planResume(dataDir, RACE_B, { rounds: 1 });
const rB = select(RACE_B, 3, "Версия 3 — потом продолжим.");
const selBytes = journal(dataDir, RACE_B);
const staleDrivers = (await resumeDrivers(stalePlan, { registry, env: process.env, dataDir })).drivers;
await assert.rejects(runResumedSession({ dataDir, plan: stalePlan, drivers: staleDrivers }), (e) => e instanceof ResumeRejectedError && e.reason === "busy");
assert.ok(journal(dataDir, RACE_B).equals(selBytes), "the rejected plan changed the journal");
assert.ok(!lockOf(dataDir, RACE_B));
ok("RACE-B: a plan taken before the selection is rejected with busy, journal unchanged, lock released");
const planB = planResume(dataDir, RACE_B, { rounds: 1 });
const dB = Object.fromEntries(Object.entries((await resumeDrivers(planB, { registry, env: process.env, dataDir })).drivers).map(([k, d]) => [k, count(d)]));
const resB = await runResumedSession({ dataDir, plan: planB, drivers: dB });
assert.equal(resB.state.finish?.status, "consensus");
assert.ok(journal(dataDir, RACE_B).subarray(0, selBytes.length).equals(selBytes), "the journal before the selection is not a prefix of the final one");
const sB = session(dataDir, RACE_B);
assert.deepEqual(sB.state.ownerSelection, rB);
assert.equal(sB.status, "consensus");
assert.equal(selEvents(dataDir, RACE_B).length, 1);
ok("RACE-B: selection, then a fresh plan and resume passed; the journal before the selection is a prefix; ownerSelection unchanged (ts and statusAtSelection), current status consensus");

// 9. OLD and GUI
assert.ok(journal(dataDir, OLD).equals(oldBytes));
assert.equal(session(dataDir, OLD).state.ownerSelection, null);
ok("OLD: journal byte-identical, ownerSelection === null");
assert.ok(journal(dataDir, GUI).equals(guiBytes));
assert.deepEqual(materialHashes(dataDir, GUI), manifest.gui.materials);
ok("GUI: journal and material snapshots unchanged");

// Counter: calls were made only by creating sessions and by two resumes.
ok(`participant calls: ${callsAfterCreate} after creation, ${calls} in total (the increase is only the RACE-A and RACE-B resumes; no selection operation called participants)`);
writeFileSync(join(dataDir, "owner-choice-manifest.json"), JSON.stringify({ ...manifest, totalCalls: calls }, null, 2) + "\n");
console.log(`\nStand: ${dataDir}`);
console.log(`GUI session: ${GUI}`);
console.log(`Old session: ${OLD}`);
console.log(`Post-app check: COUNCIL_DEV=1 node packages/core/scenarios/owner-choice/check.ts --after-gui "${dataDir}"`);
