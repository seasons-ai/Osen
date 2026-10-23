// Live check of text encodings in file materials: UTF-8 with BOM, UTF-16 with BOM, Windows-1251 (real council, real MCP server over
// stdio, real desktop main modules; scripted participants only, 0 model calls).
//   COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data/te-XXXXXX")" node packages/core/scenarios/text-encoding/check.ts
// Without COUNCIL_HOME the stand creates .council-data/text-encoding-check-*. The folder is deleted on success and kept on failure.
// File names are neutral on purpose: the journal records material names and must not mention an encoding.
import "../language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BUILTIN_TEMPLATES_DIR, createLogger, ensureDataDir, loadTemplates, readRegistry, runStoredSession, writeRegistry } from "../../src/index.ts";
import type { Registry } from "../../src/index.ts";
import { enc1251, encKoi8r, utf16be, utf16le } from "../../src/text-encoding.testutil.ts";
import { createBridge } from "../../../../apps/desktop/src/main/bridge.ts";
import { createLauncher } from "../../../../apps/desktop/src/main/launcher.ts";
import { createMaterialsDraft } from "../../../../apps/desktop/src/main/materials.ts";
import { previewMaterials } from "../../../../apps/desktop/src/main/materials-preview.ts";
import { createSettings } from "../../../../apps/desktop/src/main/settings.ts";
import type { MaterialsPreviewView, MaterialsView } from "../../../../apps/desktop/src/shared/setup.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error('Run: COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data/te-XXXXXX")" node packages/core/scenarios/text-encoding/check.ts');
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const given = process.env.COUNCIL_HOME;
if (given && (!existsSync(resolve(given)) || !statSync(resolve(given)).isDirectory() || readdirSync(resolve(given)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(given)} must exist and be empty.`);
  process.exit(2);
}
const work = given ? realpathSync(resolve(given)) : join(repo, ".council-data", `text-encoding-check-${Date.now()}-${randomBytes(3).toString("hex")}`);
const fx = join(work, "fx"), cliHome = join(work, "cli"), mcpHome = join(work, "mcp"), appHome = join(work, "app"), urlHome = join(work, "url");
for (const d of [fx, cliHome, mcpHome, appHome, urlHome]) mkdirSync(d, { recursive: true });
const wd = realpathSync(work); // the collector rejects paths through symlinks

const TEXT = "Привет, мир. Ёж ест яблоко.";
const GOOD = ["le16.txt", "be16.txt", "win.csv", "bom8.txt"];
const R_NOTEXT = "двоичный файл неизвестного формата";
const R_NOTEXT_FOLDER = R_NOTEXT;
const RU_ENC = "кодировка не распознана — нужен UTF-8, UTF-16 с BOM или Windows-1251";
const EN_ENC = "encoding not recognized — UTF-8, UTF-16 with BOM or Windows-1251 is required";
const files: Record<string, Buffer> = {
  "le16.txt": utf16le(TEXT), "be16.txt": utf16be(TEXT), "win.csv": enc1251(TEXT),
  "bom8.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT)]),
  "nobom.txt": Buffer.from(TEXT, "utf16le"), "koi.txt": encKoi8r(TEXT),
};
const good = GOOD.map((f) => join(wd, "fx", f));
const goodArgs = good.flatMap((f) => ["--attach", f]);
for (const [name, data] of Object.entries(files)) writeFileSync(join(fx, name), data);
mkdirSync(join(fx, "dir"));
for (const name of [...GOOD, "koi.txt", "nobom.txt"]) writeFileSync(join(fx, "dir", name), files[name]!);
const shaText = createHash("sha256").update(TEXT).digest("hex");
const consensus = ["p1", "p2"].map((p) => `scripted:${join(repo, "packages/core/scenarios/consensus", `${p}.json`)}`);
const parts = consensus.flatMap((p) => ["--participant", p]);

let n = 0;
const ok = (s: string) => console.log(`ok ${++n}: ${s}`);
const kids = new Set<ReturnType<typeof spawn>>();
const outputs: string[] = [];
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_DEV: "1" };

type Proc = { out: string; err: string; exited: Promise<number | null> };
function proc(args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, args, { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  kids.add(child);
  const r: Proc = { out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout.on("data", (d) => { r.out += d; });
  child.stderr.on("data", (d) => { r.err += d; });
  r.exited.then(() => outputs.push(r.out, r.err));
  return r;
}
const dump = (p: Proc) => `\n--- stdout ---\n${p.out}\n--- stderr ---\n${p.err}`;
const cliLog = join(cliHome, "prompts.jsonl");
const cliEnv = (lang = "ru") => ({ ...baseEnv, COUNCIL_LANG: lang, COUNCIL_HOME: cliHome, COUNCIL_SCRIPTED_PROMPT_LOG: cliLog });
async function council(args: string[], lang = "ru", entry = join(repo, "packages/core/src/council.ts"), extra: Record<string, string> = {}) {
  const p = proc([entry, ...args], { ...cliEnv(lang), ...extra });
  return { code: await p.exited, p };
}
const sessionId = (p: Proc) => /^Сессия (\S+) ·/m.exec(p.out)?.[1] ?? assert.fail(`no "Сессия" line${dump(p)}`);
const sessionsOf = (home: string) => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []);
const createdOf = (home: string, id: string) =>
  (readFileSync(join(home, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created").session.materials) as { chars: number; sha256: string; name: string }[];
const promptsOf = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { prompt: string }).prompt) : []);
function allFiles(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}

/** Everything a session left behind for one input path: prompts, snapshots, sha256, no encoding words. */
function assertSession(what: string, home: string, id: string, prompts: string[], texts: string[]) {
  const mats = createdOf(home, id);
  assert.equal(mats.length, 4, `${what}: ${mats.length} materials`);
  for (const m of mats) assert.deepEqual([m.chars, m.sha256], [TEXT.length, shaText], `${what}: chars/sha256 of ${m.name}`);
  for (let i = 1; i <= 4; i++) {
    const raw = readFileSync(join(home, "sessions", id, "materials", `m${i}.txt`));
    assert.ok(!(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf), `${what}: m${i}.txt starts with a BOM`);
    assert.equal(raw.toString("utf8"), TEXT, `${what}: m${i}.txt`);
  }
  assert.ok(prompts.length > 0, `${what}: no participant requests`);
  for (const p of prompts) {
    assert.ok(p.includes("Материалы владельца") && p.includes(TEXT), `${what}: request lacks the materials text`);
    assert.ok(!p.includes("﻿"), `${what}: U+FEFF in a request`);
  }
  texts.push(readFileSync(join(home, "sessions", id, "events.jsonl"), "utf8"));
  return mats;
}
const ENC_WORDS = /utf-?16|1251|windows/i;
const noEncodingWords = (what: string, texts: string[]) => {
  for (const t of texts) {
    const hit = ENC_WORDS.exec(t.split(wd).join(""));
    assert.ok(!hit, `${what}: encoding name "${hit?.[0]}" in the journal or output near: ${hit ? t.slice(Math.max(0, hit.index - 60), hit.index + 60) : ""}`);
  }
};

// ---- real model calls never happen: the registry has one inert provider ----
writeRegistry(ensureDataDir(appHome), {
  providers: [{ id: "inert", kind: "openai-http", label: "Unused", baseUrl: "http://127.0.0.1:9", models: ["m"] }],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 60000, participants: [{ providerId: "inert", model: "m" }, { providerId: "inert", model: "m" }] },
} satisfies Registry);

async function stepCli(): Promise<string> {
  const r = await council(["--topic", "Что в файлах?", ...goodArgs, ...parts, "--max-rounds", "3"]);
  assert.equal(r.code, 0, `code ${r.code}${dump(r.p)}`);
  assert.match(r.p.out, new RegExp(`^Материалы: 4, объём ${TEXT.length * 4} символов`, "m"), dump(r.p));
  const id = sessionId(r.p);
  assertSession("step 1", cliHome, id, promptsOf(cliLog), []);
  noEncodingWords("step 1", [r.p.out, r.p.err, readFileSync(join(cliHome, "sessions", id, "events.jsonl"), "utf8")]);
  ok(`terminal: 4 materials of ${TEXT.length} chars, requests hold the text without U+FEFF, m1..m4.txt are UTF-8 without BOM, sha256 ${shaText.slice(0, 12)}…, no encoding names`);
  return id;
}

async function stepMcp() {
  const log = join(mcpHome, "prompts.jsonl");
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(repo, "packages/mcp/src/main.ts")], cwd: repo, stderr: "pipe",
    env: { ...baseEnv, COUNCIL_LANG: "ru", COUNCIL_HOME: mcpHome, COUNCIL_SCRIPTED_PROMPT_LOG: log },
  });
  let serverErr = "";
  transport.stderr?.on("data", (d) => { serverErr += d; });
  const client = new Client({ name: "text-encoding-check", version: "0" });
  try {
    await client.connect(transport);
    const call = async (args: Record<string, unknown>) => (await client.callTool({ name: "council_start", arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const r = await call({ topic: "Что в файлах?", participants: [{ providerId: "scripted", model: "consensus/p1.json" }, { providerId: "scripted", model: "consensus/p2.json" }], maxRounds: 3, attachments: good });
    assert.ok(!r.isError, r.content[0]?.text);
    const s = JSON.parse(r.content[0]!.text);
    assert.equal(s.materials.count, 4);
    assert.equal(s.materials.chars, TEXT.length * 4);
    let st: { status: string } = { status: "running" };
    for (let i = 0; i < 10 && st.status === "running"; i++) {
      const sr = (await client.callTool({ name: "council_status", arguments: { sessionId: s.sessionId, waitSec: 20 } })) as { content: { text: string }[] };
      st = JSON.parse(sr.content[0]!.text);
    }
    assert.notEqual(st.status, "running", "MCP session did not finish");
    const texts: string[] = [];
    assertSession("step 2", mcpHome, s.sessionId, promptsOf(log), texts);
    noEncodingWords("step 2", [...texts, r.content[0]!.text, serverErr]);
    ok(`MCP council_start: 4 materials, chars ${TEXT.length} and sha256 equal to the terminal, requests without U+FEFF, snapshots without BOM`);
  } finally {
    try { await client.close(); } catch { /* the server is killed below */ }
    try { if (transport.pid) process.kill(transport.pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

async function stepApp() {
  const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: appHome };
  const logger = createLogger(appHome, "desktop", env);
  const draft = createMaterialsDraft({ limits: () => { const { materialsChars, materialsIgnore } = readRegistry(appHome).defaults; return { materialsChars, materialsIgnore }; } });
  const prompts: string[] = [];
  const runs: Promise<unknown>[] = [];
  const run: typeof runStoredSession = (o) => {
    const drivers = Object.fromEntries(Object.entries(o.drivers).map(([k, d]) => [k, { ...d, call: (req: Parameters<typeof d.call>[0]) => { prompts.push(req.prompt); return d.call(req); } }]));
    const r = runStoredSession({ ...o, drivers });
    runs.push(r);
    return r;
  };
  const scenDir = join(repo, "packages/core/scenarios/consensus");
  const launcher = createLauncher({ dataDir: appHome, env, logger, materials: draft, registry: () => readRegistry(appHome), catalog: () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: join(appHome, "templates") }), scenarioPath: (m) => (m === "p1" || m === "p2" ? join(scenDir, `${m}.json`) : null), run });
  const settings = createSettings({ dataDir: appHome, env, reloadEnv: () => {}, logger, inspect: async (p) => ({ status: { id: p.id, kind: p.kind, label: p.label, available: false, reason: "not inspected", models: [], modelsConfirmed: false } }) });
  const stub = <T>(v: T) => () => v;
  const bridge = createBridge({
    listSessions: stub([]), sessionExists: stub(false), watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }),
    registry: async () => ({}) as never, startSession: (input) => launcher.start(input), lastParticipants: stub(null), resumeOptions: async () => ({}) as never,
    resumeSession: async () => ({ droppedOwnerRequests: [] }), stopSession: () => {}, acceptVersion: () => ({}) as never, sendOwnerMessage: () => ({ requestId: "r" }), continueWait: () => ({ requestId: "r" }),
    previewMaterials: (refresh) => previewMaterials({ dataDir: appHome, logger, materials: draft }, refresh), prepareRerun: () => ({}) as never, copyText: () => {},
    exportSession: async () => null, setPinned: () => {}, settings, templates: { open: stub(null), create: stub(null), save: stub(null), remove: () => {} } as never,
    materials: draft, pickMaterials: async () => null, send: () => {}, logger,
  });
  type R = { ok: true; value: unknown } | { ok: false; error: string };
  const call = (a: string, ...args: unknown[]): Promise<R> => bridge.call(a, args);
  async function okCall<T>(a: string, ...args: unknown[]): Promise<T> {
    const r = await call(a, ...args);
    assert.ok(r.ok, `${a}: ${r.ok ? "" : r.error}`);
    return r.value as T;
  }
  await okCall("clearMaterials");
  const v = await okCall<MaterialsView>("attachMaterials", good);
  assert.equal(v.error, null);
  assert.equal(v.items.length, 4);
  for (const i of v.items) assert.equal(i.chars, TEXT.length, `${i.name} chars`);
  const pv = await okCall<MaterialsPreviewView>("previewMaterials", false);
  assert.ok(pv.initial, "no preview text");
  assert.equal(pv.initial.split(TEXT).length - 1, 4, "the preview does not hold the text four times");
  assert.ok(!pv.initial.includes("﻿"), "U+FEFF in the preview");
  const r = await call("startSession", { templateId: null, topic: "Что в файлах?", participants: [{ providerId: "scripted", model: "p1", role: null }, { providerId: "scripted", model: "p2", role: null }], maxRounds: 3, useMaterials: true, preparedHandle: pv.handle });
  assert.ok(r.ok && (r.value as { id: string | null }).id !== null, `start: ${r.ok ? JSON.stringify(r.value) : r.error}`);
  const id = (r.value as { id: string }).id;
  await Promise.allSettled(runs);
  const texts: string[] = [];
  assertSession("step 3", appHome, id, prompts, texts);
  assert.ok(prompts.every((p) => p.includes(pv.initial!)), "a request does not contain the preview text");
  noEncodingWords("step 3", [...texts, JSON.stringify([v, pv]), readFileSync(join(appHome, "logs", "app.log"), "utf8")]);
  ok("app main modules: attach + preview + start from the prepared set: same chars and sha256, the preview holds the text 4 times and is part of every request, no U+FEFF");
}

async function stepRefusals(lang: "ru" | "en") {
  const reasonEnc = lang === "ru" ? RU_ENC : EN_ENC;
  const reasonText = lang === "ru" ? R_NOTEXT : "binary file of an unknown format";
  const head = lang === "ru" ? "Материалы не приняты:" : "Materials not accepted:";
  for (const [f, reason] of [["nobom.txt", reasonText], ["koi.txt", reasonEnc]] as const) {
    const sessions = sessionsOf(cliHome).length, calls = promptsOf(cliLog).length;
    const r = await council(["--topic", "t", "--attach", join(wd, "fx", f), ...parts, "--max-rounds", "1"], lang);
    assert.equal(r.code, 2, `${lang} ${f}: code ${r.code}${dump(r.p)}`);
    assert.ok(r.p.err.includes(head) && r.p.err.includes(reason), `${lang} ${f}: expected "${head}" and "${reason}"${dump(r.p)}`);
    assert.equal(sessionsOf(cliHome).length, sessions, `${lang} ${f}: a session appeared`);
    assert.equal(promptsOf(cliLog).length, calls, `${lang} ${f}: a participant was called`);
  }
  ok(`${lang}: no-BOM UTF-16 gives code 2 "${reasonText}", KOI8-R gives code 2 "${reasonEnc}"; no session, no participant call`);
}

async function stepFolder() {
  const r = await council(["--topic", "Папка", "--attach", join(wd, "fx", "dir"), ...parts, "--max-rounds", "3"]);
  assert.equal(r.code, 0, dump(r.p));
  assert.match(r.p.out, /^Материалы: 4, /m, dump(r.p));
  assert.match(r.p.out, /^Пропущено: 2$/m, dump(r.p));
  const lines = r.p.out.slice(r.p.out.indexOf("Пропущено:")).split("\n").filter((l) => l.startsWith("  "));
  assert.ok(lines.some((l) => l.includes("koi.txt") && l.includes(RU_ENC)), `koi.txt line:\n${lines.join("\n")}`);
  assert.ok(lines.some((l) => l.includes("nobom.txt") && l.includes(R_NOTEXT_FOLDER) && !l.includes(RU_ENC)), `nobom.txt line:\n${lines.join("\n")}`);
  const mats = createdOf(cliHome, sessionId(r.p));
  assert.equal(mats.length, 4);
  for (const m of mats) assert.equal(m.sha256, shaText);
  ok("folder with 4 good files + KOI8-R + no-BOM UTF-16: 4 collected, 2 skipped with their own reasons");
}

async function stepUrl() {
  const server = http.createServer((req, res) => {
    const bytes = files["le16.txt"]!;
    if (req.url?.startsWith("/charset")) res.writeHead(200, { "content-type": "text/plain; charset=utf-16le" });
    else res.writeHead(200, { "content-type": "text/plain" });
    res.end(bytes);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const stand = JSON.stringify({ dns: { "docs.stand.test": ["93.184.215.14"] }, routes: { "93.184.215.14": port }, log: join(urlHome, "transport.jsonl") });
  writeFileSync(join(urlHome, "transport.jsonl"), "");
  try {
    for (const path of ["/charset", "/plain"]) {
      const sessions = sessionsOf(cliHome).length;
      const r = await council(["--url", `http://docs.stand.test${path}`, "--preview-materials"], "ru", join(repo, "packages/core/scenarios/url-materials/council-test.ts"), { URL_STAND: stand });
      assert.equal(r.code, 2, `${path}: code ${r.code}${dump(r.p)}`);
      assert.ok(r.p.err.includes("Материалы не приняты:"), dump(r.p));
      assert.match(r.p.err, /кодировка \S+ не поддерживается — нужен UTF-8|нетекстовый ответ/, `${path}: old link refusal expected${dump(r.p)}`);
      assert.equal(sessionsOf(cliHome).length, sessions);
      assert.ok(!r.p.out.includes(TEXT) && !r.p.err.includes(TEXT), `${path}: the text was decoded`);
    }
  } finally {
    server.close();
  }
  ok("URL serving UTF-16 LE bytes (with and without charset): the old link refusal, no re-encoding");
}

async function stepStands() {
  for (const script of ["packages/core/scenarios/pdf/check.ts", "packages/core/scenarios/ignore-rules/check-cli.ts"]) {
    const home = join(work, `child-${script.split("/")[3]}`);
    mkdirSync(home, { recursive: true });
    const p = proc([join(repo, script)], { ...baseEnv, COUNCIL_HOME: home });
    const code = await p.exited;
    assert.equal(code, 0, `${script} exited with ${code}${dump(p)}`);
  }
  ok("existing stands pdf/check.ts and ignore-rules/check-cli.ts: exit 0");
}

const finish = () => { for (const k of kids) k.kill("SIGKILL"); };
const guard = setTimeout(() => { console.error(`FAILED: the stand did not finish within 400 seconds\nStand kept: ${work}`); finish(); process.exit(1); }, 400_000);
try {
  await stepCli();
  await stepMcp();
  await stepApp();
  await stepRefusals("ru");
  await stepRefusals("en");
  await stepFolder();
  await stepUrl();
  for (const t of outputs) assert.ok(!t.includes("﻿"), "U+FEFF in a process output");
  await stepStands();
  clearTimeout(guard);
  finish();
  for (const f of allFiles(cliHome)) if (readFileSync(f, "utf8").includes("﻿") && f.includes("/materials/")) assert.fail(`U+FEFF in ${f}`);
  rmSync(work, { recursive: true, force: true });
  console.log("text-encoding check: OK");
} catch (e) {
  clearTimeout(guard);
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}\nStand kept: ${work}`);
  finish();
  process.exit(1);
}
process.exit(0);
