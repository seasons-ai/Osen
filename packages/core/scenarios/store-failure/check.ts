// Live check of the store: a journal write failure in a running process and an unreadable journal of one session. Participants are scripted only, model calls 0.
//   COUNCIL_DEV=1 COUNCIL_HOME=<folder> node packages/core/scenarios/store-failure/check.ts
// Step 1: the journal write fails (events.jsonl read-only) in the middle of a session in this same process: status interrupted, not running;
//   the stop is rejected as interrupted; after the permissions are restored, resume brings the session to a result, the journal is appended.
// Step 2: two sessions have an unreadable journal (chmod 000 and a folder instead of a file): listSessions returns the others and calls onUnreadable exactly twice;
//   the real `council list` prints the readable ones with code 0, `council status <id>` of an unreadable one gives a nonzero code and a reason in stderr.
// Without COUNCIL_HOME the data folder is .council-data/store-failure-* inside the project and is deleted on success; a given COUNCIL_HOME is not deleted by the stand.
import "../language-ru.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  StopRejectedError, createScriptedDriver, createSession, ensureDataDir, eventsPath, listSessions, planResume, readSession,
  requestStop, resumeDrivers, runResumedSession, runStoredSession, stopRequestPath,
} from "../../src/index.ts";
import type { Registry } from "../../src/index.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("COUNCIL_DEV=1 is required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node packages/core/scenarios/store-failure/check.ts");
  process.exit(2);
}
const root = join(import.meta.dirname, "../../../..");
const own = !process.env.COUNCIL_HOME?.trim();
const home = own
  ? (mkdirSync(join(root, ".council-data"), { recursive: true }), mkdtempSync(join(root, ".council-data", "store-failure-")))
  : resolve(process.env.COUNCIL_HOME!);
const dataDir = ensureDataDir(home);
const models = [join(import.meta.dirname, "p1.json"), join(import.meta.dirname, "p2.json")];
const registry = { providers: [], defaults: {} } as unknown as Registry;
const isRoot = process.getuid?.() === 0;
const ok = (m: string) => console.log(`ok: ${m}`);

const newSession = () => createSession({
  topic: "Как назвать кота", framing: "", origin: "cli", materials: [],
  participants: models.map((model, i) => ({ name: `Участник ${i + 1}`, providerId: "scripted", model, role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 24000, materialsChars: 24000 },
}, { maxParticipants: 8 });
const freshDrivers = () => Object.fromEntries(models.map((m, i) => [`p${i + 1}`, createScriptedDriver(JSON.parse(readFileSync(m, "utf8")), process.env)]));
async function finished(): Promise<string> {
  const s = newSession();
  const r = await runStoredSession({ session: s, drivers: freshDrivers(), dataDir });
  assert.equal(r.state.finish?.status, "consensus");
  return s.id;
}

// Makes the journal unreadable/unwritable; returns the restore function. root is not limited by permissions, so a folder instead of a file is used then.
function breakJournal(id: string, mode: "ro" | "none" | "dir"): () => void {
  const p = eventsPath(dataDir, id);
  if (mode === "dir" || isRoot) {
    renameSync(p, `${p}.orig`);
    mkdirSync(p);
    return () => { rmdirSync(p); renameSync(`${p}.orig`, p); };
  }
  chmodSync(p, mode === "ro" ? 0o444 : 0o000);
  return () => chmodSync(p, 0o644);
}

const restores: (() => void)[] = [];
try {
  // Step 1
  const a = newSession();
  let restoreA: (() => void) | null = null;
  let controlRunning = false;
  const failure = await runStoredSession({
    session: a, drivers: freshDrivers(), dataDir,
    onEvent: () => {
      if (restoreA === null) {
        controlRunning = readSession(dataDir, a.id)?.status === "running";
        restoreA = breakJournal(a.id, "ro");
        restores.push(restoreA);
      }
    },
  }).then(() => null, (e: unknown) => e);
  assert.ok(failure instanceof Error, "runStoredSession was expected to fail on a journal write failure");
  assert.ok(controlRunning, "control: while the session runs, the status is running");
  ok("control: the running session is running; the journal write failed, runStoredSession rejected");
  assert.equal(readSession(dataDir, a.id)?.status, "interrupted", "readSession after the failure");
  assert.equal(listSessions(dataDir).find((s) => s.id === a.id)?.status, "interrupted", "listSessions after the failure");
  ok("readSession and listSessions: interrupted, although the pid is this process");
  let planErr: unknown = null;
  try { planResume(dataDir, a.id, { rounds: 2 }); } catch (e) { planErr = e; }
  assert.ok(!(planErr as { reason?: string } | null)?.reason || (planErr as { reason: string }).reason !== "running", `planResume rejected with reason running: ${(planErr as Error | null)?.message}`);
  ok("planResume does not reject with reason running");
  assert.throws(() => requestStop(dataDir, a.id), (e) => e instanceof StopRejectedError && e.reason === "interrupted");
  assert.ok(!existsSync(stopRequestPath(dataDir, a.id)), "the stop request file must not appear");
  ok("requestStop: StopRejectedError interrupted, no request file");

  restoreA!();
  restores.pop();
  const before = readFileSync(eventsPath(dataDir, a.id));
  const plan = planResume(dataDir, a.id, { rounds: 2 });
  const { drivers } = await resumeDrivers(plan, { registry, env: process.env, dataDir });
  const resumed = await runResumedSession({ dataDir, plan, drivers });
  assert.equal(resumed.state.finish?.status, "consensus", "resume must reach a result");
  const after = readFileSync(eventsPath(dataDir, a.id));
  assert.ok(after.length > before.length && after.subarray(0, before.length).equals(before), "the journal must be appended, not rewritten");
  assert.ok(after.toString("utf8").includes('"session_resumed"'), "no session_resumed");
  assert.equal(readSession(dataDir, a.id)?.status, "consensus");
  ok(`resume brought the session to a result; the journal is appended (${before.length} -> ${after.length} bytes), session_resumed present`);

  // Step 2
  const good = await finished();
  const b = await finished(), c = await finished();
  restores.push(breakJournal(b, "none"), breakJournal(c, "dir"));
  const bad: string[] = [];
  const listed = listSessions(dataDir, undefined, (id) => bad.push(id)).map((s) => s.id).sort();
  assert.deepEqual(listed, [a.id, good].sort(), "listSessions must return only the readable ones");
  assert.deepEqual([...bad].sort(), [b, c].sort(), "onUnreadable for exactly the two unreadable ones");
  ok("listSessions: readable ones returned, onUnreadable called for exactly the two unreadable ones");

  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_HOME: home, COUNCIL_DEV: "1" };
  const council = (...args: string[]) => spawnSync(process.execPath, [join(root, "packages/core/src/council.ts"), ...args], { env, cwd: root, encoding: "utf8", input: "" });
  const list = council("list");
  assert.equal(list.status, 0, `council list: code ${list.status}\n${list.stderr}`);
  for (const id of [a.id, good]) assert.ok(list.stdout.includes(id), `council list did not show ${id}`);
  for (const id of [b, c]) assert.ok(!list.stdout.includes(id), `council list showed the unreadable ${id}`);
  ok("council list: code 0, readable ones shown, unreadable ones skipped");
  for (const id of [b, c]) {
    const st = council("status", id);
    assert.ok(st.status !== 0 && st.status !== null, `council status ${id}: expected a nonzero code, got ${st.status}`);
    assert.ok(st.stderr.trim().length > 0, `council status ${id}: no reason in stderr`);
  }
  ok("council status of an unreadable one: nonzero code and a reason in stderr");
} catch (e) {
  console.error(`FAIL: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  for (const r of restores.reverse()) { try { r(); } catch { /* already restored */ } }
}
if (!process.exitCode) {
  console.log("Real model calls: 0");
  console.log("PASS");
  if (own) rmSync(home, { recursive: true, force: true });
}
