// Live check of resume: COUNCIL_DEV=1 node packages/core/scenarios/resume/check.ts
// Everything is written to a temporary data folder, the owner's folder is untouched.
import "../language-ru.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INITIAL_MATERIALS, ResumeRejectedError, collectMaterials, createScriptedDriver, createSession, ensureDataDir,
  materialPath, planResume, readEvents, resumeDrivers, runResumedSession, runStoredSession,
} from "../../src/index.ts";
import type { CollectedMaterial, ParticipantDriver, Registry } from "../../src/index.ts";

const dataDir = ensureDataDir(realpathSync(mkdtempSync(join(tmpdir(), "council-resume-check-"))));
const input = join(dataDir, "input");
mkdirSync(input);
const TEXT = { a: "Файл a: имя должно быть коротким. МЕТКА-A-31c9\n", b: "Файл b: без перевода строки. МЕТКА-B-77e2" };
const files = { a: join(input, "a.txt"), b: join(input, "b.txt") };
writeFileSync(files.a, TEXT.a);
writeFileSync(files.b, TEXT.b);
const opts = { materialsChars: INITIAL_MATERIALS.materialsChars, materialsIgnore: INITIAL_MATERIALS.materialsIgnore };
const originals: CollectedMaterial[] = collectMaterials([files.a, files.b], opts).materials;

const step = (stance: string, solution: string | null) => ({ response: { stance, reasoning: "Довод.", solution, answers: [], questions: [] } });
const scenario = (name: string, steps: unknown[]) => {
  const p = join(dataDir, `${name}.json`);
  writeFileSync(p, JSON.stringify({ steps }));
  return p;
};
const registry = { providers: [], defaults: {} } as unknown as Registry;

// A session with materials that reached no_consensus in one round.
async function firstSegment(tag: string): Promise<string> {
  const models = [scenario(`${tag}-p1`, [step("amend", "Версия 1."), step("agree", null)]), scenario(`${tag}-p2`, [step("object", null), step("agree", null)])];
  const session = createSession({
    topic: "Выбрать имя по материалам.", framing: "", origin: "cli", materials: originals,
    participants: models.map((model, i) => ({ name: `Участник ${i + 1}`, providerId: "scripted", model, role: null })),
    limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 24000, materialsChars: INITIAL_MATERIALS.materialsChars },
  }, { maxParticipants: 8 });
  const drivers = Object.fromEntries(models.map((m, i) => [`p${i + 1}`, createScriptedDriver({ steps: i ? [step("object", null)] : [step("amend", "Версия 1.")] }, process.env)]));
  const r = await runStoredSession({ session, drivers, dataDir, materials: originals });
  assert.equal(r.state.finish?.status, "no_consensus");
  return session.id;
}
const reasonOf = (id: string) => {
  try { planResume(dataDir, id, { rounds: 1 }); } catch (e) {
    assert.ok(e instanceof ResumeRejectedError, "ResumeRejectedError expected");
    return e;
  }
  throw new Error("a refusal was expected");
};

const id = await firstSegment("main");
console.log(`ok: the first segment ${id} ended with no_consensus`);
rmSync(input, { recursive: true });
console.log("ok: the original material files are deleted");

const plan = planResume(dataDir, id, { rounds: 1 });
const { drivers } = await resumeDrivers(plan, { registry, env: process.env, dataDir });
const prompts: string[] = [];
const wrapped: Record<string, ParticipantDriver> = Object.fromEntries(Object.entries(drivers).map(([k, d]) => [k, {
  async call(req) { prompts.push(req.prompt); return d.call(req); },
}]));
const run = await runResumedSession({ dataDir, plan, drivers: wrapped });
assert.equal(run.state.finish?.status, "consensus");
assert.ok(prompts.length >= 2, "no calls of the new segment");
for (const m of originals) {
  assert.ok(prompts[0]!.includes(`${m.name}\n${m.text}`), `first request: no name and full text of ${m.id}`);
}
console.log(`ok: the first request of the new segment contains the names and full texts of the materials (${originals.length}) although the original files are gone`);
const types = readEvents(dataDir, id)!.events.map((e) => e.type);
assert.equal(types.filter((t) => t === "session_created").length, 1);
assert.equal(types.filter((t) => t === "session_resumed").length, 1);
console.log("ok: the journal has one session_created and one session_resumed");

const miss = await firstSegment("miss");
unlinkSync(materialPath(dataDir, miss, "m1"));
const e1 = reasonOf(miss);
assert.equal(e1.reason, "material");
assert.ok(e1.message.includes(originals[0]!.name), "the refusal does not name the material");
console.log(`ok: refusal with a deleted snapshot — ${e1.message}`);

const bad = await firstSegment("bad");
writeFileSync(materialPath(dataDir, bad, "m2"), "изменённый текст");
const e2 = reasonOf(bad);
assert.equal(e2.reason, "material");
assert.ok(e2.message.includes(originals[1]!.name), "the refusal does not name the material");
console.log(`ok: refusal with a modified snapshot — ${e2.message}`);

rmSync(dataDir, { recursive: true, force: true });
console.log("Resume check passed.");
