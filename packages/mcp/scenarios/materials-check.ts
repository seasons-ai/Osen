// Live check of attachments in the MCP server: COUNCIL_DEV=1 node packages/mcp/scenarios/materials-check.ts
// The server is started as a child process, like a real agent's. Models are not called: participants are scripted
// and a fake HTTP server on 127.0.0.1. The data folder is created inside the project (the materials collector
// rejects paths through symbolic links, and /tmp on macOS is a link); COUNCIL_HOME, if set, is not deleted.
import "../../core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeServer } from "../../core/src/http/fake-server.ts";

const root = join(import.meta.dirname, "../../..");
const main = join(import.meta.dirname, "../src/main.ts");
const ownHome = process.env.COUNCIL_HOME?.trim() ? undefined : mkdtempSync(join(root, ".council-data-mcp-materials-"));
const home = process.env.COUNCIL_HOME?.trim() || ownHome!;
const input = join(home, "input");
const cfgFile = join(home, "config.json");
const sessionsPath = join(home, "sessions");

const LA = "МЕТКА-A-16c1", LB = "МЕТКА-B-16d2", LNM = "МЕТКА-NM-16e3";
const SECRET = "фиктивная-строка-НЕ-СЕКРЕТ-16f4";
const TEXT_A = `Файл a: требования к имени. ${LA}\n`;
const TEXT_B = `Файл b: пожелания по тону. ${LB}`;
const LABELS = [LA, LB, LNM];

function put(rel: string, data: string | Buffer): void {
  const p = join(input, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, data);
}

const readCfg = () => JSON.parse(readFileSync(cfgFile, "utf8"));
const writeCfg = (c: unknown) => writeFileSync(cfgFile, JSON.stringify(c, null, 2));
const sessionIds = () => (existsSync(sessionsPath) ? readdirSync(sessionsPath) : []);
const abs = (rel: string) => join(input, rel);
const scripted = (...f: string[]) => f.map((model) => ({ providerId: "scripted", model }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Res = { isError?: boolean; content: { type: string; text: string }[] };
const clients: Client[] = [];
async function connect(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [main], cwd: root, stderr: "ignore",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_HOME: home, COUNCIL_DEV: "1" },
  });
  const client = new Client({ name: "materials-check", version: "0" });
  clients.push(client);
  await client.connect(transport);
  return client;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;
const body = (r: Res) => r.content[0]!.text;
const ok = (r: Res, what: string) => { assert.ok(!r.isError, `${what}: unexpected error: ${body(r)}`); return JSON.parse(body(r)); };
const noLeaks = (text: string, what: string, withPath = true) => {
  for (const l of LABELS) assert.ok(!text.includes(l), `${what}: label found ${l}`);
  assert.ok(!text.includes(SECRET), `${what}: secret value found`);
  if (withPath) assert.ok(!text.includes(input), `${what}: absolute fixture path found`);
};
const step = (n: number, seen: string) => console.log(`step ${n} — ok: ${seen}`);

async function finish(c: Client, sessionId: string) {
  for (let i = 0; i < 6; i++) {
    const r = await call(c, "council_status", { sessionId, waitSec: 50 });
    const s = ok(r, "council_status");
    noLeaks(body(r), "council_status response");
    if (s.status !== "running") return s;
  }
  throw new Error(`session ${sessionId} did not finish within 300 s`);
}

const okResponses: string[] = [];
let created = 0;

async function run(): Promise<number> {
  mkdirSync(home, { recursive: true });
  rmSync(input, { recursive: true, force: true });
  put("a.txt", TEXT_A);
  put("folder/b.txt", TEXT_B);
  put("folder/node_modules/x.txt", `модуль ${LNM}\n`);
  put("folder/bin.dat", Buffer.from([0x50, 0x00, 0x01, 0x02, 0x00, 0xff]));
  put("unsafe/.env.local", `SECRET=${SECRET}\n`);
  const sumChars = TEXT_A.length + TEXT_B.length;

  const client = await connect();
  // The registry is created by the server on the first call; we wait for it in order to edit config.json.
  const opts = await call(client, "council_options");
  const o = ok(opts, "council_options");

  // 1
  assert.equal(o.defaults.materialsChars, 60000, "defaults.materialsChars");
  step(1, "defaults.materialsChars = 60000");

  // 2
  const ins = client.getInstructions() ?? "";
  const { tools } = await client.listTools();
  const start = tools.find((t) => t.name === "council_start")!;
  const desc = start.description ?? "";
  for (const [where, t] of [["instructions", ins], ["council_start description", desc]] as const) {
    for (const w of ["attachments", "абсолют", "назва", "объём"]) assert.ok(t.includes(w), `${where}: no "${w}"`);
    assert.ok(/число|числ/.test(t), `${where}: no number of materials`);
  }
  assert.ok(desc.includes("участники × круги × 3"), "council_start description: no formula \"участники × круги × 3\"");
  const att = (start.inputSchema.properties as Record<string, { type?: string; items?: { type?: string } }>)["attachments"];
  assert.ok(att && att.type === "array" && att.items?.type === "string", "the council_start input schema has no attachments: array of strings");
  step(2, "rules about attachments in the instructions and the description, the formula \"участники × круги × 3\" in place, attachments is an array of strings");

  const scriptedProv = o.providers.find((p: { id: string }) => p.id === "scripted");
  for (const m of ["consensus/p1.json", "consensus/p2.json"]) assert.ok(scriptedProv?.models.includes(m), `council_options: no scenario ${m}`);
  const two = scripted("consensus/p1.json", "consensus/p2.json");
  const topic = (tag: string) => `ТЕМА-16 (${tag}): выбрать имя проекта по приложенным файлам.`;

  // 3
  const r3 = await call(client, "council_start", { topic: topic("rel"), participants: two, attachments: ["input/a.txt"] });
  assert.ok(r3.isError, "step 3: an error was expected");
  assert.ok(body(r3).includes("input/a.txt") && /абсолютн/.test(body(r3)), `step 3: the error has no path and no absolute-path requirement: ${body(r3)}`);
  noLeaks(body(r3), "step 3");
  assert.equal(sessionIds().length, 0, "step 3: sessions appeared");
  step(3, "the relative path is rejected, the text names input/a.txt and requires an absolute path, 0 sessions");

  // 4
  const r4 = await call(client, "council_start", { topic: topic("scripted"), participants: two, maxRounds: 3, attachments: [abs("a.txt"), abs("folder")] });
  const s4 = ok(r4, "step 4");
  created++;
  okResponses.push(body(r4));
  assert.equal(s4.materials.count, 2, "step 4: materials.count");
  assert.equal(s4.materials.chars, sumChars, "step 4: materials.chars");
  const sk = s4.materials.skipped as { name: string; reason: string }[];
  for (const n of ["folder/node_modules", "folder/bin.dat"]) {
    const e = sk.find((x) => x.name === n);
    assert.ok(e && e.reason.trim() !== "", `step 4: no skipped ${n} with a reason (have: ${JSON.stringify(sk)})`);
  }
  assert.equal(s4.maxCalls, 18, "step 4: maxCalls");
  noLeaks(body(r4), "step 4");
  step(4, `materials.count 2, chars ${sumChars}, skipped ${sk.map((x) => x.name).join(", ")}, maxCalls 18, no labels or paths`);

  // 5
  const id4 = s4.sessionId as string;
  const f5 = await finish(client, id4);
  assert.equal(f5.status, "consensus", "step 5: result");
  assert.deepEqual(f5.materials.names, ["a.txt", "folder/b.txt"], "step 5: materials.names");
  assert.equal(f5.materials.chars, sumChars, "step 5: materials.chars");
  okResponses.push(JSON.stringify(f5));
  for (const [m, t] of [["m1", TEXT_A], ["m2", TEXT_B]] as const) {
    assert.equal(readFileSync(join(sessionsPath, id4, "materials", `${m}.txt`), "utf8"), t, `step 5: snapshot ${m}.txt`);
  }
  const fake = await startFakeServer();
  let id5: string;
  try {
    const cfg = readCfg();
    cfg.providers.push({ id: "fake", kind: "openai-http", label: "Fake", models: [], baseUrl: fake.url });
    writeCfg(cfg);
    const r5 = await call(client, "council_start", {
      topic: topic("http"), maxRounds: 2, attachments: [abs("a.txt"), abs("folder")],
      participants: [{ providerId: "fake", model: "fake-amend" }, { providerId: "fake", model: "fake-agree" }],
    });
    const s5 = ok(r5, "step 5 (http)");
    created++;
    okResponses.push(body(r5));
    id5 = s5.sessionId;
    const f = await finish(client, id5);
    okResponses.push(JSON.stringify(f));
    assert.equal(f.status, "consensus", `step 5 (http): result ${f.status}`);
    const turns = fake.requests.map((r) => JSON.stringify((r.body as { messages?: unknown } | null)?.messages ?? null))
      .map((s, i) => ({ s, i })).filter((x) => x.s !== "null");
    assert.ok(turns.length >= 2, `step 5 (http): turn requests ${turns.length}`);
    for (const { i } of turns) {
      const msgs = (fake.requests[i]!.body as { messages: { content: unknown }[] }).messages;
      const text = msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      const tTopic = text.indexOf("# Тема\n"), tMat = text.indexOf("# Материалы владельца"), tSol = text.indexOf("# Текущая версия решения");
      const pa = text.indexOf(TEXT_A), pb = text.indexOf(TEXT_B);
      assert.ok(tTopic >= 0 && text.includes("ТЕМА-16"), `request ${i}: no topic`);
      assert.ok(tMat > tTopic, `request ${i}: the materials section is not after the topic`);
      assert.ok(pa > tMat && pb > tMat, `request ${i}: no full text of a.txt or b.txt`);
      if (tSol >= 0) assert.ok(pa < tSol && pb < tSol, `request ${i}: the materials are not before the solution section`);
      assert.ok(!text.includes(LNM), `request ${i}: node_modules label`);
    }
    step(5, `status consensus, names [a.txt, folder/b.txt], chars ${sumChars}, snapshots m1/m2 are exact; turn requests to the fake server ${turns.length}, each has both texts after the topic and before the solution`);
  } finally {
    await fake.close();
  }

  // 6
  const before = sessionIds().length;
  const missing = abs("нет-такого.txt");
  const r6 = await call(client, "council_start", { topic: topic("bad"), participants: two, attachments: [missing, abs("unsafe/.env.local")] });
  assert.ok(r6.isError, "step 6: an error was expected");
  const t6 = body(r6);
  assert.ok(t6.includes("нет-такого.txt"), `step 6: no reason for the nonexistent path: ${t6}`);
  assert.ok(t6.includes(".env.local"), `step 6: no reason for .env.local: ${t6}`);
  assert.ok(t6.split("\n").length >= 2, `step 6: a reason per path was expected: ${t6}`);
  noLeaks(t6, "step 6", false);
  assert.equal(sessionIds().length, before, "step 6: the number of sessions changed");
  const cfg6 = readCfg();
  try {
    writeCfg({ ...cfg6, defaults: { ...cfg6.defaults, materialsChars: 1 } });
    const r6b = await call(client, "council_start", { topic: topic("limit"), participants: two, attachments: [abs("folder")] });
    assert.ok(r6b.isError, "step 6: limit 1: an error was expected");
    const t = body(r6b);
    assert.ok(t.includes(String(TEXT_B.length)), `step 6: no size ${TEXT_B.length}: ${t}`);
    assert.ok(/лимит\s*1(?!\d)/.test(t), `step 6: no "лимит 1": ${t}`);
    assert.ok(t.includes("b.txt"), `step 6: no name of the largest file: ${t}`);
    noLeaks(t, "step 6 (limit)", false);
    assert.equal(sessionIds().length, before, "step 6 (limit): the number of sessions changed");
  } finally {
    writeCfg(cfg6);
  }
  assert.equal(readCfg().defaults.materialsChars, 60000, "the limit was not restored");
  step(6, "a nonexistent path and .env.local are rejected with a reason for each, with limit 1 — an error with the size, \"лимит 1\" and b.txt; no sessions added");

  // 7
  const log = readFileSync(join(home, "logs/app.log"), "utf8");
  noLeaks(log, "logs/app.log");
  assert.ok(!log.includes("input/a.txt"), "logs/app.log: relative path input/a.txt");
  assert.ok(new RegExp(`материалов 2.*${sumChars}`).test(log), "logs/app.log: no \"материалов 2\" line with the size");
  const ids = sessionIds();
  for (const id of ids) noLeaks(readFileSync(join(sessionsPath, id, "events.jsonl"), "utf8"), `events.jsonl ${id}`);
  for (const [i, t] of okResponses.entries()) noLeaks(t, `successful response #${i + 1}`);
  step(7, `app.log, events.jsonl (${ids.length}) and responses (${okResponses.length}) are clean: no labels, secret or paths; the log has "материалов 2" and the size`);

  // 8
  const newId = randomUUID();
  const dst = join(sessionsPath, newId);
  cpSync(join(sessionsPath, id4), dst, { recursive: true });
  rmSync(join(dst, "materials"), { recursive: true, force: true });
  const lines = readFileSync(join(dst, "events.jsonl"), "utf8").split("\n").map((l) => {
    if (!l) return l;
    const e = JSON.parse(l.replaceAll(id4, newId));
    if (e.type === "session_created") delete e.session.materials;
    return JSON.stringify(e);
  });
  writeFileSync(join(dst, "events.jsonl"), lines.join("\n"));
  const s8 = ok(await call(client, "council_status", { sessionId: newId }), "step 8");
  assert.equal(s8.status, "consensus", "step 8: status");
  assert.deepEqual(s8.materials, { names: [], chars: 0 }, "step 8: materials");
  assert.equal(s8.solution?.text, f5.solution?.text, "step 8: the solution differs");
  step(8, "old session without materials: consensus, the solution is as before, materials {names: [], chars: 0}");

  console.log(`total: steps 8, sessions created ${created} (plus a copy for step 8), real model calls: 0`);
  return 0;
}

let code = 1;
try {
  code = await run();
} catch (e) {
  console.error(`FAILURE: ${e instanceof Error ? e.message : String(e)}`);
}
for (const c of clients) await c.close().catch(() => {});
await sleep(100);
if (code === 0 && ownHome) rmSync(ownHome, { recursive: true, force: true });
else if (code !== 0) console.error(`Data folder kept: ${home}`);
process.exit(code);
