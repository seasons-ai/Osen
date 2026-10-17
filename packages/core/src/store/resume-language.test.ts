import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CollectedMaterial } from "../materials.ts";
import { createSession } from "../engine.ts";
import { createScriptedDriver } from "../participants/scripted.ts";
import type { ParticipantDriver } from "../participants/driver.ts";
import type { Scenario } from "../participants/scripted.ts";
import type { Limits, SessionEvent } from "../protocol/schema.ts";
import { getProcessLanguage, setProcessLanguage } from "../i18n/process-language.ts";
import type { Registry } from "../registry/config.ts";
import { eventsPath, materialPath, readEvents } from "./journal.ts";
import { planResume, ResumeRejectedError, resumeDrivers, runResumedSession } from "./resume.ts";
import { runStoredSession } from "./run.ts";
import { readSession } from "./sessions.ts";

type Step = Scenario["steps"][number];
const resp = (stance: string, solution: string | null): Step => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });
const fatal: Step = { error: "fatal", retryable: false };
const env = { COUNCIL_DEV: "1" };
const dead = () => false;
const registry = () => ({ providers: [], defaults: {} }) as unknown as Registry;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "resume-lang-")); dirs.push(d); return d; };
const before = getProcessLanguage();
afterEach(() => { setProcessLanguage(before); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const scripted = (...steps: Step[]): ParticipantDriver => createScriptedDriver({ steps }, env);
const file = (dir: string, name: string, steps: Step[]) => { const p = join(dir, `${name}.json`); writeFileSync(p, JSON.stringify({ steps })); return p; };
const mk = (id: string, o: { n?: number; maxRounds?: number; models?: string[]; providers?: string[]; synth?: boolean } = {}) =>
  createSession({
    topic: "Тема", framing: "", origin: "cli", ...(o.synth ? { drafts: { synthesizerId: "p2" } } : {}),
    limits: { maxRounds: o.maxRounds ?? 3, turnTimeoutSec: 30, contextChars: 20000 } as Limits,
    participants: Array.from({ length: o.n ?? 2 }, (_, i) => ({ name: `N${i + 1}`, providerId: o.providers?.[i] ?? "scripted", model: o.models?.[i] ?? "m", role: null })),
  }, { maxParticipants: 8, id });
const rewrite = (dir: string, id: string, fn: (e: SessionEvent) => SessionEvent | null) => {
  const evs = readEvents(dir, id)!.events.map(fn).filter((e): e is SessionEvent => e !== null);
  writeFileSync(eventsPath(dir, id), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
};

// Preparation in ru: sessions with different statuses in one folder.
async function prepare(dir: string) {
  setProcessLanguage("ru");
  await runStoredSession({ session: mk("nc", { maxRounds: 1 }), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(resp("object", null)) }, dataDir: dir });
  await runStoredSession({ session: mk("c"), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(resp("agree", null)) }, dataDir: dir });
  // 3 participants: p2 and p3 drop out, p1 stays alone (failed with reasonCode)
  const f1 = file(dir, "p1", [resp("amend", "v1")]);
  await runStoredSession({ session: mk("few", { n: 3, models: [f1, "x", "y"] }), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(fatal), p3: scripted(fatal) }, dataDir: dir });
  // token cap exhausted
  await runStoredSession({ session: mk("cap", { maxRounds: 1 }), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(resp("object", null)) }, dataDir: dir });
  let first = true;
  rewrite(dir, "cap", (e) => {
    if (e.type === "session_created") return { ...e, session: { ...e.session, limits: { ...e.session.limits, maxRounds: 3, maxTotalTokens: 1200 } } };
    if (e.type === "turn_completed" && first) { first = false; return { ...e, usage: { inputTokens: 1000, outputTokens: 500 } }; }
    if (e.type === "session_finished") return { ...e, status: "stopped", reason: "token_cap" };
    return e;
  });
  await runStoredSession({ session: mk("pg", { providers: ["ghost", "scripted"], maxRounds: 1 }), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(resp("object", null)) }, dataDir: dir });
  // synthesizer p2 dropped out without version 1
  const bad: ParticipantDriver = { call: async () => ({ text: "это не JSON", usage: {} }) } as unknown as ParticipantDriver;
  const ok = (): ParticipantDriver => ({ call: async () => ({ text: JSON.stringify({ stance: "amend", reasoning: "r", solution: "x", answers: [], questions: [] }), usage: {} }) } as unknown as ParticipantDriver);
  await runStoredSession({ session: mk("syn", { n: 3, synth: true }), drivers: { p1: ok(), p2: bad, p3: ok() }, dataDir: dir });
  rewrite(dir, "syn", (e) => (e.type === "session_finished" ? null : e));
  await prepareMore(dir);
}

const alive = () => true;
const mat = (id: string, name: string, text: string): CollectedMaterial => ({ id, name, chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex"), text });
const mats = [mat("m1", "a.txt", "Текст А")];
const mkMat = (id: string) => createSession({
  topic: "Тема", framing: "", origin: "cli",
  limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 20000, materialsChars: 10000 } as Limits,
  participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
  materials: mats,
}, { maxParticipants: 8, id });
const twoRounds = (dir: string, id: string) =>
  runStoredSession({ session: mk(id, { maxRounds: 1 }), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(resp("object", null)) }, dataDir: dir });

// Additional sessions for refusals; prepared in ru.
async function prepareMore(dir: string) {
  setProcessLanguage("ru");
  await twoRounds(dir, "nv");
  const n = readEvents(dir, "nv")!.events.length;
  appendFileSync(eventsPath(dir, "nv"), JSON.stringify({ seq: n + 1, ts: "2026-01-01T00:00:00.000Z", type: "future_event" }) + "\n");
  appendFileSync(eventsPath(dir, "nv"), JSON.stringify({ ...readEvents(dir, "nv")!.events.at(-1)!, seq: n + 2 }) + "\n");
  await twoRounds(dir, "cr");
  appendFileSync(eventsPath(dir, "cr"), '{"seq":');
  await runStoredSession({ session: mk("rn"), drivers: { p1: scripted(resp("amend", "v1"), resp("agree", null)), p2: scripted(resp("agree", null), resp("agree", null)) }, dataDir: dir });
  let cut = false;
  rewrite(dir, "rn", (e) => { if (cut) return null; if (e.type === "session_created") return { ...e, pid: 1 }; if (e.type === "turn_completed") cut = true; return e; });
  await runStoredSession({ session: mk("fl"), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(fatal) }, dataDir: dir });
  rewrite(dir, "fl", (e) => { if (e.type !== "session_finished") return e; const { reasonCode: _drop, ...rest } = e; return rest as SessionEvent; });
  await runStoredSession({ session: mk("bz", { maxRounds: 1, models: [file(dir, "bz1", [resp("amend", "v1"), resp("agree", null)]), file(dir, "bz2", [resp("object", null), resp("agree", null)])] }), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(resp("object", null)) }, dataDir: dir });
  for (const id of ["ma", "mb"]) {
    await runStoredSession({ session: mkMat(id), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(resp("object", null)) }, dataDir: dir, materials: mats });
  }
  rmSync(materialPath(dir, "ma", "m1"));
  writeFileSync(materialPath(dir, "mb", "m1"), "другой текст");
  // session where participant p2 is active and its scenario is readable: it cannot be replaced
  const f1 = file(dir, "av1", [resp("amend", "v1"), resp("agree", null)]);
  const f2 = file(dir, "av2", [resp("object", null), resp("agree", null)]);
  await runStoredSession({ session: mk("av", { maxRounds: 1, models: [f1, f2] }), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(resp("object", null)) }, dataDir: dir });
  // already replaced participant: failure "fewer than two active", replacement of p2, journal cut after session_resumed
  const g1 = file(dir, "ra1", [resp("amend", "v1"), resp("agree", null)]);
  await runStoredSession({ session: mk("ra", { n: 3, models: [g1, "x", "y"] }), drivers: { p1: scripted(resp("amend", "v1")), p2: scripted(fatal), p3: scripted(fatal) }, dataDir: dir });
  const plan = planResume(dir, "ra", { replacements: [rep("p2", file(dir, "ra-new", [resp("agree", null), resp("agree", null)]))], isAlive: dead });
  const { drivers } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
  await runResumedSession({ dataDir: dir, plan, drivers, isAlive: dead });
  const evs = readEvents(dir, "ra")!.events;
  const idx = evs.findIndex((e) => e.type === "session_resumed");
  writeFileSync(eventsPath(dir, "ra"), evs.slice(0, idx + 1).map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const rep = (participantId: string, model: string, extra: Partial<{ providerId: string; name: string }> = {}) => ({ participantId, providerId: "scripted", model, ...extra });
type Case = { name: string; reason: string; ru: string; values: string[]; recorded?: string[]; run: (dir: string) => Promise<unknown> | unknown };
const cases = (dir: string): Case[] => [
  { name: "not_found", reason: "not_found", ru: "Сессия nope не найдена.", values: ["nope"], run: () => planResume(dir, "nope", { isAlive: dead }) },
  { name: "consensus", reason: "consensus", ru: "Сессия c: согласие уже достигнуто, продолжать нечего.", values: ["c"], run: () => planResume(dir, "c", { isAlive: dead }) },
  { name: "no_rounds_left", reason: "no_rounds_left", ru: "Сессия nc: круги прежнего лимита пройдены: укажите число дополнительных кругов (--rounds).", values: ["nc", "--rounds"], run: () => planResume(dir, "nc", { isAlive: dead }) },
  { name: "bad_rounds", reason: "bad_rounds", ru: "Сессия nc: число дополнительных кругов должно быть целым числом не меньше 1.", values: ["nc"], run: () => planResume(dir, "nc", { rounds: 0, isAlive: dead }) },
  { name: "bad_token_cap", reason: "bad_token_cap", ru: "Сессия nc: потолок токенов должен быть целым числом не меньше 1.", values: ["nc"], run: () => planResume(dir, "nc", { rounds: 1, maxTotalTokens: 0, isAlive: dead }) },
  { name: "token_cap (исчерпан)", reason: "token_cap", ru: "Сессия cap: потолок токенов 1200 исчерпан: израсходовано 1500. Укажите новый потолок больше 1500 (--max-tokens) или снимите его (--no-max-tokens).", values: ["cap", "1200", "1500", "--max-tokens", "--no-max-tokens"], run: () => planResume(dir, "cap", { isAlive: dead }) },
  { name: "token_cap (новый не выше)", reason: "token_cap", ru: "Сессия cap: новый потолок токенов 1000 не выше уже израсходованного 1500: укажите потолок больше 1500 (--max-tokens) или снимите его (--no-max-tokens).", values: ["cap", "1000", "1500", "--max-tokens", "--no-max-tokens"], run: () => planResume(dir, "cap", { maxTotalTokens: 1000, isAlive: dead }) },
  { name: "too_few_active", reason: "too_few_active", ru: "Сессия few: активных участников меньше двух, продолжать некому. Замените выбывшего участника (p2, p3), чтобы продолжить.", values: ["few", "p2", "p3"], run: () => planResume(dir, "few", { isAlive: dead }) },
  { name: "synthesizer", reason: "synthesizer", ru: "Сессия syn: синтезатор p2 «N2» выбыл, не создав версию 1; продолжение невозможно — запустите новую сессию с другим синтезатором.", values: ["syn", "p2", "N2"], run: () => planResume(dir, "syn", { isAlive: dead }) },
  { name: "replacement (дубль)", reason: "replacement", ru: "Сессия few: участник p2 указан в заменах дважды.", values: ["few", "p2"], run: () => planResume(dir, "few", { replacements: [rep("p2", "x"), rep("p2", "x")], isAlive: dead }) },
  { name: "replacement (неизвестный)", reason: "replacement", ru: "Сессия few: участника p9 в сессии нет.", values: ["few", "p9"], run: () => planResume(dir, "few", { replacements: [rep("p9", "x")], isAlive: dead }) },
  { name: "replacement (провайдер не в реестре)", reason: "replacement", ru: "Замена p2 → p4 «Участник 4»: провайдер «ghost» отсутствует в реестре.", values: ["p2", "p4", "ghost"], recorded: ["Участник 4"], run: async () => {
    // the new record's name is set explicitly: the language does not affect the substituted name
    const plan = planResume(dir, "few", { replacements: [rep("p2", "x", { providerId: "ghost", name: "Участник 4" })], isAlive: dead });
    await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
  } },
  { name: "participant", reason: "participant", ru: "Участник p1 «N1»: провайдер «ghost» отсутствует в реестре.", values: ["p1", "N1", "ghost"], run: async () => {
    await resumeDrivers(planResume(dir, "pg", { rounds: 1, isAlive: dead }), { registry: registry(), env, dataDir: dir });
  } },
];

const more = (dir: string): Case[] => {
  const nvN = readEvents(dir, "nv")!.events.length;
  const crN = readEvents(dir, "cr")!.events.length;
  return [
    { name: "newer_version", reason: "newer_version", ru: `Сессия nv: журнал записан более новой версией, прочитан до события №${nvN}; продолжение невозможно. Обновите приложение.`, values: ["nv", String(nvN)], run: () => planResume(dir, "nv", { rounds: 1, isAlive: dead }) },
    { name: "corrupted", reason: "corrupted", ru: `Сессия cr: журнал сессии повреждён: после события №${crN} идёт неполная или невалидная запись; продолжение невозможно.`, values: ["cr", String(crN)], run: () => planResume(dir, "cr", { rounds: 1, isAlive: dead }) },
    { name: "running", reason: "running", ru: "Сессия rn идёт: исполнитель ещё работает.", values: ["rn"], run: () => planResume(dir, "rn", { isAlive: alive }) },
    { name: "failed", reason: "failed", ru: "Сессия fl завершилась сбоем и продолжена быть не может.", values: ["fl"], run: () => planResume(dir, "fl", { isAlive: dead }) },
    { name: "busy (журнал изменился)", reason: "busy", ru: "Сессия bz: журнал изменился после проверки: повторите команду.", values: ["bz"], run: async () => {
      const plan = planResume(dir, "bz", { rounds: 1, isAlive: dead });
      const original = readFileSync(eventsPath(dir, "bz"));
      appendFileSync(eventsPath(dir, "bz"), "\n");
      try {
        const { drivers } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
        await runResumedSession({ dataDir: dir, plan, drivers, isAlive: dead });
      } finally { writeFileSync(eventsPath(dir, "bz"), original); }
    } },
    { name: "material (снимок отсутствует)", reason: "material", ru: "Материал «a.txt»: снимок отсутствует.", values: ["a.txt"], run: () => planResume(dir, "ma", { rounds: 1, isAlive: dead }) },
    { name: "material (хеш)", reason: "material", ru: "Материал «a.txt»: хеш снимка не совпал.", values: ["a.txt"], run: () => planResume(dir, "mb", { rounds: 1, isAlive: dead }) },
    { name: "replacement (уже заменён)", reason: "replacement", ru: "Сессия ra: участник p2 уже заменён: его место занимает p4.", values: ["ra", "p2", "p4"], run: () => planResume(dir, "ra", { replacements: [rep("p2", "x")], isAlive: dead }) },
    { name: "replacement (нужны провайдер и модель)", reason: "replacement", ru: "Сессия few: замена участника p2: нужны провайдер и модель.", values: ["few", "p2"], run: () => planResume(dir, "few", { replacements: [rep("p2", "x", { providerId: " " })], isAlive: dead }) },
    { name: "replacement (участник доступен)", reason: "replacement", ru: "Участник p2 «N2» доступен: заменить можно только выбывшего или недоступного участника.", values: ["p2", "N2"], run: async () => {
      const plan = planResume(dir, "av", { rounds: 1, replacements: [rep("p2", file(dir, "av-new", [resp("agree", null)]))], isAlive: dead });
      await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
    } },
    { name: "replacement (предел реестра)", reason: "replacement", ru: "Сессия few: после замен активных участников 3, а предел реестра 2.", values: ["few", "3", "2"], run: async () => {
      const plan = planResume(dir, "few", { replacements: [rep("p2", file(dir, "ol-a", [resp("agree", null)])), rep("p3", file(dir, "ol-b", [resp("agree", null)]))], isAlive: dead });
      await resumeDrivers(plan, { registry: { providers: [], defaults: { maxParticipants: 2 } } as unknown as Registry, env, dataDir: dir });
    } },
  ];
};

const outcome = async (c: Case) => {
  try { await c.run(""); } catch (e) { if (e instanceof ResumeRejectedError) return { reason: e.reason, message: e.message }; throw e; }
  throw new Error(`${c.name}: отказа нет`);
};

describe("Core messages in the selected language; refusal codes and identifiers do not depend on language: continuation refusals", () => {
  it("one input in ru and en: same reason, different texts, values in place, Russian text unchanged", async () => {
    const dir = tmp();
    await prepare(dir);
    for (const c of [...cases(dir), ...more(dir)]) {
      // the "participant" scenario creates the session on first launch: warming up in ru
      setProcessLanguage("ru");
      const ru = await outcome({ ...c, run: () => c.run(dir) });
      setProcessLanguage("en");
      const en = await outcome({ ...c, run: () => c.run(dir) });
      expect(ru.reason, c.name).toBe(c.reason);
      expect(en.reason, c.name).toBe(c.reason);
      expect(ru.message, c.name).toBe(c.ru);
      expect(en.message, c.name).not.toBe(ru.message);
      const enClean = (c.recorded ?? []).reduce((t, v) => t.split(v).join(""), en.message);
      expect(enClean, c.name).not.toMatch(/[\u0400-\u04FF]/);
      for (const v of c.values) { expect(ru.message, c.name).toContain(v); expect(en.message, c.name).toContain(v); }
    }
  });
});

describe("Texts written to the journal are not translated: mixed journal", () => {
  it("replacement without name in en: old bytes untouched, name Participant N, journal folds", async () => {
    const dir = tmp();
    await prepare(dir);
    const p = eventsPath(dir, "few");
    const old = readFileSync(p);
    expect(old.toString("utf8")).toContain("Активных участников осталось меньше двух."); // русская запись в журнале
    setProcessLanguage("en");
    const f = file(dir, "new", [resp("agree", null)]);
    const plan = planResume(dir, "few", { replacements: [rep("p2", f)], isAlive: dead });
    expect(plan.replacements[0]!.participant.name).toBe("Participant 4");
    const { drivers } = await resumeDrivers(plan, { registry: registry(), env, dataDir: dir });
    await runResumedSession({ dataDir: dir, plan, drivers, isAlive: dead });
    const now = readFileSync(p);
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(sha(now.subarray(0, old.length))).toBe(sha(old));
    const added = now.subarray(old.length).toString("utf8");
    expect(added).toContain("Participant 4");
    expect(added).not.toContain("Участник 4");
    const events = readEvents(dir, "few")!;
    expect(events.offset).toBe(events.size);
    expect(readSession(dir, "few", dead)!.state.session!.participants.map((x) => x.name)).toContain("Participant 4");
  });
});
