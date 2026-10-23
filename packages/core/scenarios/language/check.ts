// Check of the core message language through a real council process (scripted participants, 0 model calls, no network):
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node packages/core/scenarios/language/check.ts
// COUNCIL_HOME must not exist or must be empty; inside it the stand creates one data folder per group of cases.
// The stand sets the language of each launched process through COUNCIL_LANG (or its absence). The owner's data is not touched.
// The expected text comes from the packages/core/src/messages catalogs: the stand checks both the language and the substituted values.
// The council output frame (cli.ts: "Error:", "Reason:", help) comes from the messages/cli.ts catalog in the process language: step 7.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInsideRepo } from "../inside-repo.ts";
import { foldEvents, planResume, ResumeRejectedError, readSession, setProcessLanguage, tokenUsage, readTariffs } from "../../src/index.ts";
import type { Language } from "../../src/index.ts";
import { finishReasonText } from "../../src/protocol/finish-reason.ts";
import { cliMessages } from "../../src/messages/cli.ts";
import { engineMessages } from "../../src/messages/engine.ts";
import { finishMessages } from "../../src/messages/finish.ts";
import { materialsMessages } from "../../src/messages/materials.ts";
import { protocolMessages } from "../../src/messages/protocol.ts";
import { providerMessages } from "../../src/messages/providers.ts";
import { registryMessages } from "../../src/messages/registry.ts";
import { resumeMessages } from "../../src/messages/resume.ts";
import { storeMessages } from "../../src/messages/store.ts";
import { templateMessages } from "../../src/messages/templates.ts";
import { zodMessages } from "../../src/messages/zod.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Scripted participants are available only with COUNCIL_DEV=1. Run: COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node packages/core/scenarios/language/check.ts");
  process.exit(1);
}
const repo = resolve(import.meta.dirname, "../../../..");
const councilTs = join(repo, "packages/core/src/council.ts");
const rawHome = process.env.COUNCIL_HOME;
if (!rawHome) { console.error("Set COUNCIL_HOME: a new folder inside the project."); process.exit(1); }
mkdirSync(resolve(rawHome), { recursive: true });
const work = realpathSync(resolve(rawHome));
if (!isInsideRepo(realpathSync(repo), work)) { console.error(`COUNCIL_HOME ${work} is outside the project.`); process.exit(1); }
if (readdirSync(work).length) { console.error(`COUNCIL_HOME ${work} is not empty: a new folder is needed.`); process.exit(1); }

// ---------- checks ----------
let total = 0, passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  total++;
  if (cond) { passed++; console.log(`ok   ${name}`); } else console.log(`FAIL ${name}${detail ? `\n       ${detail.replace(/\n/g, "\n       ")}` : ""}`);
}
const clip = (s: string) => (s.length > 600 ? `${s.slice(0, 600)}…` : s);
const LANGS = ["en", "ru"] as const;
const other = (l: Language): Language => (l === "en" ? "ru" : "en");

// ---------- processes and folders ----------
interface R { code: number | null; out: string; err: string; all: string }
function council(dataDir: string, lang: Language | undefined, args: string[], timeoutMs = 90000): Promise<R> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_DEV: "1", COUNCIL_HOME: dataDir };
  if (lang) env["COUNCIL_LANG"] = lang;
  return new Promise((done) => {
    const child = spawn(process.execPath, [councilTs, ...args], { env, cwd: repo });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done({ code, out, err, all: `${out}\n${err}` }); });
  });
}
const dump = (r: R) => `code ${r.code}\nstdout: ${clip(r.out)}\nstderr: ${clip(r.err)}`;

const DEFAULTS = { maxRounds: 5, turnTimeoutSec: 300, contextChars: 24000, maxParticipants: 8, participants: [] };
const noProviders = { providers: [], defaults: DEFAULTS };
function dataDir(name: string, config: unknown = noProviders): string {
  const d = join(work, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "config.json"), JSON.stringify(config));
  return d;
}
type S = Record<string, unknown>;
const amend = (text: string): S => ({ response: { stance: "amend", reasoning: "r", solution: text, answers: [], questions: [] } });
const agree = (): S => ({ response: { stance: "agree", reasoning: "r", solution: null, answers: [], questions: [] } });
const agrees = (n: number) => Array.from({ length: n }, agree);
const crash = (): S => ({ error: "Scripted failure", retryable: false });
function scen(d: string, name: string, steps: S[]): string {
  const dir = join(d, "scen");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
}
const parts = (...ps: string[]) => ps.flatMap((p) => ["--participant", `scripted:${p}`]);
const sessionIds = (d: string) => (existsSync(join(d, "sessions")) ? readdirSync(join(d, "sessions")).sort() : []);
/** Starts a session and returns the id of the new session folder. */
async function newSession(d: string, lang: Language | undefined, args: string[]): Promise<{ id: string; r: R }> {
  const before = new Set(sessionIds(d));
  const r = await council(d, lang, args);
  const id = sessionIds(d).find((x) => !before.has(x));
  if (!id) throw new Error(`session not created:\n${dump(r)}`);
  return { id, r };
}
const journal = (d: string, id: string) => join(d, "sessions", id, "events.jsonl");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
type Ev = Record<string, any> & { type: string };
const events = (d: string, id: string): Ev[] => readFileSync(journal(d, id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const TOPIC = "Topic";
/** Session p1 + p2, p2 crashes at once: failed, insufficient_active_participants, the journal holds the reason in the launch language. */
async function failedSession(d: string, lang: Language, tag: string) {
  const p1 = scen(d, `${tag}-p1`, [amend("V1"), ...agrees(8)]);
  const p2 = scen(d, `${tag}-p2`, [crash()]);
  return newSession(d, lang, ["--topic", TOPIC, ...parts(p1, p2), "--max-rounds", "2"]);
}

// =====================================================================
// Steps 1 and 2. Calls with invalid input in both languages
// =====================================================================
interface Case {
  key: string;
  dir: string;
  args: (id: string) => string[];
  /** Core text in language l; null: no core text in the output (cli.ts frame). */
  core: ((l: Language, id: string) => string) | null;
}
const base = dataDir("base");
mkdirSync(join(base, "in"), { recursive: true });
writeFileSync(join(base, "in", ".env"), "");
const okScen = scen(base, "ok", [amend("V1"), ...agrees(4)]);
const okScen2 = scen(base, "ok2", agrees(4));
const two = parts(okScen, okScen2);
const provDir = dataDir("prov", {
  providers: [{ id: "a", label: "A", models: [], kind: "cli", agent: "claude", path: "/nonexistent/claude" }],
  defaults: DEFAULTS,
});
const done = await newSession(base, "ru", ["--topic", TOPIC, ...two, "--max-rounds", "2"]);
const doneStatus = readSession(base, done.id)!.status;
check("preparation: the session for say finished with consensus", doneStatus === "consensus" && done.r.code === 0, `status ${doneStatus}\n${dump(done.r)}`);

const cases: Case[] = [
  { key: "no topic", dir: base, args: () => [...two], core: null },
  { key: "one participant", dir: base, args: () => ["--topic", TOPIC, ...parts(okScen)], core: (l) => engineMessages(l).tooFewParticipants(1) },
  { key: "--attach of a nonexistent path", dir: base, args: () => ["--topic", TOPIC, ...two, "--attach", join(base, "in", "nonexist")], core: (l) => materialsMessages(l).pathNamed("nonexist", materialsMessages(l).pathNotFound) },
  { key: "--attach of a .env file", dir: base, args: () => ["--topic", TOPIC, ...two, "--attach", join(base, "in", ".env")], core: (l) => materialsMessages(l).pathNamed(".env", materialsMessages(l).envRefused) },
  { key: "--url http://127.0.0.1/", dir: base, args: () => ["--topic", TOPIC, ...two, "--url", "http://127.0.0.1/"], core: (l) => materialsMessages(l).pathNamed("http://127.0.0.1/", materialsMessages(l).urlPrivate("127.0.0.1")) },
  { key: "unknown template", dir: base, args: () => ["--topic", TOPIC, ...two, "--template", "no-such-template"], core: (l) => templateMessages(l).unknownTemplate("no-such-template") },
  { key: "resume of a nonexistent session", dir: base, args: () => ["resume", "nope"], core: (l) => resumeMessages(l).notFound("nope") },
  { key: "say into a finished session", dir: base, args: (id) => ["say", id, "hello"], core: (l, id) => storeMessages(l).sessionFinished(id, "consensus") },
  { key: "providers: nonexistent CLI command", dir: provDir, args: () => ["providers"], core: (l) => providerMessages(l).cliNotFoundAtPath("claude", "/nonexistent/claude") },
];

const codes: Record<string, Record<string, number | null>> = {};
async function runCase(c: Case, lang: Language | undefined, expectLang: Language, label: string): Promise<void> {
  const r = await council(c.dir, lang, c.args(done.id));
  (codes[c.key] ??= {})[label] = r.code;
  if (!c.core) return;
  const want = c.core(expectLang, done.id), notWant = c.core(other(expectLang), done.id);
  check(`${label}: ${c.key}: core text in ${expectLang}`, r.all.includes(want), `expected: ${want}\n${dump(r)}`);
  check(`${label}: ${c.key}: no text in ${other(expectLang)}`, !r.all.includes(notWant), `extra: ${notWant}\n${dump(r)}`);
}
console.log("\n== 1. Default language (COUNCIL_LANG not set, no preferences.json) ==");
check("no preferences.json in the data folder", !existsSync(join(base, "preferences.json")));
for (const c of cases) await runCase(c, undefined, "en", "default");
console.log("\n== 2. COUNCIL_LANG=ru; preferences.json; variable priority ==");
for (const c of cases) await runCase(c, "ru", "ru", "ru");
for (const c of cases) {
  const a = codes[c.key]!;
  check(`exit codes are equal (default and ru): ${c.key}`, a["default"] === a["ru"] && a["ru"] === 2 - (c.key.startsWith("providers") ? 2 : 0), `default ${a["default"]}, ru ${a["ru"]}`);
}
const prefDir = dataDir("pref");
writeFileSync(join(prefDir, "preferences.json"), JSON.stringify({ language: "ru" }));
const sub = (keys: string[]) => cases.filter((c) => keys.includes(c.key)).map((c) => ({ ...c, dir: c.dir === base ? prefDir : c.dir }));
for (const c of sub(["one participant", "resume of a nonexistent session", "--attach of a .env file"])) await runCase(c, undefined, "ru", "preferences ru, no variable");
for (const c of sub(["one participant", "resume of a nonexistent session", "--attach of a .env file"])) await runCase(c, "en", "en", "preferences ru, COUNCIL_LANG=en");
for (const c of sub(["resume of a nonexistent session"])) await runCase(c, "ru", "ru", "preferences ru, COUNCIL_LANG=ru");

// =====================================================================
// Step 3. Invalid files in the data folder
// =====================================================================
console.log("\n== 3. Invalid files in the data folder ==");
const issue = (l: Language, path: string, reason: string) => `${path}: ${reason}`;
const zArray = (l: Language) => zodMessages(l).expected(zodMessages(l).array);
const cfgCases: { key: string; config: unknown; want: (l: Language) => string[] }[] = [
  {
    key: "config.json: extra field and wrong type",
    config: { providers: [{ id: "a", label: "A", models: [], kind: "cli", agent: "claude", extra: 1 }, { id: "b", label: "B", models: "x", kind: "cli", agent: "codex" }], defaults: DEFAULTS },
    want: (l) => [issue(l, "providers.0", zodMessages(l).extraField("«extra»")), issue(l, "providers.1.models", zArray(l))],
  },
  {
    key: "config.json: duplicate id",
    config: { providers: [{ id: "a", label: "A", models: [], kind: "cli", agent: "claude" }, { id: "a", label: "B", models: [], kind: "cli", agent: "codex" }], defaults: DEFAULTS },
    want: (l) => [issue(l, "providers.1.id", registryMessages(l).duplicateProviderId("a"))],
  },
  {
    key: "config.json: reference to a missing provider",
    config: { providers: [], defaults: { ...DEFAULTS, participants: [{ providerId: "zz", model: "m" }] } },
    want: (l) => [issue(l, "defaults.participants.0.providerId", registryMessages(l).providerNotFound("zz"))],
  },
];
for (const c of cfgCases) {
  const d = dataDir(`cfg-${cfgCases.indexOf(c)}`, c.config);
  const runArgs = ["--topic", TOPIC, ...parts(okScen, okScen2)];
  const outputs: Record<string, R> = {};
  for (const l of LANGS) {
    for (const [cmd, args] of [["providers", ["providers"]], ["session start", runArgs]] as const) {
      const r = await council(d, l, [...args]);
      outputs[`${l}/${cmd}`] = r;
      for (const w of c.want(l)) check(`${c.key}: ${cmd}: ${l}: ${w}`, r.err.includes(w), dump(r));
      for (const w of c.want(other(l))) if (!c.want(l).includes(w)) check(`${c.key}: ${cmd}: ${l}: no text in ${other(l)}`, !r.err.includes(w), dump(r));
      check(`${c.key}: ${cmd}: ${l}: code 2`, r.code === 2, dump(r));
    }
  }
  check(`${c.key}: field path is the same in both languages`, c.want("en").every((w, i) => w.split(": ")[0] === c.want("ru")[i]!.split(": ")[0]));
}
{
  const d = dataDir("lineups");
  const variants: { key: string; body: unknown; want: (l: Language) => string }[] = [
    { key: "root is not an array", body: {}, want: (l) => registryMessages(l).lnInvalid(`${zodMessages(l).root}: ${zArray(l)}`) },
    { key: "extra participant field", body: [{ id: "l1", name: "A", participants: [{ providerId: "a", model: "m", role: null, zz: 1 }, { providerId: "a", model: "m", role: null }] }], want: (l) => registryMessages(l).lnInvalid(`0.participants.0: ${zodMessages(l).extraField("«zz»")}`) },
  ];
  for (const v of variants) {
    writeFileSync(join(d, "lineups.json"), JSON.stringify(v.body));
    for (const l of LANGS) {
      const r = await council(d, l, ["lineups"]);
      check(`lineups.json (${v.key}): ${l}: reason with path in ${l}`, r.err.includes(v.want(l)), `expected: ${v.want(l)}\n${dump(r)}`);
      check(`lineups.json (${v.key}): ${l}: no text in ${other(l)}`, !r.err.includes(v.want(other(l))), dump(r));
      check(`lineups.json (${v.key}): ${l}: code 2`, r.code === 2, dump(r));
    }
  }
}
{
  const d = dataDir("templates");
  mkdirSync(join(d, "templates"), { recursive: true });
  writeFileSync(join(d, "templates", "bad.json"), JSON.stringify({ id: "bad", title: 5 }));
  writeFileSync(join(d, "templates", "broken.json"), "{");
  for (const l of LANGS) {
    const r = await council(d, l, ["templates"]);
    const wants = [`title: ${zodMessages(l).expected(zodMessages(l).string)}`, `category: ${templateMessages(l).missingField}`, `${templateMessages(l).notJson("")}`];
    for (const w of wants) check(`template with an error: ${l}: ${w}`, r.out.includes(w), dump(r));
    check(`template with an error: ${l}: no text in ${other(l)}`, !r.out.includes(templateMessages(other(l)).missingField) && !r.out.includes(`title: ${zodMessages(other(l)).expected(zodMessages(other(l)).string)}`), dump(r));
    check(`template with an error: ${l}: code 0`, r.code === 0, dump(r));
  }
}
{
  // The council terminal does not show tariffs.json: reasons are checked by calling readTariffs in the stand process.
  const d = dataDir("tariffs");
  const bodies = [
    { key: "entry with errors", body: JSON.stringify({ tariffs: [{ providerId: "", bogus: 1 }] }), want: (l: Language) => [protocolMessages(l).entryNonEmpty, protocolMessages(l).entryUnknownField, "bogus: "] },
    { key: "not JSON", body: "{", want: (l: Language) => [protocolMessages(l).tariffsNotJson("tariffs.json")] },
    { key: "wrong shape", body: "[]", want: (l: Language) => [protocolMessages(l).tariffsBadShape("tariffs.json")] },
  ];
  for (const b of bodies) {
    writeFileSync(join(d, "tariffs.json"), b.body);
    const got: Record<string, string> = {};
    for (const l of LANGS) {
      setProcessLanguage(l);
      got[l] = readTariffs(d).warnings.join("\n");
      for (const w of b.want(l)) check(`tariffs.json (${b.key}), readTariffs module: ${l}: ${w}`, got[l].includes(w), got[l]);
    }
    setProcessLanguage("en");
    check(`tariffs.json (${b.key}), readTariffs module: languages differ`, got["en"] !== got["ru"]);
  }
}

// =====================================================================
// Step 4. Mixed journal: written in ru, continued in en
// =====================================================================
console.log("\n== 4. Mixed journal ==");
const mixed = dataDir("mixed");
const ruMsg = { drop: (m = "Scripted failure") => engineMessages("ru").dropNonRetryable(m), reason: finishMessages("ru").insufficientActive };
const enMsg = { drop: (m = "Scripted failure") => engineMessages("en").dropNonRetryable(m), reason: finishMessages("en").insufficientActive };
const p2name = (d: string, id: string): string => events(d, id)[0]!.session.participants[1].name;
const fin = (es: Ev[]) => es.findLast((e) => e.type === "session_finished")!;
const dropped = (es: Ev[]) => es.filter((e) => e.type === "participant_dropped");
for (const [tag, replacementSteps, wantStatus] of [["4a", agrees(8), "consensus"], ["4b", [crash()], "failed"]] as [string, S[], string][]) {
  const f = await failedSession(mixed, "ru", tag);
  const before = readFileSync(journal(mixed, f.id));
  const esBefore = events(mixed, f.id);
  check(`${tag}: original session: failed, code insufficient_active_participants`, fin(esBefore).status === "failed" && fin(esBefore).reasonCode === "insufficient_active_participants", dump(f.r));
  check(`${tag}: the earlier part has Russian reasons`, dropped(esBefore)[0]?.reason === ruMsg.drop() && fin(esBefore).reason === ruMsg.reason, JSON.stringify([dropped(esBefore), fin(esBefore).reason]));
  const repl = scen(mixed, `${tag}-repl`, replacementSteps);
  const r = await council(mixed, "en", ["resume", f.id, "--replace", `p2=scripted:${repl}`]);
  const after = readFileSync(journal(mixed, f.id));
  check(`${tag}: the journal grew and the first ${before.length} bytes match by sha256`, after.length > before.length && sha(after.subarray(0, before.length)) === sha(before), `was ${before.length}, now ${after.length}`);
  const es = events(mixed, f.id), added = es.slice(esBefore.length);
  const resumed = added.find((e) => e.type === "session_resumed");
  check(`${tag}: replacement name in en by default`, resumed?.replacements?.[0]?.participant?.name === resumeMessages("en").defaultName(3), JSON.stringify(resumed));
  check(`${tag}: earlier entries read as before (the Russian drop reason is in place)`, es[esBefore.length - 1]!.type === "session_finished" && dropped(es)[0]?.reason === ruMsg.drop());
  if (wantStatus === "failed") {
    check(`${tag}: new drop reason of the replacement in en`, dropped(added)[0]?.reason === enMsg.drop(), JSON.stringify(dropped(added)));
    check(`${tag}: new result: reason in en, same code`, fin(added).reason === enMsg.reason && fin(added).reasonCode === "insufficient_active_participants", JSON.stringify(fin(added)));
    check(`${tag}: exit code 5 (failed)`, r.code === 5, dump(r));
  } else {
    check(`${tag}: resume reached consensus, code 0`, fin(added).status === "consensus" && r.code === 0, dump(r));
  }
  let folded = false;
  try { folded = foldEvents(es as never).finish?.status === wantStatus; } catch (e) { check(`${tag}: journal fold without errors`, false, String(e)); }
  check(`${tag}: folding the mixed journal gives ${wantStatus}`, folded);
  check(`${tag}: readSession reads the mixed journal`, readSession(mixed, f.id)?.status === wantStatus);
  if (tag === "4b") (globalThis as any).mixedFailed = f.id;
}

// =====================================================================
// Step 5. Showing the reason by code (council show)
// =====================================================================
console.log("\n== 5. Showing the reason by code ==");
{
  const ru = await failedSession(mixed, "ru", "5ru"), en = await failedSession(mixed, "en", "5en");
  const fRu = fin(events(mixed, ru.id)), fEn = fin(events(mixed, en.id));
  check("5: the ru session journal holds Russian text, the en journal English", fRu.reason === ruMsg.reason && fEn.reason === enMsg.reason, JSON.stringify([fRu.reason, fEn.reason]));
  const show = async (id: string, l: Language) => council(mixed, l, ["show", id]);
  for (const [name, id, l] of [["journal ru, shown in en", ru.id, "en"], ["journal en, shown in ru", en.id, "ru"], ["journal ru, shown in ru", ru.id, "ru"], ["journal en, shown in en", en.id, "en"], ["journal ru (after resume, result en), shown in ru", (globalThis as any).mixedFailed, "ru"]] as const) {
    const r = await show(id, l);
    check(`5: council show (${name}): reason ${l} by code`, r.out.includes(cliMessages(l).reason(finishMessages(l).insufficientActive)) && !r.out.includes(finishMessages(other(l)).insufficientActive), dump(r));
  }
  // Showing the result of the run itself: the process writes the session in one language and prints the result by code in the same process.
  check("5: run result (ru): reason by code in ru", ru.r.out.includes(cliMessages("ru").reason(finishMessages("ru").insufficientActive)), dump(ru.r));
  check("5: run result (en): reason by code in en", en.r.out.includes(cliMessages("en").reason(finishMessages("en").insufficientActive)), dump(en.r));
  // Module: finishReasonText over the state from the journal; an unknown code gives the recorded text.
  const st = readSession(mixed, en.id)!.state.finish!;
  check("5: finishReasonText module: known code gives the catalog text, not the recorded one", finishReasonText(st, "ru") === finishMessages("ru").insufficientActive && finishReasonText(st, "en") === finishMessages("en").insufficientActive);
  check("5: finishReasonText module: unknown code gives the recorded text", finishReasonText({ reason: "recorded text", reasonCode: "unknown_code" }, "en") === "recorded text" && finishReasonText({ reason: "recorded text", reasonCode: null }, "ru") === "recorded text");
}

// =====================================================================
// Step 6. Resume refusals in both languages
// =====================================================================
console.log("\n== 6. Resume refusals ==");
{
  const d = dataDir("refuse");
  const U = (t: number, n: number): S => ({ response: { stance: "amend", reasoning: "r", solution: `V${n}`, answers: [], questions: [] }, inputTokens: t, outputTokens: t });
  const consensus = await newSession(d, "ru", ["--topic", TOPIC, ...parts(scen(d, "c1", [amend("V1"), ...agrees(4)]), scen(d, "c2", agrees(4))), "--max-rounds", "2"]);
  const tokenCap = await newSession(d, "ru", ["--topic", TOPIC, ...parts(scen(d, "t1", [U(150, 1), U(150, 2), U(150, 3), U(150, 4)]), scen(d, "t2", [U(150, 5), U(150, 6), U(150, 7), U(150, 8)])), "--max-rounds", "3", "--max-tokens", "1500"]);
  const noRounds = await newSession(d, "ru", ["--topic", TOPIC, ...parts(scen(d, "n1", [amend("V1"), amend("V2")]), scen(d, "n2", [amend("V3"), amend("V4")])), "--max-rounds", "1"]);
  const synth = await newSession(d, "ru", ["--topic", TOPIC, "--drafts", "--synthesizer", "p2", "--max-rounds", "1",
    ...parts(scen(d, "s1", [amend("D1"), ...agrees(3)]), scen(d, "s2", [crash(), ...agrees(3)]), scen(d, "s3", [amend("D3"), ...agrees(3)]))]);
  // Journal of a process that died before writing the result (as in the independent drafts stand): without the last session_finished line.
  const lines = readFileSync(journal(d, synth.id), "utf8").split("\n").filter(Boolean);
  check("6: preparation: the synthesizer dropped out, result synthesizer_unavailable", JSON.parse(lines.at(-1)!).reason === "synthesizer_unavailable", dump(synth.r));
  writeFileSync(journal(d, synth.id), `${lines.slice(0, -1).join("\n")}\n`);
  const spent = tokenUsage(readSession(d, tokenCap.id)!.state).total;
  const refusals: { key: string; id: string; args: string[]; planOpts: Parameters<typeof planResume>[2]; reason: string; text: (l: Language) => string }[] = [
    { key: "consensus", id: consensus.id, args: [], planOpts: {}, reason: "consensus", text: (l) => resumeMessages(l).consensus(consensus.id) },
    { key: "token_cap: cap exhausted", id: tokenCap.id, args: [], planOpts: {}, reason: "token_cap", text: (l) => resumeMessages(l).tokenCapExhausted(tokenCap.id, 1500, spent) },
    { key: "token_cap: new cap below the spent amount", id: tokenCap.id, args: ["--max-tokens", "100"], planOpts: { maxTotalTokens: 100 }, reason: "token_cap", text: (l) => resumeMessages(l).tokenCapBelowSpent(tokenCap.id, 100, spent) },
    { key: "replacement: unknown participant", id: noRounds.id, args: ["--replace", "p9=scripted:x"], planOpts: { replacements: [{ participantId: "p9", providerId: "scripted", model: "x" }] }, reason: "replacement", text: (l) => resumeMessages(l).repUnknown(noRounds.id, "p9") },
    { key: "synthesizer", id: synth.id, args: [], planOpts: {}, reason: "synthesizer", text: (l) => resumeMessages(l).synthesizer(synth.id, "p2", "Участник 2") },
  ];
  check("6: preparation: tokens counted (cap 1500, spent > 0)", spent > 0, `spent ${spent}`);
  for (const rf of refusals) {
    const before = readFileSync(journal(d, rf.id));
    const res: Record<string, R> = {}, plan: Record<string, { reason: string; message: string }> = {};
    for (const l of LANGS) {
      res[l] = await council(d, l, ["resume", rf.id, ...rf.args]);
      setProcessLanguage(l);
      try { planResume(d, rf.id, rf.planOpts); plan[l] = { reason: "(no refusal)", message: "" }; } catch (e) {
        plan[l] = e instanceof ResumeRejectedError ? { reason: e.reason, message: e.message } : { reason: `(${String(e)})`, message: "" };
      }
      check(`6: ${rf.key}: ${l}: code 2`, res[l]!.code === 2, dump(res[l]!));
      // The synthesizer participant name is written to the journal in the launch language: compare against the recorded name, not a literal.
      const name = rf.key === "synthesizer" ? p2name(d, rf.id) : "";
      const want = rf.key === "synthesizer" ? resumeMessages(l).synthesizer(rf.id, "p2", name) : rf.text(l);
      check(`6: ${rf.key}: ${l}: refusal text from resumeMessages`, res[l]!.err.includes(want), `expected: ${want}\n${dump(res[l]!)}`);
      check(`6: ${rf.key}: ${l}: no text in ${other(l)}`, !res[l]!.err.includes(rf.key === "synthesizer" ? resumeMessages(other(l)).synthesizer(rf.id, "p2", name) : rf.text(other(l))), dump(res[l]!));
    }
    setProcessLanguage("en");
    check(`6: ${rf.key}: planResume: reason ${rf.reason} in both languages`, plan["en"]!.reason === rf.reason && plan["ru"]!.reason === rf.reason, JSON.stringify(plan));
    check(`6: ${rf.key}: planResume: texts differ between the two languages`, plan["en"]!.message !== plan["ru"]!.message && plan["en"]!.message === (rf.key === "synthesizer" ? resumeMessages("en").synthesizer(rf.id, "p2", p2name(d, rf.id)) : rf.text("en")), JSON.stringify(plan));
    check(`6: ${rf.key}: exit codes are equal, journal unchanged`, res["en"]!.code === res["ru"]!.code && readFileSync(journal(d, rf.id)).equals(before));
  }
}

// =====================================================================
// Step 7. council output and help in the process language
// =====================================================================
console.log("\n== 7. council output and help ==");
{
  const CYR = /[А-Яа-яЁё]/;
  const d = dataDir("cli");
  const p1 = scen(d, "c1", [amend("V1"), ...agrees(4)]), p2 = scen(d, "c2", agrees(4));
  const runArgs = ["--topic", TOPIC, ...parts(p1, p2), "--max-rounds", "3"];
  const pair: Record<string, Record<string, number | null>> = {};
  const note = (key: string, label: string, r: R) => { (pair[key] ??= {})[label] = r.code; };
  for (const [label, lang, want] of [["default", undefined, "en"], ["ru", "ru", "ru"], ["en", "en", "en"]] as const) {
    const t = cliMessages(want);
    const h = await council(d, lang, ["--help"]);
    note("--help", label, h);
    check(`7: ${label}: help entirely from the catalog ${want}`, h.out.trim() === t.help && h.code === 0, dump(h));
    check(`7: ${label}: the help has a language source line, no language flag`, h.out.includes("COUNCIL_LANG") && !/--lang\b|--language\b/.test(h.out), dump(h));
    if (want === "en") check(`7: ${label}: help without Cyrillic`, !CYR.test(h.out), dump(h));
    const before = new Set(sessionIds(d));
    const s = await council(d, lang, runArgs);
    note("discussion", label, s);
    const id = sessionIds(d).find((x) => !before.has(x))!;
    check(`7: ${label}: discussion: status lines and result in ${want}`, s.code === 0 && s.out.includes(t.sessionHeader(id, 2, 3)) && s.out.includes(t.summary("consensus")) && s.out.includes(`${t.decision}\nV1`), dump(s));
    check(`7: ${label}: discussion: no frame in ${other(want)}`, !s.out.includes(cliMessages(other(want)).summary("consensus")), dump(s));
    if (want === "en") check(`7: ${label}: discussion output without Cyrillic (scenario replies are English)`, !CYR.test(s.all), dump(s));
    const raw = readFileSync(journal(d, id), "utf8");
    check(`7: ${label}: events.jsonl without council output texts`, LANGS.every((l) => !raw.includes(cliMessages(l).summary("consensus")) && !raw.includes(cliMessages(l).topic(TOPIC)) && !raw.includes(cliMessages(l).decision)), raw.slice(0, 300));
    const show = await council(d, lang, ["show", id]);
    check(`7: ${label}: show in ${want}`, show.code === 0 && show.out.includes(t.showStatus("consensus")), dump(show));
    const bad = await council(d, lang, ["--unknown-flag"]);
    note("--unknown-flag", label, bad);
    check(`7: ${label}: parse refusal in ${want}`, bad.code === 2 && bad.err.startsWith(t.error("Unknown option '--unknown-flag'")), dump(bad));
  }
  for (const [key, codes] of Object.entries(pair)) check(`7: exit codes are equal in all languages: ${key}`, new Set(Object.values(codes)).size === 1, JSON.stringify(codes));

  const fresh = join(work, "cli-not-yet");
  const nf = await council(fresh, undefined, ["--unknown-flag"]);
  check("7: refusal before the data folder is created: English, code 2, folder not created", nf.code === 2 && nf.err.startsWith(cliMessages("en").error("Unknown option")) && !existsSync(fresh), dump(nf));

  const pref = dataDir("cli-pref");
  writeFileSync(join(pref, "preferences.json"), JSON.stringify({ language: "ru" }));
  for (const [cmd, wantRu] of [["templates", cliMessages("ru").builtinSource], ["lineups", cliMessages("ru").noLineups], ["list", cliMessages("ru").noSessions]] as const) {
    const ru = await council(pref, undefined, [cmd]);
    check(`7: preferences.json ru: ${cmd} in Russian`, ru.code === 0 && ru.out.includes(wantRu), dump(ru));
  }
  const ruSess = await newSession(pref, undefined, runArgs);
  const ruShow = await council(pref, undefined, ["show", ruSess.id]);
  check("7: preferences.json ru: start and show in Russian", ruSess.r.out.includes(cliMessages("ru").summary("consensus")) && ruShow.out.includes(cliMessages("ru").showStatus("consensus")), dump(ruShow));
  const enT = await council(pref, "en", ["templates"]);
  check("7: preferences.json ru, COUNCIL_LANG=en: templates in English", enT.code === 0 && enT.out.includes(cliMessages("en").builtinSource) && !enT.out.includes(cliMessages("ru").builtinSource), dump(enT));
  const prefFile = readFileSync(join(pref, "preferences.json"), "utf8");
  check("7: preferences.json not changed by the commands", prefFile === JSON.stringify({ language: "ru" }));

  const broken = dataDir("cli-broken");
  writeFileSync(join(broken, "preferences.json"), "{ broken");
  const br = await council(broken, undefined, ["lineups"]);
  check("7: corrupted preferences.json: English, file unchanged", br.code === 0 && br.out.includes(cliMessages("en").noLineups) && readFileSync(join(broken, "preferences.json"), "utf8") === "{ broken", dump(br));

  const envDir = dataDir("cli-env");
  writeFileSync(join(envDir, ".env"), "COUNCIL_LANG=ru\n");
  const ev = await council(envDir, undefined, ["lineups"]);
  check("7: COUNCIL_LANG=ru from the data folder .env", ev.code === 0 && ev.out.includes(cliMessages("ru").noLineups), dump(ev));
}

console.log(`\nChecks ${passed} of ${total}.`);
console.log("Model calls: 0 (all participants scripted, no network).");
console.log(`Data folder: ${work}`);
process.exit(passed === total ? 0 : 1);
