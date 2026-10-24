// Check of "Bounded fenced response extraction" (CodeQL js/polynomial-redos in extractJsonObject, quadratic per-brace scan), 0 model calls:
//   COUNCIL_DEV=1 node packages/core/scenarios/security-turn-response/check.ts [--mutant]
// 1. Direct probes: probe.ts times extractJsonObject on '```' + '_'.repeat(1,048,576) (fence family) and on '{'.repeat(1,048,576)
//    (brace family), each in a child with a 5,000 ms watchdog; the median of three samples must be <= 1,000 ms.
//    Sizes 1,024, 4,096 and 16,384 are printed as diagnostics.
// 2. Real `council` CLI (COUNCIL_LANG=en, 30 s watchdog per child) against a local HTTP stand with scripted raw answers:
//    A) a 262,144-underscore malformed fence -> correction request -> valid fenced amendment -> consensus, bounded raw in the journal;
//    B) plain JSON, fenced JSON after an explanation and a file request reach consensus, the file is served;
//    C) independent drafts (scripted participants) with fenced JSON drafts reach parseDraftResponse;
//    D) an unpaired "{ " before the JSON turn is accepted without a correction request and reaches consensus.
// --mutant: the probes run on a copy of packages/core/src with the reported expression and the former per-brace scan restored;
//    the stand must exit nonzero, naming each family.
// The stand creates .council-data/security-2-* itself and deletes it on success.
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { RAW_LIMIT } from "../../src/protocol/parse.ts";

if (process.env.COUNCIL_DEV !== "1") { console.error("COUNCIL_DEV=1 is required. Usage: COUNCIL_DEV=1 node packages/core/scenarios/security-turn-response/check.ts [--mutant]"); process.exit(2); }
const mutant = process.argv.includes("--mutant");
const repo = resolve(import.meta.dirname, "../../../..");
const core = join(repo, "packages/core");
const work = join(repo, ".council-data", `security-2-${Date.now()}`);
mkdirSync(work, { recursive: true });
const run = promisify(execFile);

let total = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n       ${detail.slice(0, 700)}` : ""}`);
}

async function supervised(file: string, args: string[], timeout: number, env: Record<string, string> = {}) {
  const started = performance.now();
  const pending = run(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...env } });
  pending.child.stdin?.end();
  try {
    const { stdout, stderr } = await pending;
    return { ok: true as const, code: 0, stdout, stderr, ms: performance.now() - started };
  } catch (e) {
    const err = e as { killed?: boolean; signal?: string; code?: number; message: string; stdout?: string; stderr?: string };
    return {
      ok: false as const, code: typeof err.code === "number" ? err.code : -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "", ms: performance.now() - started,
      why: err.killed ? `watchdog ${timeout} ms exceeded (${err.signal})` : err.message,
    };
  }
}

// ---------- 1. direct probe ----------
let parseTs = join(core, "src/protocol/parse.ts");
if (mutant) {
  const copy = join(work, "mutant-src");
  cpSync(join(core, "src"), copy, { recursive: true });
  parseTs = join(copy, "protocol/parse.ts");
  const source = readFileSync(parseTs, "utf8");
  const restored = source.replace(
    "for (const body of fencedBodies(raw)) {\n    const obj = tryObject(body.trim());",
    "for (const m of raw.matchAll(/```[^\\n`]*\\n?([\\s\\S]*?)```/g)) {\n    const obj = tryObject((m[1] ?? \"\").trim());");
  check("mutation copy restores the reported expression", restored !== source && restored.includes("matchAll(/```[^\\n`]*\\n?([\\s\\S]*?)```/g)"));
  // The former per-brace scan: every "{" scans to the end of the text when it has no pair.
  const former = restored
    .replace("export function extractJsonObject", `function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\\\") i++;
      else if (c === "\\"") inString = false;
    } else if (c === "\\"") inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

export function extractJsonObject`)
    .replace("  const ends = balancedEnds(raw);\n", "")
    .replace("const end = ends[i]!;", "const end = matchingBrace(raw, i);");
  check("mutation copy restores the former per-brace scan", former !== restored && former.includes("matchingBrace(raw, i)") && !former.includes("balancedEnds(raw)"));
  writeFileSync(parseTs, former);
}
const N = 1_048_576;
for (const [family, label] of [["fence", "'```' + '_'"], ["brace", "'{'"]] as const) {
  const probe = await supervised(process.execPath, [join(import.meta.dirname, "probe.ts"), parseTs, String(N), "1024,4096,16384", family], 5_000);
  if (probe.ok) {
    const r = JSON.parse(probe.stdout) as { family: string; n: number; samples: number[]; median: number; diagnostics: Array<{ n: number; ms: number }>; node: string; platform: string; arch: string; cpu: string };
    console.log(`       ${family}: n=${r.n} samples=${r.samples.map((s) => s.toFixed(2)).join(",")} ms median=${r.median.toFixed(2)} ms child=${probe.ms.toFixed(0)} ms`);
    console.log(`       diagnostics ${r.diagnostics.map((d) => `n=${d.n}:${d.ms.toFixed(3)}ms`).join(" ")}; node ${r.node} ${r.platform}/${r.arch} ${r.cpu}`);
    check(`${label} family: probe median <= 1,000 ms at n=${N}`, r.family === family && r.n === N && r.samples.length === 3 && r.median <= 1_000, `median ${r.median} ms`);
  } else {
    check(`${label} family: probe child finishes before the 5,000 ms watchdog at n=${N}`, false, `${probe.why}; supervisor stayed responsive, child settled after ${probe.ms.toFixed(0)} ms`);
  }
}

// ---------- 2. real council against a local HTTP stand ----------
let standRequests = 0;
if (!mutant) {
  const BIG = 262_144;
  const turn = (stance: string, solution: string | null, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ stance, reasoning: "Scripted stand reasoning.", solution, answers: [], questions: [], ...extra });
  const amend = (s: string) => turn("amend", s);
  const agree = turn("agree", null);
  // Per-model scripted raw answers; a "@adversarial" entry is generated here, never put in argv. The last entry repeats.
  const scripts: Record<string, string[]> = {
    "adv-1": ["@adversarial", "I fixed it:\n```json\n" + amend("Name the cat Ginger.") + "\n```\nDone.", agree],
    "adv-2": [agree],
    "mix-1": [turn("object", null, { files: ["notes.md"] }), "Here is my proposal.\n```json\n" + amend("Keep notes.md as is.") + "\n```", agree],
    "mix-2": [agree],
    "brace-1": ["{ " + amend("Name the cat Ginger."), agree],
    "brace-2": [agree],
  };
  const calls: Record<string, number> = {};
  const prompts: Record<string, string[]> = {};
  const sse = (res: import("node:http").ServerResponse, text: string) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    for (let i = 0; i < text.length; i += 16384) send({ choices: [{ index: 0, delta: { role: "assistant", content: text.slice(i, i + 16384) }, finish_reason: null }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    send({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    res.end("data: [DONE]\n\n");
  };
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      standRequests++;
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: Object.keys(scripts).map((id) => ({ id, object: "model" })) }));
      }
      const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") as { model?: string; messages?: Array<{ content: string }> };
      const model = body.model ?? "";
      const steps = scripts[model];
      if (req.method !== "POST" || req.url !== "/v1/chat/completions" || !steps) { res.writeHead(404); return res.end("{}"); }
      const n = calls[model] = (calls[model] ?? 0) + 1;
      (prompts[model] ??= []).push(body.messages?.[0]?.content ?? "");
      const step = steps[Math.min(n, steps.length) - 1]!;
      sse(res, step === "@adversarial" ? "```" + "_".repeat(BIG) : step);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    providers: [{ id: "stand", kind: "openai-http", label: "Local stand", models: [], baseUrl }],
    defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, participants: [] },
  }, null, 2));
  const material = join(work, "materials");
  mkdirSync(material, { recursive: true });
  writeFileSync(join(material, "notes.md"), "# Notes\nStand file for the file request.\n");
  const env = { PATH: process.env.PATH ?? "", HOME: work, COUNCIL_DEV: "1", COUNCIL_HOME: home, COUNCIL_LANG: "en" };
  const council = (args: string[]) => supervised(process.execPath, [join(core, "src/council.ts"), ...args], 30_000, env);
  const journal = (out: string) => {
    const id = /^Session (\S+) ·/m.exec(out)?.[1];
    if (!id) return [];
    return readFileSync(join(home, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  };
  const ofType = (ev: Record<string, any>[], t: string) => ev.filter((e) => e.type === t);

  // Case A
  const a = await council(["--topic", "Name the cat", "--participant", "stand:adv-1", "--participant", "stand:adv-2", "--max-rounds", "3"]);
  console.log(`       case A: ${a.ms.toFixed(0)} ms, exit ${a.code}${a.ok ? "" : `, ${a.why}`}`);
  const ea = journal(a.stdout);
  const failedTurns = ofType(ea, "turn_failed");
  check("A: exit 0 within the 30 s watchdog", a.ok, `${(a as { why?: string }).why}\n${a.stdout.slice(-500)}\n${a.stderr.slice(-500)}`);
  check("A: invalid-response path printed", /No JSON object found in the answer/.test(a.stdout + a.stderr), (a.stdout + a.stderr).slice(-700));
  check("A: session reaches consensus", ofType(ea, "session_finished")[0]?.status === "consensus", JSON.stringify(ofType(ea, "session_finished")));
  check(`A: stored raw failure is bounded (<= ${RAW_LIMIT} + marker, not 262,144)`,
    failedTurns.length >= 1 && failedTurns.every((e) => typeof e.raw === "string" && e.raw.length < RAW_LIMIT + 200 && e.raw.length > 1000),
    JSON.stringify(failedTurns.map((e) => e.raw?.length)));
  check("A: completed turns recorded; adv-1 took the adversarial call and the correction", ofType(ea, "turn_completed").length >= 2 && (calls["adv-1"] ?? 0) >= 2, JSON.stringify(calls));

  // Case B
  const b = await council(["--topic", "Check notes.md", "--attach", material, "--participant", "stand:mix-1", "--participant", "stand:mix-2", "--max-rounds", "3"]);
  console.log(`       case B: ${b.ms.toFixed(0)} ms, exit ${b.code}${b.ok ? "" : `, ${b.why}`}`);
  const eb = journal(b.stdout);
  check("B: exit 0 within the watchdog", b.ok, `${(b as { why?: string }).why}\n${b.stdout.slice(-500)}\n${b.stderr.slice(-500)}`);
  check("B: consensus with a file request, fenced answer and plain answers", ofType(eb, "session_finished")[0]?.status === "consensus", JSON.stringify(ofType(eb, "session_finished")));
  check("B: requested file was served", ofType(eb, "turn_files_served").length >= 1 && ofType(eb, "turn_completed").some((e) => e.filesRead?.some((f: { name: string }) => f.name.endsWith("notes.md"))),
    b.stdout.slice(-600));

  // Case C
  const fence = (s: string) => "My draft:\n```json\n" + amend(s) + "\n```";
  const steps = (...raws: string[]) => raws.map((raw) => ({ raw }));
  writeFileSync(join(work, "c1.json"), JSON.stringify({ steps: steps(fence("Draft one."), amend("Version one."), agree, agree) }));
  writeFileSync(join(work, "c2.json"), JSON.stringify({ steps: steps(fence("Draft two."), agree, agree, agree) }));
  const c = await council(["--topic", "Name the cat", "--drafts", "--synthesizer", "p1", "--participant", `scripted:${join(work, "c1.json")}`, "--participant", `scripted:${join(work, "c2.json")}`, "--max-rounds", "3"]);
  console.log(`       case C: ${c.ms.toFixed(0)} ms, exit ${c.code}${c.ok ? "" : `, ${c.why}`}`);
  const ec = journal(c.stdout);
  check("C: exit 0 within the watchdog", c.ok, `${(c as { why?: string }).why}\n${c.stdout.slice(-500)}\n${c.stderr.slice(-500)}`);
  check("C: both fenced drafts accepted, none failed", ofType(ec, "draft_completed").length === 2 && ofType(ec, "draft_attempt_failed").length === 0, JSON.stringify(ec.map((e) => e.type)));

  // Case D
  const d = await council(["--topic", "Name the cat", "--participant", "stand:brace-1", "--participant", "stand:brace-2", "--max-rounds", "3"]);
  console.log(`       case D: ${d.ms.toFixed(0)} ms, exit ${d.code}${d.ok ? "" : `, ${d.why}`}`);
  const ed = journal(d.stdout);
  check("D: exit 0 within the watchdog", d.ok, `${(d as { why?: string }).why}\n${d.stdout.slice(-500)}\n${d.stderr.slice(-500)}`);
  check("D: unpaired '{ ' before the turn is accepted without a correction request", ofType(ed, "turn_failed").length === 0 && (calls["brace-1"] ?? 0) >= 1 && ofType(ed, "turn_completed").some((e) => e.participantId === "p1" && e.stance === "amend"),
    JSON.stringify(ed.map((e) => e.type)));
  check("D: session reaches consensus", ofType(ed, "session_finished")[0]?.status === "consensus", JSON.stringify(ofType(ed, "session_finished")));
  await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
}

console.log(`model calls: 0 (local stand requests: ${standRequests})`);
console.log(`${failed ? "FAIL" : "PASS"} Bounded fenced response extraction${mutant ? " (mutant)" : ""} (${total - failed}/${total})`);
if (failed) { console.log(`       data kept in ${work}`); process.exit(1); }
rmSync(work, { recursive: true, force: true });
