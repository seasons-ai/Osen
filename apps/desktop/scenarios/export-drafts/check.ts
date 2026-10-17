// Check of the draft and objection export on the real main modules (exportSession, sessionMarkdown, sessionDrafts) and a real council process, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/export-drafts/check.ts
//   ... --seed-only   only prepare the data folder (sessions A, B, C, A') for the app window
// Writes only to COUNCIL_HOME and does not remove it. Participants are scripted: no models are called.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionJournal, ensureDataDir, eventsPath, readSession, SessionEventSchema, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry, Session } from "../../../../packages/core/src/index.ts";
import { setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import { exportSession } from "../../src/main/export.ts";
import { sessionDrafts } from "../../src/main/drafts.ts";
import { sessionMarkdown } from "../../src/main/markdown.ts";
import { objectingParticipants } from "../../src/shared/timeline.ts";

const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only");
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder inside the project) are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/export-drafts/check.ts");
  process.exit(2);
}
if (existsSync(resolve(home)) && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const dir = realpathSync(resolve(home));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scen = join(root, "packages/core/scenarios");
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };

writeRegistry(ensureDataDir(dir), {
  providers: [],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] },
} as unknown as Registry);

// Scenario files: p1's first draft attempt returns non-JSON (failure, retry); delays removed.
const tmp = join(dir, "stand-scenarios");
mkdirSync(tmp);
const steps = (m: string): unknown[] => (JSON.parse(readFileSync(join(scen, m), "utf8")) as { steps: Record<string, unknown>[] }).steps.map(({ delayMs: _d, ...s }) => s);
const put = (name: string, s: unknown[]) => { const p = join(tmp, name); writeFileSync(p, JSON.stringify({ steps: s })); return p; };
const A = [put("a-p1.json", [{ raw: "не json" }, ...steps("independent-drafts/p1.json")]), put("a-p2.json", steps("independent-drafts/p2.json")), put("a-p3.json", steps("independent-drafts/p3.json"))];
const B = [join(scen, "independent-drafts/p1.json"), join(scen, "dropout/p2.json"), join(scen, "independent-drafts/p3.json")];

function council(participants: string[]): string {
  const args = ["packages/core/src/council.ts", "--topic", "Выберите план", "--drafts", "--synthesizer", "p2", "--max-rounds", "2", ...participants.flatMap((p) => ["--participant", `scripted:${p}`])];
  const r = spawnSync(process.execPath, args, { cwd: root, input: "", encoding: "utf8", timeout: 120000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: dir } });
  const id = /^Сессия (\S+) ·/m.exec(r.stdout + r.stderr)?.[1];
  assert.ok(id, `council did not print a session id: ${r.stdout}${r.stderr}`);
  return id;
}
const sA = council(A);
const sB = council(B);
assert.equal(readSession(dir, sA)!.status, "consensus", "session A: consensus");
const stB = readSession(dir, sB)!;
assert.deepEqual([stB.status, stB.state.finish?.reason], ["failed", "synthesizer_unavailable"], "session B");

// C: journal written directly, pid of a finished process: status interrupted; p1 agrees, p2's last turn objects to the current version
const DEAD_PID = spawnSync(process.execPath, ["-e", ""]).pid!;
const sC = "export-objects-c";
const ARG_C = "Аргумент возражения МЕТКА-C-P2";
createSessionJournal(dir, sC);
const cs: Session = {
  id: sC, createdAt: "2026-10-09T08:00:00Z", origin: "cli", topic: "Тема C", templateId: null, framing: "",
  participants: ["p1", "p2"].map((p) => ({ id: p, name: p, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
};
const turn = (n: number, p: string, stance: "amend" | "agree" | "object", reasoning: string) => [
  { type: "turn_started", turn: n, round: 1, participantId: p },
  { type: "turn_completed", turn: n, round: 1, participantId: p, stance, normalized: false, reasoning, solution: stance === "amend" ? "Решение v1" : null, version: 1, questions: [], answers: [], attempts: 1, usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1 },
];
const cEv = [{ type: "session_created", pid: DEAD_PID, session: cs }, ...turn(1, "p1", "amend", "r"), ...turn(2, "p2", "object", ARG_C), ...turn(3, "p1", "agree", "Согласен")]
  .map((b, i) => JSON.stringify(SessionEventSchema.parse({ ...b, seq: i + 1, ts: `2026-10-09T08:00:${String(i + 1).padStart(2, "0")}Z` })));
appendFileSync(eventsPath(dir, sC), cEv.join("\n") + "\n");
assert.equal(readSession(dir, sC)!.status, "interrupted", "session C: interrupted");

// A': a copy of A with a modified drafts/d1.txt
const sX = `${sA}-copy`;
cpSync(join(dir, "sessions", sA), join(dir, "sessions", sX), { recursive: true });
writeFileSync(join(dir, "sessions", sX, "drafts", "d1.txt"), "Изменённый текст черновика d1");
assert.ok(readSession(dir, sX), "the copy of A is readable");

if (seedOnly) {
  console.log(`Data folder prepared: ${dir}`);
  console.log(`Sessions: A ${sA} (drafts, consensus), B ${sB} (synthesizer_unavailable), C ${sC} (interrupted, p2 objects), A' ${sX} (d1 modified)`);
  console.log(`cd "${root}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" npm run desktop`);
  process.exit(0);
}

// Export — with the same modules and the same assembly as in main/index.ts, with stub pickPath and write.
async function exported(id: string): Promise<string> {
  let text: string | null = null;
  const r = await exportSession(id, {
    read: (i) => readSession(dir, i),
    render: (s, i) => sessionMarkdown(s.state, s.status, undefined, s.partial, sessionDrafts(dir, i)),
    pickPath: async () => join(dir, `${id}.md`),
    write: async (_p, t) => { text = t; },
  });
  assert.ok(r && text !== null, `export of ${id} did not write a file`);
  return text;
}
const at = (md: string, s: string, from = 0) => { const i = md.indexOf(s, from); assert.ok(i >= 0, `the export has no "${s}" after position ${from}:\n${md}`); return i; };
const RU_LABELS = ["Независимые черновики", "Черновик ", "Сбой:", "Обсуждение начато", "## Возражения", "Ход обсуждения"];
const L = {
  en: { phase: "### Independent drafts", fail: "- Failure: draft d1", draft: (n: number) => `### Draft ${n} · `, text: "**Draft text:**", start: "**Discussion started · synthesizer 2 · ", obj: "## Objections", noTurns: "No turns.", unavail: "Text unavailable:", turn: "### Turn 1" },
  ru: { phase: "### Независимые черновики", fail: "- Сбой: черновик d1", draft: (n: number) => `### Черновик ${n} · `, text: "**Текст черновика:**", start: "**Обсуждение начато · синтезатор 2 · ", obj: "## Возражения", noTurns: "Ходов нет.", unavail: "Текст недоступен:", turn: "### Ход 1" },
} as const;

for (const lang of ["en", "ru"] as const) {
  setProcessLanguage(lang);
  const l = L[lang];
  const mA = await exported(sA), mB = await exported(sB), mC = await exported(sC), mX = await exported(sX);

  // C
  const sc = readSession(dir, sC)!;
  const names = objectingParticipants(sc.state, sc.status).map((o) => o.participantId);
  assert.deepEqual(names, ["p2"], "objectingParticipants(C)");
  const oi = at(mC, l.obj);
  const section = mC.slice(oi).split(/\n## /)[0]!;
  assert.ok(section.includes("p2") && section.includes(ARG_C), `C: no p2 with an argument in "Возражения":\n${section}`);
  assert.ok(!/\bp1\b/.test(section), `C: p1 is in "Возражения":\n${section}`);
  ok(`${lang}: C — "${l.obj}" with p2 and an argument, without p1; the list equals objectingParticipants (${names})`);

  // A
  const drafts = sessionDrafts(dir, sA);
  assert.equal(drafts.length, 3);
  let pos = at(mA, l.phase);
  pos = at(mA, l.fail, pos);
  for (const d of drafts) {
    assert.equal(d.text, readFileSync(join(dir, "sessions", sA, "drafts", `${d.draftId}.txt`), "utf8"), `${d.draftId}: text != snapshot`);
    pos = at(mA, l.draft(Number(d.draftId.slice(1))), pos);
    pos = at(mA, d.reasoning, pos);
    pos = at(mA, l.text, pos);
    pos = at(mA, d.text!, pos);
  }
  pos = at(mA, l.start, pos);
  at(mA, l.turn, pos);
  ok(`${lang}: A — phase, failure, 3 drafts (author, argument, full text = snapshot), discussion start, turn 1 — in order`);

  // B
  at(mB, l.phase);
  at(mB, l.draft(1));
  assert.ok(!mB.includes(l.noTurns), `B: contains "${l.noTurns}"`);
  assert.ok(!mB.includes("synthesizer_unavailable"), "B: the reason code is in the file");
  assert.ok(new RegExp(`^${lang === "en" ? "Reason" : "Причина"}: .+`, "m").test(mB), "B: no reason line");
  ok(`${lang}: B — the phase and accepted drafts are present, no "${l.noTurns}", no reason code, the reason line is in place`);

  // A'
  const dx = sessionDrafts(dir, sX);
  assert.ok(dx[0]!.error && dx[0]!.text === null, "A': d1 without text");
  const i1 = at(mX, l.draft(1));
  at(mX, dx[0]!.reasoning, i1);
  at(mX, l.unavail, i1);
  at(mX, dx[1]!.text!);
  at(mX, dx[2]!.text!);
  ok(`${lang}: A' — d1 with an argument and "${l.unavail}", the others with text, export done`);

  // label language
  for (const [name, md] of [["A", mA], ["B", mB], ["C", mC], ["A'", mX]] as const) {
    const found = RU_LABELS.filter((x) => md.includes(x));
    if (lang === "en") assert.deepEqual(found, [], `en file ${name} contains Russian labels`);
    else if (name === "A") assert.deepEqual(found.sort(), [...RU_LABELS].filter((x) => x !== "## Возражения").sort(), `ru file ${name}: not all labels`);
  }
  if (lang === "ru") assert.ok(mC.includes("## Возражения"));
  ok(`${lang}: labels in the export language`);
}
console.log(`PASS: checks ${checks}, data folder ${dir}`);
