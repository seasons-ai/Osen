// Live check of the MCP server text language: the server is a child process over stdio, like a real agent's, started several times
// with different languages (COUNCIL_LANG, preferences.json, default). Participants are scripted only, 0 real model calls.
// The language of each server is set here, the language environment is not inherited (language-ru.ts is not imported).
//   COUNCIL_DEV=1 COUNCIL_HOME=.council-data/lang-check-<label> node packages/mcp/scenarios/language/check.ts
// Writes only to COUNCIL_HOME (one data folder per server launch) and does not delete it.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (process.env.COUNCIL_DEV !== "1" || !process.env.COUNCIL_HOME?.trim()) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME are required. Run: COUNCIL_DEV=1 COUNCIL_HOME=.council-data/lang-check-<label> node packages/mcp/scenarios/language/check.ts");
  process.exit(2);
}
const home = resolve(process.env.COUNCIL_HOME);
mkdirSync(home, { recursive: true });
const root = join(import.meta.dirname, "../../../..");
const golden = JSON.parse(readFileSync(join(root, "packages/mcp/src/__golden__/ru-server.json"), "utf8")) as { instructions: string; tools: { name: string; description: string; inputSchema: unknown }[] };

const MARK = `МЕТКА-МАТЕРИАЛ-${randomBytes(3).toString("hex")}`, KEY = `sk-lang-check-${randomBytes(6).toString("hex")}`;
const CYR = /[А-Яа-яЁё]/;
const TOOLS = ["council_continue", "council_options", "council_resume", "council_say", "council_start", "council_status", "council_stop"];

// ---- output ----
let total = 0, failed = 0;
function check(ok: boolean, what: string, detail = "") {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${what}${ok || !detail ? "" : ` — ${detail.slice(0, 300)}`}`);
}
const short = (s: string) => JSON.stringify(s.slice(0, 120));

// ---- MCP ----
type Res = { isError?: boolean; content: { type: string; text: string }[] };
const body = (r: Res) => r.content[0]?.text ?? "";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
interface Srv { client: Client; dir: string; call: (name: string, args?: Record<string, unknown>) => Promise<Res>; all: string[]; close: () => Promise<void> }
async function launch(label: string, lang: string | null, prefs?: string): Promise<Srv> {
  const dir = join(home, label);
  mkdirSync(dir, { recursive: true });
  if (prefs !== undefined) writeFileSync(join(dir, "preferences.json"), prefs);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_HOME: dir, COUNCIL_DEV: "1", OPENAI_API_KEY: KEY, ...(lang === null ? {} : { COUNCIL_LANG: lang }) };
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "packages/mcp/src/main.ts")], cwd: root, stderr: "ignore", env });
  const client = new Client({ name: "language-check", version: "0" });
  await client.connect(transport);
  const all: string[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as Res;
    all.push(body(r));
    return r;
  };
  return { client, dir, call, all, close: () => client.close() };
}
const sessionCount = (dir: string) => (existsSync(join(dir, "sessions")) ? readdirSync(join(dir, "sessions")).length : 0);
async function done(s: Srv, id: string) {
  for (let i = 0; i < 10; i++) {
    const st = JSON.parse(body(await s.call("council_status", { sessionId: id, waitSec: 20 })));
    if (st.status !== "running") return st;
  }
  throw new Error(`session ${id} did not finish`);
}
const stripDesc = (v: unknown): unknown => Array.isArray(v) ? v.map(stripDesc) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "description").map(([k, x]) => [k, stripDesc(x)])) : v;

// ---- material ----
const matFile = join(home, "material.txt");
writeFileSync(matFile, `Короткий материал для проверки языка.\n${MARK}\n`);
const scenario = (m: string) => ({ providerId: "scripted", model: m });
const cons = [scenario("consensus/p1.json"), scenario("consensus/p2.json")];

interface Probe { instr: string; tools: { name: string; description: string; inputSchema: unknown }[]; status: any; optionsText: string; start: any; startText: string; refusalEmpty: string; refusalUnknown: string; sessionsStable: boolean; synth: any; leaked: string[] }
async function probe(s: Srv, withSynth = true): Promise<Probe> {
  const instr = s.client.getInstructions() ?? "";
  const tools = (await s.client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }));
  const opts = await s.call("council_options");
  const st = await s.call("council_start", { topic: "Проверка языка", participants: cons, maxRounds: 3, attachments: [matFile] });
  const id = JSON.parse(body(st)).sessionId as string;
  const status = await done(s, id);
  const before = sessionCount(s.dir);
  const e1 = await s.call("council_start", { topic: "", participants: cons, maxRounds: 3 });
  const e2 = await s.call("council_status", { sessionId: "no-such-session" });
  const sessionsStable = sessionCount(s.dir) === before && e1.isError === true && e2.isError === true;
  let synth: any = null;
  if (withSynth) {
    const r = await s.call("council_start", { topic: "Синтезатор выбывает", drafts: true, synthesizerId: "p2", maxRounds: 2, participants: [scenario("independent-drafts/p1.json"), scenario("dropout/p2.json"), scenario("independent-drafts/p3.json")] });
    synth = await done(s, JSON.parse(body(r)).sessionId);
  }
  const leaked = [MARK, KEY].filter((n) => [body(opts), body(st), ...s.all].some((t) => t.includes(n)));
  return { instr, tools, status, optionsText: body(opts), start: JSON.parse(body(st)), startText: body(st), refusalEmpty: body(e1), refusalUnknown: body(e2), sessionsStable, synth, leaked };
}

function checkInstructions(tag: string, p: Probe, lang: "en" | "ru") {
  if (lang === "ru") return check(p.instr === golden.instructions, `${tag}: instructions are byte-for-byte equal to the reference`, short(p.instr));
  const lines = p.instr.split("\n");
  const numbered = lines.filter((l) => /^\d+\. /.test(l));
  check(numbered.length === 11 && numbered.every((l, i) => l.startsWith(`${i + 1}. `)), `${tag}: instructions — 11 numbered lines in order`, `found ${numbered.length}`);
  check(!CYR.test(p.instr), `${tag}: instructions without Cyrillic`, p.instr.match(/.{0,20}[А-Яа-яЁё]+.{0,20}/)?.[0] ?? "");
  check(/owner's language/i.test(p.instr), `${tag}: there is a line about the owner's language`);
}
function checkTools(tag: string, p: Probe, lang: "en" | "ru") {
  check(JSON.stringify(p.tools.map((t) => t.name).sort()) === JSON.stringify(TOOLS), `${tag}: 7 tools`, p.tools.map((t) => t.name).join(","));
  if (lang === "ru") {
    const bad = golden.tools.filter((g) => p.tools.find((t) => t.name === g.name)?.description !== g.description).map((g) => g.name);
    return check(bad.length === 0, `${tag}: tool descriptions are byte-for-byte equal to the reference`, bad.join(","));
  }
  const cyr = p.tools.filter((t) => CYR.test(t.description)).map((t) => t.name);
  check(cyr.length === 0, `${tag}: tool descriptions without Cyrillic`, cyr.join(","));
  const sm = ["council_start", "council_resume"].filter((n) => !/subscription|money/.test(p.tools.find((t) => t.name === n)?.description ?? ""));
  check(sm.length === 0, `${tag}: council_start and council_resume have subscription or money`, sm.join(","));
}

async function main() {
  const runs: [string, string, string | null, string | undefined, "en" | "ru"][] = [
    ["1 COUNCIL_LANG=en", "r1", "en", undefined, "en"],
    ["2 COUNCIL_LANG=ru", "r2", "ru", undefined, "ru"],
    ["3 default", "r3", null, undefined, "en"],
    ["4 preferences.json=ru", "r4", null, '{ "language": "ru" }\n', "ru"],
    ["5 COUNCIL_LANG=de, corrupted file", "r5", "de", "{ не json", "en"],
    ["6 COUNCIL_LANG=en with preferences.json=ru", "r6", "en", '{ "language": "ru" }\n', "en"],
  ];
  const probes: Probe[] = [];
  for (const [tag, label, lang, prefs, expect] of runs) {
    console.log(`--- launch ${tag} (expected ${expect}) ---`);
    const s = await launch(label, lang, prefs);
    const p = await probe(s, label === "r1" || label === "r2");
    probes.push(p);
    checkInstructions(tag, p, expect);
    checkTools(tag, p, expect);
    check(p.status.status === "consensus", `${tag}: council_start up to the result, status = consensus`, String(p.status.status));
    if (expect === "en") check(typeof p.status.statusText === "string" && p.status.statusText.startsWith("consensus"), `${tag}: statusText starts with consensus`, p.status.statusText);
    else check(p.status.statusText === "согласие достигнуто", `${tag}: statusText = "согласие достигнуто"`, p.status.statusText);
    check(expect === "en" ? !CYR.test(p.refusalEmpty) && !CYR.test(p.refusalUnknown) : CYR.test(p.refusalEmpty) && CYR.test(p.refusalUnknown), `${tag}: refusals in ${expect}`, `${short(p.refusalEmpty)} / ${short(p.refusalUnknown)}`);
    // the responses have no owner data (the topic is not returned, the material is an ascii name), so Cyrillic is checked across the whole text
    check(expect === "en" ? !CYR.test(p.optionsText) : CYR.test(p.optionsText), `${tag}: council_options (provider label and marks, templates) in ${expect}`, short(p.optionsText.match(/.{0,30}[А-Яа-яЁё]+.{0,30}/)?.[0] ?? ""));
    const next: string = p.start.next ?? "";
    check(expect === "en" ? !CYR.test(p.startText) && next !== "" : CYR.test(next) && CYR.test(p.start.participants?.[0]?.name ?? ""), `${tag}: successful council_start (next, participant names) in ${expect}`, short(p.startText.match(/.{0,30}[А-Яа-яЁё]+.{0,30}/)?.[0] ?? next));
    check(p.sessionsStable, `${tag}: refusals are isError, the number of sessions did not change`);
    check(p.leaked.length === 0, `${tag}: neither the material label nor the key in the responses`, p.leaked.join(","));
    if (label === "r5") {
      const bytes = readFileSync(join(s.dir, "preferences.json"), "utf8");
      check(bytes === prefs, `${tag}: preferences.json bytes did not change`, bytes);
    }
    if (p.synth) {
      const t: string = p.synth.reasonText ?? "";
      const ok = p.synth.status === "failed" && p.synth.reason === "synthesizer_unavailable" && t.includes("p2");
      check(ok, `${tag}: real session — failed/synthesizer_unavailable, reasonText contains p2`, JSON.stringify({ status: p.synth.status, reason: p.synth.reason, t }));
      check(expect === "en" ? !CYR.test(t) : !/[A-Za-z]/.test(t.replaceAll("p2", "")), `${tag}: reasonText entirely in ${expect}`, t);
    }
    await s.close();
  }

  console.log("--- comparison of launches ---");
  const sig = (p: Probe) => JSON.stringify(p.tools.map((t) => ({ n: t.name, s: stripDesc(t.inputSchema) })).sort((a, b) => a.n.localeCompare(b.n)));
  check(probes.every((p) => sig(p) === sig(probes[0]!)), "tool lists and inputSchema (without description) are the same on all launches");
  const keys = (p: Probe) => JSON.stringify(Object.keys(p.status).sort());
  check(keys(probes[0]!) === keys(probes[1]!), "the council_status key set is the same on en and ru", `${keys(probes[0]!)} / ${keys(probes[1]!)}`);
  const paths = (v: unknown, pre = ""): string[] => Array.isArray(v) ? v.flatMap((x) => paths(x, `${pre}[]`)) : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [`${pre}.${k}`, ...paths(x, `${pre}.${k}`)]) : [];
  const kp = (p: Probe) => JSON.stringify([...new Set(paths(p.start))].sort());
  check(kp(probes[0]!) === kp(probes[1]!), "the structure (keys recursively) of a successful council_start is the same on en and ru", `${kp(probes[0]!)} / ${kp(probes[1]!)}`);
  check(probes[0]!.synth?.status === probes[1]!.synth?.status && probes[0]!.synth?.reason === probes[1]!.synth?.reason, "the synthesizer failure reason code is the same on en and ru");

  console.log("--- language change during operation ---");
  const sw = await launch("switch", null);
  const en0 = await probe(sw, false);
  check(en0.status.statusText.startsWith("consensus"), "server on the default: statusText is English");
  writeFileSync(join(sw.dir, "preferences.json"), '{ "language": "ru" }\n');
  await sleep(300);
  const sid = readdirSync(join(sw.dir, "sessions"))[0]!;
  const st = JSON.parse(body(await sw.call("council_status", { sessionId: sid })));
  const rej = body(await sw.call("council_status", { sessionId: "no-such-session" }));
  check(st.statusText.startsWith("consensus") && !CYR.test(rej), "after preferences.json=ru is written the same server stays English (the language is read once)", `${st.statusText} / ${short(rej)}`);
  check(sw.client.getInstructions() === en0.instr, "the instructions of the same server did not change");
  await sw.close();
  const sw2 = await launch("switch", null);
  const ru1 = JSON.parse(body(await sw2.call("council_status", { sessionId: sid })));
  const rej2 = body(await sw2.call("council_status", { sessionId: "no-such-session" }));
  check(ru1.statusText === "согласие достигнуто" && CYR.test(rej2) && sw2.client.getInstructions() === golden.instructions, "a newly started server in the same folder is Russian", `${ru1.statusText} / ${short(rej2)}`);
  await sw2.close();

  console.log(failed === 0 ? `Result: all checks passed (${total})` : `Result: failed ${failed} of ${total}`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.log(`✗ the stand crashed: ${e instanceof Error ? e.stack : e}`); process.exit(1); });
