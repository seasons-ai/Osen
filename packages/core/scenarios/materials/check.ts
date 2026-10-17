// Live check of the owner's materials: COUNCIL_DEV=1 COUNCIL_HOME="<folder>" node packages/core/scenarios/materials/check.ts
import "../language-ru.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  INITIAL_MATERIALS, MaterialsError, collectMaterials, createScriptedDriver, createSession, ensureDataDir,
  eventsPath, materialPath, readEvents, resolveDataDir, runStoredSession,
} from "../../src/index.ts";
import type { CollectedMaterial, ParticipantDriver, Scenario } from "../../src/index.ts";

const home = process.env.COUNCIL_HOME?.trim();
if (!home) {
  console.error("COUNCIL_HOME is not set. The script writes fixtures and sessions only to this folder so as not to touch the owner's data.");
  console.error('Run: COUNCIL_DEV=1 COUNCIL_HOME="<folder>" node packages/core/scenarios/materials/check.ts');
  process.exit(2);
}
const dataDir = ensureDataDir(resolveDataDir(process.env));
const input = join(dataDir, "input");
const opts = { materialsChars: INITIAL_MATERIALS.materialsChars, materialsIgnore: INITIAL_MATERIALS.materialsIgnore };

const TEXT = {
  topic: "Тема файла: выбрать имя для проекта. МЕТКА-TOPIC-7f3a\nВторая строка.\n",
  a: "Файл a: требования к имени — коротко и понятно. МЕТКА-A-91c2\n",
  b: "Файл b без перевода строки, с эмодзи 🐱. МЕТКА-B-5d08",
};
const IGNORED = ["МЕТКА-CACHE-1e44", "МЕТКА-NODEMODULES-b27c"];
const SECRET = "SECRET=фиктивная-строка-НЕ-СЕКРЕТ-zz91";
const SECRET_VALUE = "фиктивная-строка-НЕ-СЕКРЕТ-zz91";

function put(rel: string, data: string | Buffer): void {
  const p = join(input, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, data);
}

// Returns true if the symlink could be created.
function makeFixtures(): boolean {
  rmSync(input, { recursive: true, force: true });
  put("topic.txt", TEXT.topic);
  put("folder/a.txt", TEXT.a);
  put("folder/sub/b.txt", TEXT.b);
  put("folder/.cache/x.txt", `кэш ${IGNORED[0]}\n`);
  put("folder/node_modules/y.txt", `модуль ${IGNORED[1]}\n`);
  put("folder/binary.bin", Buffer.from([0x50, 0x00, 0x01, 0x02, 0x00, 0xff]));
  put("unsafe/.env.local", `${SECRET}\n`);
  try {
    symlinkSync(join(input, "folder/sub"), join(input, "folder/link"));
    return true;
  } catch {
    console.log("Symbolic links are unavailable: the link check is skipped.");
    return false;
  }
}

function collect(): CollectedMaterial[] {
  return collectMaterials([join(input, "topic.txt"), join(input, "folder")], opts).materials;
}

const step = (stance: string, solution: string | null, reasoning = "Довод по материалам.") => ({
  response: { stance, reasoning, solution, answers: [], questions: [] },
});
const sc = (...steps: Scenario["steps"]): Scenario => ({ steps });
const mainScripts = () => [
  sc(step("amend", "Версия 1."), step("amend", "Версия 2.")),
  sc(step("object", null, "Возражаю против версии 1."), step("agree", null)),
];

function checkPrompt(label: string, call: number, who: string, prompt: string, ms: readonly CollectedMaterial[]): void {
  const at = `${label}, call ${call} (${who})`;
  const pos = (s: string, what: string) => {
    const i = prompt.indexOf(s);
    assert.ok(i >= 0, `${at}: no "${what}"`);
    return i;
  };
  const order = [pos("# Тема", "# Тема"), pos("# Материалы владельца", "# Материалы владельца")];
  for (const m of ms) {
    assert.ok(prompt.includes(m.text), `${at}: no full text of ${m.id}`);
    order.push(pos(`${m.name}\n${m.text}`, `name and text of ${m.id}`));
  }
  order.push(pos("# Текущая версия решения", "# Текущая версия решения"));
  assert.deepEqual(order, [...order].sort((x, y) => x - y), `${at}: section order violated`);
  for (const bad of [...IGNORED, SECRET_VALUE, "МЕТКА-NEW"]) assert.ok(!prompt.includes(bad), `${at}: extra marker ${bad} in the request`);
}

async function run(
  label: string, ms: CollectedMaterial[], scripts: Scenario[], opts2: { contextChars: number },
  extra?: (prompt: string, call: number, who: string) => void, onFirst?: () => void,
) {
  const session = createSession({
    topic: "Выбрать имя для проекта по приложенным материалам.", framing: "", origin: "cli", materials: ms,
    participants: scripts.map((_, i) => ({ name: `Участник ${i + 1}`, providerId: "scripted", model: "check", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: opts2.contextChars, materialsChars: INITIAL_MATERIALS.materialsChars },
  }, { maxParticipants: 8 });
  let calls = 0;
  const drivers: Record<string, ParticipantDriver> = {};
  scripts.forEach((s, i) => {
    const who = `p${i + 1}`;
    const real = createScriptedDriver(s, process.env);
    drivers[who] = {
      async call(request) {
        const n = ++calls;
        checkPrompt(label, n, who, request.prompt, ms);
        extra?.(request.prompt, n, who);
        console.log(`✓ ${label}, call ${n} (${who}): materials ${ms[0]!.id}–${ms.at(-1)!.id} in full, after the topic and before the decision`);
        const out = await real.call(request);
        if (n === 1) onFirst?.();
        return out;
      },
    };
  });
  const result = await runStoredSession({ session, drivers, dataDir, materials: ms });
  console.log(`${label}: session ${session.id}, status ${result.state.finish?.status}, calls ${calls}`);
  assert.equal(result.state.finish?.status, "consensus", `${label}: consensus expected`);
  return { session, calls };
}

const hasLink = makeFixtures();

// 2. Collection
const set = collectMaterials([join(input, "topic.txt"), join(input, "folder")], opts);
const originals = set.materials;
assert.deepEqual(originals.map((m) => [m.id, m.name]), [["m1", "topic.txt"], ["m2", "folder/a.txt"], ["m3", "folder/sub/b.txt"]]);
for (const n of [".cache", "node_modules", "binary.bin", ...(hasLink ? ["link"] : [])]) {
  const hit = set.skipped.find((s) => s.name.endsWith(n));
  assert.ok(hit && hit.reason.length > 0, `not skipped with a reason: ${n}`);
}
console.log(`Materials collected: ${originals.length}, characters: ${originals.reduce((n, m) => n + m.chars, 0)}`);
for (const s of set.skipped) console.log(`  skipped: ${s.name} — ${s.reason}`);

// 3. Refusals
for (const [what, p] of [["file .env.local", "unsafe/.env.local"]] as const) {
  assert.throws(() => collectMaterials([join(input, p)], opts), (e) => {
    assert.ok(e instanceof MaterialsError, `${what}: MaterialsError expected`);
    assert.ok(!e.message.includes(SECRET_VALUE) && !e.reasons.join("\n").includes(SECRET_VALUE), `${what}: the secret leaked into the message`);
    return true;
  });
  console.log(`✓ refusal: ${what} — MaterialsError, no secret in the message`);
}
// an environment file inside a folder is skipped without reading, not refused
const unsafe = collectMaterials([join(input, "unsafe")], opts);
assert.ok(unsafe.skipped.some((s) => s.name === "unsafe/.env.local" && s.reason.includes("защита секретов")), "folder with .env.local: no skip with a reason");
assert.ok(!JSON.stringify(unsafe).includes(SECRET_VALUE), "folder with .env.local: the secret got into the set");
console.log("✓ skip: folder with .env.local — the environment file was not read");

// 4. Session A
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const A = await run("session A", originals, mainScripts(), { contextChars: 24000 }, undefined, () => {
  writeFileSync(join(input, "topic.txt"), "Новый текст. МЕТКА-NEW-0001\n");
  unlinkSync(join(input, "folder/a.txt"));
  writeFileSync(join(input, "folder/sub/b.txt"), "Перезаписано. МЕТКА-NEW-0002");
});
assert.equal(A.calls, 4, "session A: 4 calls expected");
const evText = readFileSync(eventsPath(dataDir, A.session.id), "utf8");
const created = readEvents(dataDir, A.session.id)!.events.find((e) => e.type === "session_created") as any;
assert.ok(created, "no session_created");
assert.equal(created.session.materials.length, 3);
originals.forEach((m, i) => {
  const snap = readFileSync(materialPath(dataDir, A.session.id, m.id));
  assert.ok(snap.equals(Buffer.from(m.text, "utf8")), `snapshot ${m.id} differs from the original`);
  assert.equal(sha(snap), created.session.materials[i].sha256, `sha256 of snapshot ${m.id}`);
  assert.deepEqual(Object.keys(created.session.materials[i]).sort(), ["chars", "id", "name", "sha256"]);
  assert.ok(!evText.includes(m.text), `text of ${m.id} got into events.jsonl`);
});
for (const mark of ["МЕТКА-", ...IGNORED, SECRET_VALUE]) assert.ok(!evText.includes(mark), `events.jsonl contains ${mark}`);
assert.ok(!evText.includes(resolve(input)), "events.jsonl contains the absolute path of input");
console.log("✓ session A: snapshots, sha256, metadata and a journal without texts and paths");

// 5. Session B
makeFixtures();
const msB = collect();
const first: Record<string, string> = {};
const section = (p: string) => p.slice(p.indexOf("# Материалы владельца"), p.indexOf("# Текущая версия решения"));
const RAW = "это не JSON";
await run("session B", msB, [
  sc({ error: "временный сбой", retryable: true }, step("amend", "Версия 1.")),
  sc({ raw: RAW }, step("agree", null)),
], { contextChars: 24000 }, (prompt, _n, who) => {
  if (!first[who]) return void (first[who] = prompt);
  if (who !== "p2") return;
  assert.ok(prompt.length > first.p2!.length, "p2: the correction request is not longer than the first");
  assert.ok(prompt.includes(section(first.p2!)), "p2: no materials section in the correction request");
  assert.ok(prompt.includes("# Исправь предыдущий ответ") && prompt.includes(RAW), "p2: no error description and wrong answer");
  console.log("✓ session B: the p2 correction request contains the materials, the error and the wrong answer");
});

// 6. Session C
makeFixtures();
const msC = collect();
await run("session C", msC, mainScripts(), { contextChars: 1 }, (prompt, n, who) => {
  if (n < 3) return;
  assert.ok(prompt.includes("[Ранние ходы опущены из-за лимита контекста:"), `session C, call ${n} (${who}): no note about omitted turns`);
});

// 7. Finish
makeFixtures();
console.log("Materials check passed.");
