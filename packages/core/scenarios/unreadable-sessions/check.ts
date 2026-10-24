// Live check: `council list` names sessions it skips because the journal cannot be read. Real council process, scripted participants, model calls 0.
//   COUNCIL_DEV=1 node packages/core/scenarios/unreadable-sessions/check.ts
// A healthy; B events.jsonl is `garbage`; C events.jsonl is chmod 000; D folder without events.jsonl; E empty events.jsonl.
// `council list` on en and ru: stdout only A, code 0, stderr exactly two lines (B, C) in the run language, nothing about D/E, two error records in logs/app.log per run.
// `council list --json` on en and ru is byte-equal to the document of a data folder without B and C.
// The copy without B and C is <data folder>-clean and is deleted by the stand.
// Without COUNCIL_HOME the data folder is .council-data/unreadable-sessions-check-* inside the project and is deleted on success.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createScriptedDriver, createSession, ensureDataDir, eventsPath, runStoredSession, sessionDir } from "../../src/index.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("COUNCIL_DEV=1 is required. Run: COUNCIL_DEV=1 node packages/core/scenarios/unreadable-sessions/check.ts");
  process.exit(2);
}
const root = join(import.meta.dirname, "../../../..");
const own = !process.env.COUNCIL_HOME?.trim();
const home = own
  ? (mkdirSync(join(root, ".council-data"), { recursive: true }), mkdtempSync(join(root, ".council-data", "unreadable-sessions-check-")))
  : resolve(process.env.COUNCIL_HOME!);
const dataDir = ensureDataDir(home);
const models = ["p1.json", "p2.json"].map((f) => join(import.meta.dirname, "../store-failure", f));
let failed = false;
const check = (name: string, f: () => void) => {
  try { f(); console.log(`PASS: ${name}`); } catch (e) { failed = true; console.log(`FAIL: ${name}: ${(e as Error).message}`); }
};

async function finished(): Promise<string> {
  const s = createSession({
    topic: "Как назвать кота", framing: "", origin: "cli", materials: [],
    participants: models.map((model, i) => ({ name: `Participant ${i + 1}`, providerId: "scripted", model, role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 24000, materialsChars: 24000 },
  }, { maxParticipants: 8 });
  const drivers = Object.fromEntries(models.map((m, i) => [`p${i + 1}`, createScriptedDriver(JSON.parse(readFileSync(m, "utf8")), process.env)]));
  const r = await runStoredSession({ session: s, drivers, dataDir });
  assert.equal(r.state.finish?.status, "consensus");
  return s.id;
}

const council = (dir: string, lang: string, ...args: string[]) => spawnSync(process.execPath, [join(root, "packages/core/src/council.ts"), ...args], {
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: lang, COUNCIL_HOME: dir, COUNCIL_DEV: "1" },
  cwd: root, encoding: "utf8", input: "",
});

const appLog = () => { try { return readFileSync(join(dataDir, "logs", "app.log"), "utf8"); } catch { return ""; } };
let cPath = "";
try {
  const a = await finished(), b = await finished(), c = await finished();
  const d = "d-no-journal", e = "e-empty-journal";
  mkdirSync(sessionDir(dataDir, d), { recursive: true });
  mkdirSync(sessionDir(dataDir, e), { recursive: true });
  writeFileSync(eventsPath(dataDir, e), "");
  // The data folder with only A, copied before B and C are damaged.
  const clean = `${home}-clean`;
  cpSync(join(dataDir, "sessions", a), join(clean, "sessions", a), { recursive: true });
  writeFileSync(eventsPath(dataDir, b), "garbage\n");
  cPath = eventsPath(dataDir, c);
  chmodSync(cPath, 0o000);
  assert.notEqual(process.getuid?.(), 0, "running as root: chmod 000 does not make the journal unreadable");

  const reasons: Record<string, [string, string]> = { en: ["the journal has no session creation event", "EACCES"], ru: ["в журнале нет события создания сессии", "EACCES"] };
  const line = (lang: string, id: string, reason: string) => (lang === "en" ? `${id}: not read (${reason})` : `${id}: не прочитана (${reason})`);
  for (const lang of ["en", "ru"]) {
    const logBefore = appLog().length;
    const r = council(dataDir, lang, "list");
    check(`${lang}: list exits 0 and prints only the healthy session`, () => {
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes(a));
      for (const id of [b, c, d, e]) assert.ok(!r.stdout.includes(id), `stdout names ${id}`);
    });
    check(`${lang}: stderr has exactly the lines for B and C, nothing about D and E`, () => {
      const lines = r.stderr.split("\n").filter(Boolean).sort();
      assert.deepEqual(lines, [line(lang, b, reasons[lang]![0]), line(lang, c, reasons[lang]![1])].sort());
    });
    check(`${lang}: logs/app.log got two error records`, () => {
      const added = appLog().slice(logBefore);
      assert.equal(added.match(/ERROR \[cli\] Session journal not read/g)?.length, 2, added);
    });
    check(`${lang}: list --json is byte-equal to the folder without B and C`, () => {
      const j = council(dataDir, lang, "list", "--json"), jc = council(clean, lang, "list", "--json");
      assert.equal(j.status, 0);
      assert.equal(j.stdout, jc.stdout);
      assert.ok(j.stdout.includes(a));
    });
  }
  rmSync(clean, { recursive: true, force: true });
} finally {
  if (cPath) chmodSync(cPath, 0o644);
}
if (failed) process.exit(1);
console.log("Real model calls: 0");
console.log("PASS");
if (own) rmSync(home, { recursive: true, force: true });
