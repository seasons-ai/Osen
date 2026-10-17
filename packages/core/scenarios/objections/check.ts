// Check of the "Positions on the current version" section by a real council process (scripted participants, 0 model calls):
//   COUNCIL_DEV=1 node packages/core/scenarios/objections/check.ts
// The stand creates the data folder itself (.council-data/objections-check-*) and deletes it after success; --context-chars 1: no turn fits into the journal.
// The scripted participant itself writes the participants' requests (COUNCIL_SCRIPTED_PROMPT_LOG): they are used to check what expectPrompt cannot (absence).
import "../language-ru.ts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { foldEvents, readEvents, sessionsDir } from "../../src/index.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/core/scenarios/objections/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const here = import.meta.dirname;
const work = join(repo, ".council-data", `objections-check-${Date.now()}`);
mkdirSync(work, { recursive: true });

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`✓ ${name}`);
  else { failed++; console.log(`✗ ${name}${detail ? `\n    ${detail.slice(0, 800).replace(/\n/g, "\n    ")}` : ""}`); }
}

interface Call { participantId: string; prompt: string }
interface Run { code: number | null; out: string; err: string; status: string | undefined; dropped: Record<string, string>; calls: Call[] }
const NAMES = ["Альфа", "Бета", "Гамма"];

// One session in its own data folder: participants p1-p3 from scenario files.
function run(name: string, files: string[]): Promise<Run> {
  const home = join(work, name);
  mkdirSync(home, { recursive: true });
  const log = join(home, "prompts.jsonl");
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_DEV: "1", COUNCIL_HOME: home, COUNCIL_LANG: "ru", COUNCIL_SCRIPTED_PROMPT_LOG: log };
  const args = [
    join(repo, "packages/core/src/council.ts"), "--topic", "Как назвать сервис?", "--max-rounds", "3", "--context-chars", "1",
    ...files.flatMap((f, i) => ["--participant", `${NAMES[i]}=scripted:${f}`]),
  ];
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { env, cwd: repo });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const ids = existsSync(sessionsDir(home)) ? readdirSync(sessionsDir(home)) : [];
      const state = ids[0] ? foldEvents(readEvents(home, ids[0]).events) : undefined;
      const dropped = Object.fromEntries((state?.participants ?? []).filter((p) => p.status === "dropped").map((p) => [p.id, p.dropReason ?? ""]));
      const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : [];
      done({ code, out, err, status: state?.status, dropped, calls });
    });
  });
}
const dump = (r: Run) => `status ${r.status}, code ${r.code}\nstdout: ${r.out.slice(-500)}\nstderr: ${r.err.slice(-500)}`;
// The request of a participant's second turn (its second call in the request log).
const second = (r: Run, id: string) => r.calls.filter((c) => c.participantId === id)[1]?.prompt ?? "";
const journalOf = (p: string) => p.split("# Журнал ходов\n")[1] ?? "";
function scenario(name: string, steps: unknown[]): string {
  const p = join(work, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
}
const resp = (stance: string, reasoning: string, solution: string | null = null) => ({ stance, reasoning, solution, answers: [], questions: [] });
const P3_MARK = "ВОЗРАЖЕНИЕ-P3-9d41";

// Step 2: the objection of p3 reaches p1 and p2 although turn 3 is omitted from the journal.
const main = await run("main", ["p1.json", "p2.json", "p3.json"].map((f) => join(here, f)));
const p1 = second(main, "p1");
check("the p1 request contains the p3 objection with turn 3 omitted", p1.includes(`возражает (ход 3): ${P3_MARK}`), p1 ? "the p1 request does not contain the p3 objection" : dump(main));
check("the p1 request journal has no p3 mark: the turn is omitted by the limit", p1 !== "" && !journalOf(p1).includes(P3_MARK) && journalOf(p1).includes("[Ранние ходы опущены из-за лимита контекста: 3]"));
check("the p2 request contains the p3 objection", second(main, "p2").includes(`возражает (ход 3): ${P3_MARK}`), "the p2 request does not contain the p3 objection");
check("the session ended in consensus", main.status === "consensus", dump(main));

// Step 3: control: expecting a mark that is not in the request breaks the turn.
const control = await run("control", [
  scenario("c1", [{ response: resp("amend", "Версия.", "Назвать «Совет».") }, { expectPrompt: "ВОЗРАЖЕНИЕ-ОТСУТСТВУЕТ-0000", response: resp("agree", "Да.") }]),
  join(here, "p2.json"), join(here, "p3.json"),
]);
// The remaining two can agree without p1, so the turn failure itself is checked: p1 drops out with the scenario reason.
check("control: expecting a missing mark breaks the p1 turn", (control.dropped["p1"] ?? "").includes("ВОЗРАЖЕНИЕ-ОТСУТСТВУЕТ-0000"), dump(control));

// Step 4: the size boundary: 2500 characters of objection, the request has the first 2000 and a note, no 2001st character.
const long = `${P3_MARK} ${Array.from({ length: 2500 - P3_MARK.length - 1 }, (_, i) => "абвгдежзик"[i % 10]).join("")}`;
const bound = await run("bound", [
  scenario("b1", [{ response: resp("amend", "Версия.", "Назвать «Совет».") }, { expectPrompt: "[показаны первые 2000 из 2500 знаков, ход 3]", response: resp("agree", "Да.") }]),
  join(here, "p2.json"),
  scenario("b3", [{ response: resp("object", long) }, { response: resp("agree", "Да.") }]),
]);
const b1 = second(bound, "p1");
check("boundary: the first 2000 characters and the note \"[показаны первые 2000 из 2500 знаков, ход 3]\"", long.length === 2500 && b1.includes(long.slice(0, 2000)) && b1.includes("[показаны первые 2000 из 2500 знаков, ход 3]"), dump(bound));
check("boundary: no 2001st character of the objection in the request", b1 !== "" && !b1.includes(long.slice(0, 2001)));
check("boundary: the session ended in consensus", bound.status === "consensus", dump(bound));

if (failed === 0) {
  rmSync(work, { recursive: true, force: true });
  console.log(`Check passed. Temporary folder deleted: ${!existsSync(work)}`);
} else {
  console.log(`Check failed: ${failed}. Data folder kept for analysis: ${work}`);
}
process.exit(failed === 0 ? 0 : 1);
