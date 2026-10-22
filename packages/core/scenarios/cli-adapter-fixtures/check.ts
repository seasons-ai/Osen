// Check of the CLI adapter contract against the recorded turn fixtures (change 178): the real council process, stubs of `claude` and `codex`
// in the stand folder that print a fixture byte for byte (or a broken variant of it), 0 model calls, no network:
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the repository> node packages/core/scenarios/cli-adapter-fixtures/check.ts
// Without COUNCIL_HOME the stand creates <repository>/.council-data/adapter-fixtures-<timestamp>. The folder is deleted on success and kept on failure.
// Each case runs `council` with a scripted first participant and the stub CLI as the second one (--max-rounds 1) and reads the session journal:
// an accepted turn is a turn_completed event of p2 with the usage of the fixture, a rejected one is a turn_failed event without turn_completed.
// Children get a PATH with the stand bin and /usr/bin:/bin only and a fake login shell, so the real claude and codex are never launched.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isInsideRepo } from "../inside-repo.ts";
import { parseClaudeOutput, parseCodexOutput } from "../../src/cli-agents/output-parse.ts";
import { BUILTIN_RECORD } from "../../src/cli-agents/verified-record.ts";
import { listTurnFixtures, missingTurnFixtures } from "../../src/cli-agents/turn-fixtures.ts";
import type { CliAgent } from "../../src/cli-agents/types.ts";
import { writeCliStub, writeFakeShell } from "./capture.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the repository> node packages/core/scenarios/cli-adapter-fixtures/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const council = join(repo, "packages/core/src/council.ts");
const scripted = join(repo, "packages/core/scenarios/consensus/p1.json");
const given = process.env.COUNCIL_HOME ? resolve(process.env.COUNCIL_HOME) : undefined;
if (given && !isInsideRepo(repo, given)) {
  console.error(`COUNCIL_HOME must be inside the repository (${repo}): ${given}`);
  process.exit(2);
}
const work = given ?? join(repo, ".council-data", `adapter-fixtures-${Date.now()}`);
mkdirSync(work, { recursive: true });

type Lang = "en" | "ru";
interface Case {
  name: string; agent: CliAgent; version: string; turn: string; lang?: Lang;
  expect: "accepted" | "rejected"; reason?: RegExp; usage?: unknown; reply?: { stance: unknown; reasoning: unknown };
}
type Ev = Record<string, unknown>;
interface Outcome { code: number; all: string; completed?: Ev; failed: Ev[] }

let seq = 0;
function runCase(c: Case): Promise<Outcome> {
  const dir = join(work, `case-${++seq}`);
  const bin = join(dir, "bin"), home = join(dir, "data");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, "turn.out"), c.turn);
  writeCliStub(join(bin, c.agent), { agent: c.agent, version: c.version, turn: join(dir, "turn.out") });
  writeFakeShell(join(bin, "fake-shell"));
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, SHELL: join(bin, "fake-shell"), COUNCIL_DEV: "1", COUNCIL_HOME: home, COUNCIL_LANG: c.lang ?? "en" };
  const args = [council, "--topic", "Check the adapter contract", "--participant", `scripted:${scripted}`, "--participant", `${c.agent}:default`, "--max-rounds", "1"];
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let all = "";
    child.stdout.on("data", (d) => { all += d; });
    child.stderr.on("data", (d) => { all += d; });
    const timer = setTimeout(() => fail(new Error(`timeout: ${c.name}`)), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const sessions = join(home, "sessions");
      const id = readdirSync(sessions)[0];
      const events = !id ? [] : readFileSync(join(sessions, id, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Ev);
      const completed = events.find((e) => e.type === "turn_completed" && e.participantId === "p2");
      done({ code: code ?? -1, all, ...(completed ? { completed } : {}), failed: events.filter((e) => e.type === "turn_failed" && e.participantId === "p2") });
    });
  });
}

let total = 0, passed = 0;
function report(name: string, ok: boolean, detail = ""): void {
  total++;
  if (ok) passed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n       ${detail.slice(0, 800).replace(/\n/g, "\n       ")}`}`);
}

async function verify(requirement: string, c: Case): Promise<void> {
  const label = `${requirement}: ${c.name} (${c.lang ?? "en"})`;
  let o: Outcome;
  try { o = await runCase(c); } catch (e) { return report(label, false, String(e)); }
  const dump = `exit ${o.code}\n${o.all}\nfailed: ${JSON.stringify(o.failed)}`;
  if (c.expect === "accepted") {
    const usage = (o.completed?.usage ?? undefined) as unknown;
    // the reply of the fixture reached the journal unchanged: its stance and reasoning, plus the usage the CLI reported
    const sameReply = !!o.completed && o.completed.stance === c.reply?.stance && o.completed.reasoning === c.reply?.reasoning;
    return report(label, o.code === 0 && !!o.completed && o.failed.length === 0 && sameReply && JSON.stringify(usage) === JSON.stringify(c.usage), `${dump}\ncompleted: ${JSON.stringify(o.completed)}\nwanted usage: ${JSON.stringify(c.usage)}`);
  }
  const reason = o.failed.map((e) => String(e.message)).join("\n");
  const langOk = c.lang === "ru" ? /[А-Яа-яЁё]/.test(reason.split("\n")[0]!) : true;
  report(label, o.code !== 0 && !o.completed && o.failed.length > 0 && (c.reason?.test(reason) ?? true) && langOk, `${dump}\nreason: ${reason}`);
}

const fixtures = listTurnFixtures();
const bytes = (f: { file: string }) => readFileSync(f.file, "utf8");
const parseOf = (f: { agent: CliAgent; version: string; file: string }) => (f.agent === "claude" ? parseClaudeOutput : parseCodexOutput)(bytes(f), f.version);
const usageOf = (f: { agent: CliAgent; version: string; file: string }) => { const p = parseOf(f); return p.ok ? p.usage : undefined; };
const replyOf = (f: { agent: CliAgent; version: string; file: string }) => { const p = parseOf(f); return p.ok ? JSON.parse(p.text) as { stance: unknown; reasoning: unknown } : undefined; };
const lines = (f: { file: string }) => bytes(f).split("\n").filter(Boolean);

// Versioned parsing
for (const f of fixtures) await verify("Versioned parsing", { name: `${f.agent} ${f.version}${f.synthetic ? " (synthetic)" : ""} fixture is accepted`, agent: f.agent, version: f.version, turn: bytes(f), expect: "accepted", usage: usageOf(f), reply: replyOf(f) });
for (const agent of ["claude", "codex"] as const) {
  const f = fixtures.find((x) => x.agent === agent);
  if (f) await verify("Versioned parsing", { name: `${agent} 9.9.9 (newer than all branches) is parsed, the start is not refused`, agent, version: "9.9.9", turn: bytes(f), expect: "accepted", usage: usageOf(f), reply: replyOf(f) });
}

// Strict required fields
const claudeFx = fixtures.find((x) => x.agent === "claude");
const codexFx = fixtures.find((x) => x.agent === "codex");
if (claudeFx) {
  const badFlag = JSON.stringify({ ...(JSON.parse(lines(claudeFx)[0]!) as Ev), is_error: "no" }) + "\n";
  for (const lang of ["en", "ru"] as const) await verify("Strict required fields", { name: "claude is_error \"no\" is rejected", agent: "claude", version: claudeFx.version, turn: badFlag, lang, expect: "rejected", reason: /is_error/ });
}

// Unknown is skipped
if (claudeFx) {
  const extra = JSON.stringify({ ...(JSON.parse(lines(claudeFx)[0]!) as Ev), future_field: { a: 1 } });
  await verify("Unknown is skipped", { name: "claude unknown field and unknown event line", agent: "claude", version: claudeFx.version, turn: `${JSON.stringify({ type: "future_event", n: 1 })}\nnot json at all\n${extra}\n`, expect: "accepted", usage: usageOf(claudeFx), reply: replyOf(claudeFx) });
}
if (codexFx) {
  const ls = lines(codexFx).map((l) => JSON.parse(l) as Ev);
  const turn = [{ type: "future.event", n: 1 }, ...ls.map((e) => (e.type === "turn.completed" ? { ...e, future_field: [1] } : e))].map((e) => JSON.stringify(e)).join("\n");
  await verify("Unknown is skipped", { name: "codex unknown field, unknown event and a non-JSON line", agent: "codex", version: codexFx.version, turn: `${turn}\nnot json at all\n`, expect: "accepted", usage: usageOf(codexFx), reply: replyOf(codexFx) });
}

// Errors and isolation events are not ignored
if (codexFx) {
  const tool = JSON.stringify({ type: "item.started", item: { id: "item_9", type: "command_execution", command: "ls" } });
  const turn = lines(codexFx).flatMap((l, i) => (i === 1 ? [l, tool] : [l])).join("\n") + "\n";
  for (const lang of ["en", "ru"] as const) await verify("Errors and isolation events", { name: "codex fixture plus a command_execution item is rejected, the reason names the tool", agent: "codex", version: codexFx.version, turn, lang, expect: "rejected", reason: /command_execution/ });
}

// Stub processes
if (claudeFx) {
  const text = bytes(claudeFx);
  for (const lang of ["en", "ru"] as const) await verify("Stub processes", { name: "truncated JSON with exit 0 is rejected", agent: "claude", version: claudeFx.version, turn: text.slice(0, Math.floor(text.length / 2)), lang, expect: "rejected" });
}

// Fixtures of recorded versions
const missing = missingTurnFixtures(BUILTIN_RECORD, fixtures);
report("Fixtures of recorded versions: every built-in record entry has a fixture", missing.length === 0, JSON.stringify(missing));
console.log(`synthetic fixtures: ${fixtures.filter((f) => f.synthetic).length}`);

console.log(`\n${passed} of ${total}`);
if (passed === total) rmSync(work, { recursive: true, force: true }); else console.log(`Folder left in place: ${work}`);
process.exit(passed === total ? 0 : 1);
