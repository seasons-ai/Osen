// Check of the session language with real council processes (scripted participants, 0 model calls, no network):
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node packages/core/scenarios/session-language/check.ts
// Participant requests are written by the scripted participant itself (COUNCIL_SCRIPTED_PROMPT_LOG). The stand sets the language for each process via COUNCIL_LANG.
// Rollback: the stand builds a temporary copy of the repository at the commit before change 63 (git worktree, deleted afterwards) and runs its council.
import "../language-ru.ts";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { eventsPath, foldEvents, readEvents, sessionsDir } from "../../src/index.ts";
import type { Language, SessionEvent } from "../../src/index.ts";
import { promptMessages } from "../../src/messages/prompt.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Usage: COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node packages/core/scenarios/session-language/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const rawHome = process.env.COUNCIL_HOME;
if (!rawHome) { console.error("Set COUNCIL_HOME: a new folder inside the project."); process.exit(2); }
mkdirSync(resolve(rawHome), { recursive: true });
const work = realpathSync(resolve(rawHome));
if (relative(realpathSync(repo), work).startsWith("..")) { console.error(`COUNCIL_HOME ${work} is outside the project.`); process.exit(2); }
if (readdirSync(work).length) { console.error(`COUNCIL_HOME ${work} is not empty: a new folder is needed.`); process.exit(2); }

let total = 0, passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  if (cond) { passed++; console.log(`ok   ${name}`); } else console.log(`FAIL ${name}${detail ? `\n       ${detail.slice(0, 800).replace(/\n/g, "\n       ")}` : ""}`);
}
const CYR = /[А-Яа-яЁё]/;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

// ---------- processes ----------
interface R { code: number | null; out: string; err: string }
function council(entry: string, home: string, lang: Language | undefined, log: string, args: string[]): Promise<R> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_DEV: "1", COUNCIL_HOME: home, COUNCIL_SCRIPTED_PROMPT_LOG: log };
  if (lang) env["COUNCIL_LANG"] = lang;
  return new Promise((done) => {
    const child = spawn(process.execPath, [entry, ...args], { env, cwd: repo });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("close", (code) => { clearTimeout(timer); done({ code, out, err }); });
  });
}
const NEW = join(repo, "packages/core/src/council.ts");
const dump = (r: R) => `code ${r.code}\nstdout: ${r.out.slice(-600)}\nstderr: ${r.err.slice(-600)}`;

interface Call { participantId: string; language: Language; prompt: string }
const callsOf = (log: string): Call[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call) : []);
const ids = (home: string) => (existsSync(sessionsDir(home)) ? readdirSync(sessionsDir(home)) : []);
const events = (home: string, id: string): SessionEvent[] => readEvents(home, id).events;
const created = (es: SessionEvent[]) => es[0] as Extract<SessionEvent, { type: "session_created" }>;
const onlyCreatedHasLanguage = (es: SessionEvent[]) => es.every((e) => e.type === "session_created" || !("language" in e));

// ---------- folders and scenarios ----------
const fx = join(work, "fixtures");
mkdirSync(fx, { recursive: true });
const MATERIAL = "MATERIAL-MARK-5c1e: the service must be named with one short Latin word.\n";
writeFileSync(join(fx, "brief.md"), MATERIAL);
mkdirSync(join(fx, "repo/docs"), { recursive: true });
writeFileSync(join(fx, "repo/README.md"), "README-MARK short readme.\n");
writeFileSync(join(fx, "repo/docs/big.txt"), "B".repeat(45000));
for (let i = 0; i < 5; i++) writeFileSync(join(fx, `repo/docs/note-${i}.txt`), `note ${i}\n`);

const resp = (stance: string, solution: string | null, reasoning = "Short reasoning.") => ({ response: { stance, reasoning, solution, answers: [], questions: [] } });
function scenario(name: string, steps: unknown[]): string {
  const p = join(fx, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return `scripted:${p}`;
}
const agreeFlow = [scenario("amend-agree", [resp("amend", "Name it Orbit."), resp("agree", null), resp("agree", null)]), scenario("agree", [resp("agree", null), resp("agree", null)])];
// First run: p2 objects — no_consensus in 1 round; the continuation: p2 agrees.
const objectFlow = () => [
  scenario(`o1-${Math.random().toString(36).slice(2)}`, [resp("amend", "Name it Orbit."), resp("agree", null), resp("agree", null)]),
  scenario(`o2-${Math.random().toString(36).slice(2)}`, [resp("object", null, "Not yet."), resp("agree", null), resp("agree", null)]),
];
const TOPIC = "Pick a name for the service.";
// The framing is set explicitly: the framing of a built-in template is template data in its language (change 64), not engine text.
const FRAMING = "Discuss the topic on the merits and agree on one solution.";
// Names are set explicitly: the default name of a scripted participant is a terminal entry (change 62), not engine text.
const parts = (ps: string[]) => ps.flatMap((p, i) => ["--participant", `Member${i + 1}=${p}`]);
const home = (name: string) => { const d = join(work, name); mkdirSync(d, { recursive: true }); return d; };

async function start(name: string, lang: Language | undefined, ps: string[], extra: string[] = [], entry = NEW, h = home(name)) {
  const log = join(h, "prompts.jsonl");
  const before = new Set(ids(h));
  const r = await council(entry, h, lang, log, ["--topic", TOPIC, "--framing", FRAMING, ...parts(ps), ...extra]);
  const id = ids(h).find((x) => !before.has(x)) ?? "";
  return { r, id, home: h, log, calls: callsOf(log) };
}
async function resume(h: string, id: string, lang: Language | undefined, entry = NEW, rounds = "1") {
  const log = join(h, `resume-${Date.now()}.jsonl`);
  const r = await council(entry, h, lang, log, ["resume", id, "--rounds", rounds]);
  return { r, calls: callsOf(log) };
}
const RULES = { en: "# Protocol rules\n", ru: "# Правила протокола\n" } as const;
const isLang = (c: Call, l: Language) => c.language === l && c.prompt.includes(RULES[l]) && !c.prompt.includes(RULES[l === "en" ? "ru" : "en"]);

// ---------- rollback: a temporary copy of the repository at the commit before the change ----------
function oldCheckout(): { entry: string; cleanup: () => void } | null {
  try {
    const added = execFileSync("git", ["log", "--diff-filter=A", "--format=%H", "--", "packages/core/src/messages/prompt.ts"], { cwd: repo, encoding: "utf8" }).trim().split("\n").pop();
    if (!added) return null;
    const dir = join(tmpdir(), `council-old-${Date.now()}`);
    execFileSync("git", ["worktree", "add", "--detach", dir, `${added}^`], { cwd: repo, stdio: "ignore" });
    symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"));
    return {
      entry: join(dir, "packages/core/src/council.ts"),
      cleanup: () => { execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repo, stdio: "ignore" }); },
    };
  } catch (e) {
    console.log(`Rollback: could not build the temporary copy — ${(e as Error).message}`);
    return null;
  }
}

// ---------- A: en, material, consensus ----------
{
  const a = await start("A", "en", agreeFlow, ["--attach", join(fx, "brief.md"), "--max-rounds", "1"]);
  const es = events(a.home, a.id);
  check("A: code 0, consensus", a.r.code === 0 && foldEvents(es).finish?.status === "consensus", dump(a.r));
  check("A: session_created carries language en", created(es).session.language === "en");
  check("A: requests are English (rules, headings), driver language en", a.calls.length >= 2 && a.calls.every((c) => isLang(c, "en")), JSON.stringify(a.calls.map((c) => c.language)));
  check("A: topic and material verbatim, no Cyrillic, no answer-language instruction",
    a.calls.every((c) => c.prompt.includes(`# Topic\n${TOPIC}`) && c.prompt.includes(MATERIAL) && c.prompt.includes("# Owner's materials\n") && !CYR.test(c.prompt) && !/answer in English|reply in English|respond in/i.test(c.prompt)),
    a.calls.map((c) => c.prompt.match(CYR)?.input?.slice(Math.max(0, (c.prompt.search(CYR)) - 80), c.prompt.search(CYR) + 80)).join("\n---\n"));
}

// ---------- B and C: ru session, continuation under en ----------

{
  const b = await start("B", "ru", objectFlow(), ["--attach", join(fx, "brief.md"), "--max-rounds", "1"]);

  const es = events(b.home, b.id);
  check("B: language ru in the journal, no_consensus", created(es).session.language === "ru" && foldEvents(es).finish?.status === "no_consensus", dump(b.r));
  check("B: requests are Russian (byte-for-byte equality with the references — golden.test.ts)", b.calls.length >= 2 && b.calls.every((c) => isLang(c, "ru")));
  const prefix = readFileSync(eventsPath(b.home, b.id));
  const c = await resume(b.home, b.id, "en");
  const es2 = events(b.home, b.id);
  check("C: continuation of the ru session under COUNCIL_LANG=en — code 0, consensus", c.r.code === 0 && foldEvents(es2).finish?.status === "consensus", dump(c.r));
  check("C: all continuation requests are Russian", c.calls.length >= 1 && c.calls.every((x) => isLang(x, "ru")));
  check("C: one language in the journal, journal prefix unchanged", onlyCreatedHasLanguage(es2) && readFileSync(eventsPath(b.home, b.id)).subarray(0, prefix.length).equals(prefix) && sessionLanguageOf(es2) === "ru");
}
function sessionLanguageOf(es: SessionEvent[]): Language { return foldEvents(es).session?.language ?? "ru"; }

// the reverse: en session, continuation under ru
let aPrimeId = "";
{
  const a2 = await start("A2", "en", objectFlow(), ["--max-rounds", "1"]);
  aPrimeId = a2.id;
  check("A2: en session, no_consensus", sessionLanguageOf(events(a2.home, a2.id)) === "en" && foldEvents(events(a2.home, a2.id)).finish?.status === "no_consensus", dump(a2.r));
  // the copy for the rollback is taken before the continuation
  cpSync(a2.home, join(work, "A2-rollback"), { recursive: true });
  const c = await resume(a2.home, a2.id, "ru");
  check("C': continuation of the en session under COUNCIL_LANG=ru — requests are English", c.r.code === 0 && c.calls.length >= 1 && c.calls.every((x) => isLang(x, "en")), dump(c.r));
}

// ---------- D and rollback ----------
const old = oldCheckout();
if (!old) {
  check("D/rollback: temporary copy at the commit before the change", false, "not built — see the output above");
} else {
  try {
    const d = await start("D", "ru", objectFlow(), ["--max-rounds", "1"], old.entry);
    const raw0 = readFileSync(eventsPath(d.home, d.id));
    const first = JSON.parse(raw0.toString("utf8").split("\n")[0]!) as { session: Record<string, unknown> };
    check("D: journal of the previous version without the language field", foldEvents(events(d.home, d.id)).finish?.status === "no_consensus" && !("language" in first.session), dump(d.r));
    const c1 = await resume(d.home, d.id, "en", NEW, "1");
    check("D: continuation under COUNCIL_LANG=en — requests are Russian", c1.calls.length >= 1 && c1.calls.every((x) => isLang(x, "ru")), dump(c1.r));
    check("D: journal file unchanged before the new events (sha256 of the prefix)", sha(readFileSync(eventsPath(d.home, d.id)).subarray(0, raw0.length)) === sha(raw0));
    // a second session of the same version: continuation without COUNCIL_LANG and without preferences.json (the effective default en)
    const d2 = await start("D2", "ru", objectFlow(), ["--max-rounds", "1"], old.entry);
    const raw2 = readFileSync(eventsPath(d2.home, d2.id));
    const c2 = await resume(d2.home, d2.id, undefined, NEW, "1");
    check("D2: continuation without the language variable — requests are Russian, prefix unchanged",
      c2.calls.length >= 1 && c2.calls.every((x) => isLang(x, "ru")) && readFileSync(eventsPath(d2.home, d2.id)).subarray(0, raw2.length).equals(raw2), dump(c2.r));

    const rb = join(work, "A2-rollback");
    const r = await council(old.entry, rb, "ru", join(rb, "old.jsonl"), ["resume", aPrimeId, "--rounds", "1"]);
    const es = events(rb, aPrimeId);
    check("Rollback: the previous version reads and continues a session with the language field — code 0", r.code === 0 && foldEvents(es).finish?.status === "consensus", dump(r));
    const show = await council(old.entry, rb, "ru", join(rb, "old.jsonl"), ["show", aPrimeId]);
    check("Rollback: council show of the previous version — code 0", show.code === 0, dump(show));
  } finally {
    old.cleanup();
  }
}

// ---------- E: en, folder, file request, parse error ----------
{
  const e1 = scenario("e1", [
    { raw: JSON.stringify({ files: ["repo/docs/big.txt", "repo/missing.txt"] }) },
    { raw: "not a JSON object" },
    resp("amend", "Name it Orbit."),
    resp("agree", null),
  ]);
  const e2 = scenario("e2", [resp("agree", null), resp("agree", null)]);
  const e = await start("E", "en", [e1, e2], ["--attach", join(fx, "repo"), "--materials-chars", "100", "--max-rounds", "1"]);
  const p1 = e.calls.filter((c) => c.participantId === "p1");
  const es = events(e.home, e.id);
  const served = p1.find((c) => c.prompt.includes("# Requested files\n"));
  const fix = p1.find((c) => c.prompt.includes("# Fix your previous answer\n"));
  const m = promptMessages("en");
  check("E: code 0, session en", e.r.code === 0 && sessionLanguageOf(es) === "en", dump(e.r));
  check("E: the requested files section and reasons are English, file names unchanged",
    !!served && served.prompt.includes("## File: repo/docs/big.txt\n(the first 40000 of 45000 characters are shown)") && served.prompt.includes(`## File: repo/missing.txt\n(${m.noteMissing})`) && served.prompt.includes("# Owner's folder\n"),
    served?.prompt.slice(served.prompt.indexOf("# Requested files"), served.prompt.indexOf("# Requested files") + 400));
  check("E: the fix request and error description are English", !!fix && fix.prompt.includes(`- ${m.errNoJson}`) && fix.prompt.includes("Your previous answer (may be truncated):\nnot a JSON object"));
  const failed = es.find((x) => x.type === "turn_failed") as Extract<SessionEvent, { type: "turn_failed" }> | undefined;
  check("E: the turn failure record is English, kind invalid_response", failed?.kind === "invalid_response" && failed.message === m.errNoJson, JSON.stringify(failed));
  check("E: no Cyrillic in any request", e.calls.every((c) => !CYR.test(c.prompt)));
}

// ---------- F: en, context limit smaller than the rules ----------
{
  const steps = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? resp("amend", "Name it Orbit.", "Opening reasoning with several words.") : resp("object", null, `Objection number ${i} with a few words.`)));
  const ps = [scenario("f1", steps(4)), scenario("f2", steps(4)), scenario("f3", steps(4))];
  const limit = 100;
  const f = await start("F", "en", ps, ["--context-chars", String(limit), "--max-rounds", "3"]);
  const rules = promptMessages("en").protocolRules;
  const late = f.calls.filter((c) => c.prompt.includes("[Early turns omitted due to the context limit: "));
  const journal = (p: string) => p.slice(p.indexOf("# Turn log\n") + "# Turn log\n".length).replace(/^\[Early turns omitted[^\n]*\n/, "");
  check("F: ordinary exit code, session en", (f.r.code === 0 || f.r.code === 3) && sessionLanguageOf(events(f.home, f.id)) === "en", dump(f.r));
  check(`F: limit ${limit} is smaller than the length of the English rules (${rules.length}), rules and headings are complete in all requests`,
    limit < rules.length && f.calls.length > 3 && f.calls.every((c) => c.prompt.includes(`# Protocol rules\n${rules}`) && c.prompt.includes(`# Topic\n${TOPIC}`)));
  check("F: English note about omitted turns, the log is not longer than the limit",
    late.length > 0 && late.every((c) => journal(c.prompt).split("\n\n").reduce((n, x) => n + x.length, 0) <= limit),
    late.map((c) => journal(c.prompt)).join("\n---\n"));
}

const all = readdirSync(work).filter((d) => existsSync(sessionsDir(join(work, d)))).flatMap((d) => ids(join(work, d)).map((id) => events(join(work, d), id)));
check("In all journals the language is only in session_created", all.length > 0 && all.every(onlyCreatedHasLanguage));
console.log(`\nResult: ${passed} of ${total}; model calls: 0 (scripted participants)`);
process.exit(passed === total ? 0 : 1);
