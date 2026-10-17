import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { BUILTIN_TEMPLATES_DIR, appendEvent, createSessionJournal, initialRegistry, loadTemplates, readSession, runStoredSession } from "@model-council/core";
import type { Session, SessionEvent, TemplateCatalog } from "@model-council/core";
import { createMaterialsDraft } from "./materials.ts";
import { prepareRerun } from "./rerun.ts";
import { createTemplateEditor } from "./template-editor.ts";
import { createLauncher } from "./launcher.ts";
import { setupMain } from "../shared/messages/setup-main.ts";
import { scriptedProviderLabel } from "../shared/setup.ts";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = 40;
const STEPS = 8;
const LAUNCH_EVERY = 4; // a session with scripted participants is expensive: not in every seed
const SCEN = join(import.meta.dirname, "../../../../packages/core/scenarios/consensus");
const LANGS: Language[] = ["en", "ru"];
const cyr = /[А-Яа-яЁё]/;
const two = (n: number) => String(n).padStart(2, "0");

type Kind = "decision" | "copy" | "scripted";
interface Made { kind: Kind; lang: Language; want: string[]; read: () => string[]; reads: number }

let root: string;
let n = 0;
const counters = { sameLang: 0, differentLang: 0, manySwitches: 0, mixed: 0, repeatedReads: 0, decision: 0, copy: 0, scripted: 0 };
const pending: Promise<unknown>[] = [];

beforeAll(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "council-created-"))); });
afterAll(async () => { await Promise.allSettled(pending); rmSync(root, { recursive: true, force: true }); });
afterEach(() => setProcessLanguage("ru"));

const fresh = (name: string) => { const d = join(root, `${name}-${n++}`); mkdirSync(d); return d; };

// "Solution of the previous session: version <n>, <date>": a repeated "Discuss further", the name is read from the materials draft
function makeDecision(lang: Language, rnd: () => number): Made {
  const dir = fresh("rerun");
  const created = new Date(2026, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), 12);
  const ts = created.toISOString();
  const date = `${created.getFullYear()}-${two(created.getMonth() + 1)}-${two(created.getDate())}`;
  const id = "s1";
  const session: Session = {
    id, createdAt: ts, origin: "desktop", topic: "T", templateId: null, framing: "",
    participants: [{ id: "p1", name: "n1", providerId: "scripted", model: "m", role: null }, { id: "p2", name: "n2", providerId: "scripted", model: "m", role: null }],
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  };
  createSessionJournal(dir, id);
  const events: SessionEvent[] = [
    { seq: 1, ts, type: "session_created", session, pid: 1 },
    { seq: 2, ts, type: "turn_started", turn: 1, round: 1, participantId: "p1" },
    { seq: 3, ts, type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "amend", normalized: false, reasoning: "ok", solution: "Решение", version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1 },
    { seq: 4, ts, type: "session_finished", status: "consensus", version: 1, agreed: [], objectors: [] },
  ];
  for (const e of events) appendEvent(dir, id, e);
  const catalog = () => ({ templates: [], errors: [], neutralFraming: "" }) as unknown as TemplateCatalog;
  const d = createMaterialsDraft({ limits: () => ({ materialsChars: 100_000, materialsIgnore: [] }) });
  setProcessLanguage(lang);
  const v = prepareRerun({ dataDir: dir, catalog, materials: d }, id, true);
  const name = v.materials.items.at(-1)!.name;
  expect(name, `имя при создании, ${lang}`).toBe(setupMain(lang).decisionName(1, date));
  return { kind: "decision", lang, want: [name], reads: 0, read: () => [d.view().items.at(-1)!.name] };
}

// "(copy)" in English or its Russian counterpart: the template copy title is read by a repeated open edit
function makeCopy(lang: Language, rnd: () => number): Made {
  const root2 = fresh("tpl");
  const builtinDir = join(root2, "builtin"), userDir = join(root2, "user");
  mkdirSync(join(builtinDir, "ru"), { recursive: true }); mkdirSync(userDir);
  writeFileSync(join(builtinDir, "ru", "neutral.md"), "NEUTRAL");
  symlinkSync(join(builtinDir, "ru"), join(builtinDir, "en")); // both languages read the same fixture
  const base = `Tpl ${Math.floor(rnd() * 1000)}`;
  writeFileSync(join(builtinDir, "ru", "b1.json"), JSON.stringify({ id: "b1", title: base, category: "К", description: "d", exampleTopic: "t", framing: "F", roles: ["А"], limits: { maxRounds: 3 } }));
  const logger = { info: vi.fn(), error: vi.fn() };
  const ed = createTemplateEditor({ dirs: () => ({ builtinDir, userDir }), logger, sessionFraming: () => null });
  setProcessLanguage(lang);
  const copy = (ed.open({ mode: "duplicate", id: "b1" }) as unknown as { draft: { title: string } }).draft;
  const title = `${base} ${setupMain(lang).copySuffix}`;
  expect(copy.title, `название копии при создании, ${lang}`).toBe(title);
  const r = ed.create(copy);
  expect(r.ok).toBe(true);
  const cid = (r as { id: string }).id;
  return { kind: "copy", lang, want: [title], reads: 0, read: () => [(ed.open({ mode: "edit", id: cid }) as unknown as { draft: { title: string } }).draft.title] };
}

// "Scripted (p1)" in English or its Russian counterpart: the participant name is recorded in the session, read from disk
async function makeScripted(lang: Language): Promise<Made> {
  const dir = fresh("launch");
  const catalog = () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: join(dir, "templates") });
  const l = createLauncher({
    dataDir: dir, env: { COUNCIL_DEV: "1" }, logger: { info: () => {}, error: () => {} },
    registry: () => initialRegistry(["claude"]), catalog,
    scenarioPath: (m) => (m === "p1" || m === "p2" ? join(SCEN, `${m}.json`) : null),
    run: (o) => { const r = runStoredSession(o); pending.push(r); return r; },
  });
  setProcessLanguage(lang);
  const sp = (model: string) => ({ providerId: "scripted", model, role: null });
  const { id } = await l.start({ templateId: "pricing", topic: "T", participants: [sp("p1"), sp("p2")], maxRounds: 3 });
  await Promise.allSettled(pending);
  const read = () => readSession(dir, id)!.state.session!.participants.map((p) => p.name);
  const want = ["p1", "p2"].map((m) => `${scriptedProviderLabel(lang)} (${m})`);
  expect(read(), `имена при создании, ${lang}`).toEqual(want);
  return { kind: "scripted", lang, want, reads: 0, read };
}

describe("Data written at creation, in the language of the moment of creation", () => {
  it("property: created strings do not change on language switch and belong to the creation language", async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = mulberry32(seed);
      const int = (k: number) => Math.floor(rnd() * k);
      const log: string[] = [];
      const made: Made[] = [];
      let current: Language = LANGS[int(2)]!;
      let switches = 0;
      const kinds: Kind[] = ["decision", "copy"];
      if (seed % LAUNCH_EVERY === 0) kinds.push("scripted");
      const fail = (msg: string) => `зерно ${seed}, шаги: ${log.join(" > ")}: ${msg}`;
      const check = (m: Made) => {
        setProcessLanguage(current);
        const got = m.read();
        m.reads++;
        if (m.reads >= 2 && switches >= 2) counters.repeatedReads++;
        expect(got, fail(`${m.kind} (создано ${m.lang}, читается при ${current})`)).toEqual(m.want);
        for (const s of got) {
          if (m.lang === "en") expect(s, fail(`${m.kind}: кириллица в английской строке`)).not.toMatch(cyr);
          else expect(s, fail(`${m.kind}: нет кириллицы в русской строке`)).toMatch(cyr);
        }
      };
      const len = 3 + int(STEPS - 2);
      for (let step = 0; step < len; step++) {
        const r = rnd();
        if (r < 0.4) {
          const kind = kinds[int(kinds.length)]!;
          log.push(`создать ${kind}@${current}`);
          setProcessLanguage(current);
          const m = kind === "decision" ? makeDecision(current, rnd) : kind === "copy" ? makeCopy(current, rnd) : await makeScripted(current);
          counters[kind]++;
          made.push(m);
        } else if (r < 0.7) {
          const next = rnd() < 0.7 ? LANGS.find((l) => l !== current)! : current;
          log.push(`язык ${next}`);
          current = next; switches++;
          setProcessLanguage(current);
        } else if (made.length > 0) {
          const m = made[int(made.length)]!;
          log.push(`читать ${m.kind}@${m.lang} при ${current}`);
          check(m);
        }
      }
      // additional language switch and a final read of everything created
      for (const l of [...LANGS, ...LANGS]) { log.push(`язык ${l}`); current = l; switches++; for (const m of made) check(m); }
      for (const m of made) {
        if (m.lang === current) counters.sameLang++; else counters.differentLang++;
        if (switches >= 3) counters.manySwitches++;
      }
      if (new Set(made.map((m) => m.lang)).size === 2) counters.mixed++;
    }
    expect(counters.sameLang).toBeGreaterThan(0);
    expect(counters.differentLang).toBeGreaterThan(0);
    expect(counters.manySwitches).toBeGreaterThan(0);
    expect(counters.mixed).toBeGreaterThan(0);
    expect(counters.decision).toBeGreaterThan(0);
    expect(counters.copy).toBeGreaterThan(0);
    expect(counters.scripted).toBeGreaterThan(0);
    expect(counters.repeatedReads).toBeGreaterThan(0);
  }, 60_000);

  it("catalog: decisionName(language) does not depend on the process language and contains the version number and date verbatim", () => {
    const rnd = mulberry32(7);
    const dates = ["", ...Array.from({ length: 30 }, () => `${2000 + Math.floor(rnd() * 100)}-${two(1 + Math.floor(rnd() * 12))}-${two(1 + Math.floor(rnd() * 28))}`)];
    const PREFIX = { en: "Solution of the previous session: version ", ru: "Решение прошлой сессии: версия " };
    expect(setupMain("ru").decisionName(3, "")).toBe("Решение прошлой сессии: версия 3, ");
    expect(setupMain("en").decisionName(3, "")).toBe("Solution of the previous session: version 3, ");
    for (const process of LANGS) {
      setProcessLanguage(process);
      for (const date of dates) {
        for (const lang of LANGS) {
          const n = 1 + Math.floor(rnd() * 20);
          const name = setupMain(lang).decisionName(n, date);
          expect(name, `процесс ${process}, язык ${lang}, версия ${n}, дата «${date}»`).toBe(`${PREFIX[lang]}${n}, ${date}`);
        }
      }
    }
  });
});
