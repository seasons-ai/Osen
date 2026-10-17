// Check of carrying the owner's choice (“Discuss further”) and copying the result/choice on the real main modules (bridge, prepareRerun, materials draft) and the core, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/owner-choice-carry/check.ts
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/owner-choice-carry/check.ts --seed-only   (only prepare the folder for the app window)
// Writes only to COUNCIL_HOME and does not delete it. No models are called: journals A, B, C are written directly (appendEvent), as in rerun.test.ts.
// A: consensus, three versions, the owner accepted version 1 (bridge acceptVersion). B: no consensus, two versions, no choice.
// C: a fixture. The finish event names version 2, while the journal has version 3 after it. A real journal never looks like this:
//    session_resumed (fold.ts) resets finish to null, a resumed run writes a new session_finished with the current version, so finish.version always equals the last one.
//    The finalVersion and currentVersion mismatch is reachable only on a nonstandard journal; finalVersion then matches what “Result” shows.
// The stand does not render the Result markup (buttons “Copy result” and “Copy choice”): Result.tsx is TSX, node does not load it (covered by Result.test.tsx).
// What is checked here is what the markup depends on: chosenVersion (the “Copy choice” button exists only when chosenVersion ≠ null), finalVersion and the result.copy/copyChoice labels.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import { BUILTIN_TEMPLATES_DIR, appendEvent, createLogger, createSessionJournal, listSessions, loadTemplates, readSession, selectOwnerVersion, userTemplatesDir } from "../../../../packages/core/src/index.ts";
import type { Session, SessionEvent } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createMaterialsDraft } from "../../src/main/materials.ts";
import { prepareRerun } from "../../src/main/rerun.ts";
import { chosenVersion, finalVersion } from "../../src/shared/final-version.ts";
import { result } from "../../src/shared/messages/result.ts";
import { panels } from "../../src/shared/messages/session-panels.ts";
import type { RerunView } from "../../src/shared/setup.ts";

const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only");
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/owner-choice-carry/check.ts");
  process.exit(2);
}
if (existsSync(resolve(home)) && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const dir = realpathSync(resolve(home));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const EXPECTED = 14;
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };

// Journals. Created on 5 March 2026 (local time): the date in material names is 2026-03-05.
const created = new Date(2026, 2, 5, 12, 0, 0);
const ts = created.toISOString();
const DATE = "2026-03-05";
const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
type Step = { v: number } | { agree: number } | { fin: "consensus" | "no_consensus"; version: number };
const text = (id: string, v: number) => `Текст версии ${v} сессии ${id}`;
function journal(id: string, steps: Step[]): void {
  const session: Session = {
    id, createdAt: ts, origin: "desktop", topic: "Как назвать кота", templateId: null, framing: "Нейтральная рамка.",
    participants: [{ id: "p1", name: "n1", providerId: "scripted", model: "m1", role: null }, { id: "p2", name: "n2", providerId: "scripted", model: "m2", role: null }],
    limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 },
  };
  createSessionJournal(dir, id);
  const body: Record<string, unknown>[] = [{ type: "session_created", session, pid: deadPid }];
  let turn = 0;
  for (const s of steps) {
    if ("fin" in s) { body.push({ type: "session_finished", status: s.fin, version: s.version, agreed: s.fin === "consensus" ? ["p1", "p2"] : [], objectors: [] }); continue; }
    turn++;
    const pid = turn % 2 ? "p1" : "p2";
    body.push({ type: "turn_started", turn, round: 1, participantId: pid });
    body.push("v" in s
      ? { type: "turn_completed", turn, round: 1, participantId: pid, stance: "amend", normalized: false, reasoning: "ok", solution: text(id, s.v), version: s.v, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1 }
      : { type: "turn_completed", turn, round: 1, participantId: pid, stance: "agree", normalized: false, reasoning: "ok", solution: null, version: s.agree, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1 });
  }
  body.forEach((e, i) => appendEvent(dir, id, { seq: i + 1, ts, ...e } as SessionEvent));
}
const [A, B, C] = ["sess-a", "sess-b", "sess-c"] as const;
journal(A, [{ v: 1 }, { v: 2 }, { v: 3 }, { agree: 3 }, { agree: 3 }, { fin: "consensus", version: 3 }]);
journal(B, [{ v: 1 }, { v: 2 }, { fin: "no_consensus", version: 2 }]);
journal(C, [{ v: 1 }, { v: 2 }, { fin: "consensus", version: 2 }, { v: 3 }]); // version 3 after the finish event

// Real application modules; the bindings repeat apps/desktop/src/main/index.ts.
const logger = createLogger(dir, "desktop", process.env);
const materials = createMaterialsDraft({ limits: () => ({ materialsChars: 100_000, materialsIgnore: [] }) });
const catalog = () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: userTemplatesDir(dir) });
const stub = <T>(v: T) => () => v;
const bridge = createBridge({
  listSessions: stub([]), sessionExists: (id: string) => readSession(dir, id) !== null, sessionDrafts: () => [], watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }),
  registry: async () => ({}) as never, startSession: () => ({}) as never, lineups: async () => ({}) as never, saveLineup: async () => ({}) as never, lastParticipants: stub(null),
  resumeOptions: async () => ({}) as never, resumeSession: async () => ({}) as never, stopSession: () => {},
  acceptVersion: (id: string, version: number, note?: string) => selectOwnerVersion(dir, id, { version, note }),
  sendOwnerMessage: () => ({ requestId: "r" }), continueWait: () => ({ requestId: "r" }),
  previewMaterials: async () => ({}) as never, prepareRerun: (id: string, withDecision: boolean) => prepareRerun({ dataDir: dir, catalog, materials }, id, withDecision), copyText: () => {},
  exportSession: async () => null, setPinned: () => {}, settings: {} as never, templates: { open: stub(null), create: stub(null), save: stub(null), remove: () => {} } as never,
  materials, pickMaterials: async () => null, send: () => {}, logger,
} as never);
type R = { ok: true; value: unknown } | { ok: false; error: string };
async function good<T>(a: string, ...args: unknown[]): Promise<T> {
  const r = (await bridge.call(a, args)) as R;
  assert.ok(r.ok, `${a}: expected success, got: ${r.ok ? "" : r.error}`);
  return r.value as T;
}
/** “Discuss further” through the bridge: the draft's material names and the last material with text. */
async function carry(id: string) {
  const v = await good<RerunView>("prepareRerun", id, true);
  const names = v.materials.items.map((i) => i.name);
  const all = materials.take();
  assert.equal(all.length, names.length);
  const last = all.at(-1)!;
  assert.equal(last.name, names.at(-1));
  return { names, last };
}
const state = (id: string) => readSession(dir, id)!.state;
const sha = (id: string) => createHash("sha256").update(readFileSync(join(dir, "sessions", id, "events.jsonl"))).digest("hex");

await good("acceptVersion", A, 1);
assert.equal(state(A).ownerSelection?.version, 1);

if (seedOnly) {
  console.log(`Data folder prepared: ${dir}`);
  console.log(`A  ${A}  consensus, versions 1-3, result 3, owner's choice: version 1`);
  console.log(`B  ${B}  no_consensus, versions 1-2, no choice`);
  console.log(`C  ${C}  result by the finish event is version 2, version 3 after it (fixture), no choice`);
  console.log(`Open the app on this folder: cd "${root}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" npm run desktop`);
  process.exit(0);
}

const before = { A: sha(A), B: sha(B), C: sha(C), n: listSessions(dir).length };

// ru
{
  const a = await carry(A);
  assert.equal(a.last.name, `Выбор владельца: версия 1 прошлой сессии ${DATE}`);
  assert.equal(a.last.text, text(A, 1));
  assert.ok(!a.names.some((n) => n.startsWith("Решение прошлой сессии")), `a decision material exists: ${a.names}`);
  ok(`A: “Discuss further” → “${a.last.name}” with the text of version 1, no “Решение прошлой сессии…” material`);

  assert.equal(finalVersion(state(A))?.text, text(A, 3));
  assert.equal(chosenVersion(state(A))?.text, text(A, 1));
  ok("A: “Copy result” copies version 3 (finalVersion), “Copy choice” copies version 1 (chosenVersion)");

  const b = await carry(B);
  assert.equal(b.last.name, `Решение прошлой сессии: версия 2, ${DATE}`);
  assert.equal(b.last.text, text(B, 2));
  ok(`B: “${b.last.name}” with the text of version 2`);

  assert.equal(chosenVersion(state(B)), null);
  assert.equal(finalVersion(state(B))?.text, text(B, 2));
  ok("B: chosenVersion null — “Copy choice” is not shown; “Copy result” copies version 2");

  const t = result("ru");
  assert.equal(t.copy, "Скопировать итог");
  assert.equal(t.copyChoice, "Скопировать выбор");
  ok(`ru: button labels “${t.copy}” (always) and “${t.copyChoice}” (when there is a choice)`);

  const cs = state(C);
  assert.equal(cs.versions.length, 3);
  assert.equal(cs.finish?.version, 2);
  const c = await carry(C);
  assert.equal(c.last.name, `Решение прошлой сессии: версия 2, ${DATE}`);
  assert.equal(c.last.text, text(C, 2));
  ok(`C: result by the finish event is version 2, the journal has version 3; carried “${c.last.name}” with the text of version 2`);
  assert.equal(finalVersion(cs)?.number, 2);
  assert.equal(chosenVersion(cs), null);
  ok("C: finalVersion = version 2 (what “Copy result” copies); no choice");
}

// no writes
{
  assert.equal(sha(A), before.A, "journal A changed");
  assert.equal(sha(B), before.B, "journal B changed");
  assert.equal(sha(C), before.C, "journal C changed");
  assert.equal(listSessions(dir).length, before.n, "the number of sessions changed");
  ok(`“Discuss further” writes nothing: sha256 of events.jsonl A, B, C unchanged, sessions still ${before.n}`);
}

// en
{
  setProcessLanguage("en");
  const a = await carry(A);
  assert.equal(a.last.name, `Owner's choice: version 1 of the previous session ${DATE}`);
  assert.equal(a.last.text, text(A, 1));
  assert.ok(!a.names.some((n) => n.startsWith("Solution of the previous session")));
  ok(`en, A: “${a.last.name}”, text of version 1, no decision material`);
  const b = await carry(B);
  assert.equal(b.last.name, `Solution of the previous session: version 2, ${DATE}`);
  assert.equal(b.last.text, text(B, 2));
  ok(`en, B: “${b.last.name}”, text of version 2`);
  const c = await carry(C);
  assert.equal(c.last.name, `Solution of the previous session: version 2, ${DATE}`);
  assert.equal(c.last.text, text(C, 2));
  ok("en, C: version 2, not 3");
  const t = result("en");
  assert.deepEqual([t.copy, t.copyChoice], ["Copy result", "Copy choice"]);
  assert.equal(panels("en").copiedNotice(3), "Version 3 (discussion result) copied to the clipboard");
  assert.equal(panels("en").copiedChoiceNotice(1), "Version 1 (your choice) copied to the clipboard");
  ok("en: “Copy result”, “Copy choice”, confirmations “Version 3 (discussion result)…” and “Version 1 (your choice)…”");
  setProcessLanguage("ru");
  assert.equal(panels("ru").copiedNotice(3), "Версия 3 (итог обсуждения) скопирована в буфер обмена");
  assert.equal(panels("ru").copiedChoiceNotice(1), "Версия 1 (ваш выбор) скопирована в буфер обмена");
  ok("ru: confirmations “Версия 3 (итог обсуждения)…” and “Версия 1 (ваш выбор)…”");
  assert.equal(sha(A), before.A);
  assert.equal(listSessions(dir).length, before.n);
  ok("after the English checks the journals and the session count are unchanged");
}

assert.equal(checks, EXPECTED, `${checks} checks, expected ${EXPECTED}`);
console.log(`${checks} checks, all passed; real model calls 0; data folder ${dir}`);
