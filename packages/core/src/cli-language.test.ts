import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { EXIT, help, main } from "./cli.ts";
import { setProcessLanguage } from "./i18n/index.ts";
import type { Language } from "./i18n/index.ts";
import { cliMessages } from "./messages/cli.ts";
import { storeMessages } from "./messages/store.ts";
import { appendEvent, createSessionJournal } from "./store/journal.ts";
import { openOwnerQueue } from "./store/owner-messages.ts";
import { applyProcessLanguage } from "./store/preferences.ts";
import { BUILTIN_TEMPLATES_DIR } from "./templates/templates.ts";

const CYR = /[А-Яа-яЁё]/;
const tmps: string[] = [];
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "council-lang-"))); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(() => setProcessLanguage("ru"));

// Scenarios with English replies: Cyrillic in the output can come only from the council frame.
const scenarios = (dir: string) => {
  const step = (stance: string, solution: string | null) => ({ response: { stance, reasoning: "Fine.", solution, answers: [], questions: [] } });
  const p1 = join(dir, "p1.json"), p2 = join(dir, "p2.json");
  writeFileSync(p1, JSON.stringify({ steps: [step("amend", "Name it Max."), ...Array(4).fill(step("agree", null))] }));
  writeFileSync(p2, JSON.stringify({ steps: Array(4).fill(step("agree", null)) }));
  return ["--participant", `scripted:${p1}`, "--participant", `scripted:${p2}`];
};

async function run(argv: string[], home = tmp(), over: { builtinTemplatesDir?: string } = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, {
    stdout: (t) => out.push(t), stderr: (t) => err.push(t),
    env: { COUNCIL_HOME: home, COUNCIL_DEV: "1" },
    inspectDeps: { locate: async (agent) => ({ agent, found: false, searchPath: "", reason: `${agent}: not found` }) },
    ...over,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), home };
}

// Real entry point: the language is determined before argument parsing.
const councilTs = join(import.meta.dirname, "council.ts");
function council(env: Record<string, string>, args: string[]): Promise<{ code: number | null; err: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [councilTs, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, cwd: tmp() });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => done({ code, err }));
  });
}

describe("The council process language is determined before argument parsing", () => {
  const EN = "Error: Unknown option '--bogus'", RU = "Ошибка: Unknown option '--bogus'";
  it("default: argument parsing failure in English, exit code 2, data folder not created", async () => {
    const home = join(tmp(), "not-yet");
    const r = await council({ COUNCIL_HOME: home }, ["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(EN);
    expect(r.err).toContain(cliMessages("en").help);
    expect(existsSync(home)).toBe(false);
  });
  it("COUNCIL_LANG=ru overrides preferences.json with en", async () => {
    const home = tmp();
    writeFileSync(join(home, "preferences.json"), '{ "language": "en" }');
    const r = await council({ COUNCIL_HOME: home, COUNCIL_LANG: "ru" }, ["--bogus"]);
    expect([r.code, r.err.startsWith(RU)]).toEqual([2, true]);
  });
  it("preferences.json with ru and no variable", async () => {
    const home = tmp();
    writeFileSync(join(home, "preferences.json"), '{ "language": "ru" }');
    const r = await council({ COUNCIL_HOME: home }, ["--bogus"]);
    expect([r.code, r.err.startsWith(RU)]).toEqual([2, true]);
  });
  it("COUNCIL_LANG=ru from the data folder .env works as a variable", async () => {
    const home = tmp();
    writeFileSync(join(home, ".env"), "COUNCIL_LANG=ru\n");
    const r = await council({ COUNCIL_HOME: home }, ["--bogus"]);
    expect([r.code, r.err.startsWith(RU)]).toEqual([2, true]);
  });
  it("corrupted preferences.json: English, file unchanged", async () => {
    const home = tmp();
    writeFileSync(join(home, "preferences.json"), "{ broken");
    const r = await council({ COUNCIL_HOME: home }, ["--bogus"]);
    expect([r.code, r.err.startsWith(EN)]).toEqual([2, true]);
    expect(readFileSync(join(home, "preferences.json"), "utf8")).toBe("{ broken");
  });
  it("changing preferences.json after the language is determined does not change the language of the running main call", async () => {
    const home = tmp();
    writeFileSync(join(home, "preferences.json"), '{ "language": "ru" }');
    applyProcessLanguage({ COUNCIL_HOME: home });
    writeFileSync(join(home, "preferences.json"), '{ "language": "en" }');
    const r = await run([...scenarios(home), "--topic", "T", "--max-rounds", "3"], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("══ Итог: consensus");
  });
});

describe("council output and help in the selected language", () => {
  it("help: English without Cyrillic, both name the language source, no language flag", () => {
    setProcessLanguage("en");
    expect(help()).not.toMatch(CYR);
    expect(help()).toContain("Language: the COUNCIL_LANG variable (en or ru), then the language setting of the app (preferences.json of the data folder), by default English.");
    setProcessLanguage("ru");
    expect(help()).toContain("Язык: переменная COUNCIL_LANG (en или ru), затем настройка языка в приложении (preferences.json папки данных), по умолчанию English.");
    for (const l of ["en", "ru"] as const) expect(cliMessages(l).help).not.toMatch(/--lang|--language/);
  });

  it("argument failure in English: reason and help without Cyrillic", async () => {
    setProcessLanguage("en");
    const r = await run(["--topic", "T", "--max-tokens", "5", "--no-max-tokens"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toBe(`Error: the --max-tokens and --no-max-tokens flags are incompatible.\n\n${cliMessages("en").help}`);
  });

  it("discussion in English: status lines and result, participant replies as written", async () => {
    setProcessLanguage("en");
    const home = tmp();
    const r = await run([...scenarios(home), "--topic", "T", "--max-rounds", "3"], home);
    expect(r.code).toBe(EXIT.consensus);
    expect(r.out).toMatch(/^Session \S+ · participants: 2 · round limit: 3\nTopic: T\n/);
    expect(r.out).toContain("── Turn 1 · round 1 · p1 «Participant 1» · amend → version 1");
    expect(r.out).toContain("Usage: participants do not report tokens, accounting incomplete");
    expect(r.out).toContain("══ Outcome: consensus");
    expect(r.out).toContain("Decision:\nName it Max.");
    expect(r.out).not.toMatch(CYR);
    const id = readdirSync(join(home, "sessions"))[0]!;
    const show = await run(["show", id], home);
    expect(show.out).toContain("Status: consensus");
    expect(show.out).not.toMatch(CYR);
    const list = await run(["list"], home);
    expect(list.out).toContain(`${id}  `);
    expect(list.out).not.toMatch(CYR);
  });

  it("providers, templates, lineups in English", async () => {
    setProcessLanguage("en");
    const p = await run(["providers"]);
    expect([p.code, p.out]).toEqual([0, `No providers: the claude and codex CLIs were not found. Install a CLI or describe a provider in ${join(p.home, "config.json")}.`]);

    const home = tmp(), builtin = tmp();
    mkdirSync(join(builtin, "en"));
    copyFileSync(join(BUILTIN_TEMPLATES_DIR, "ru", "neutral.md"), join(builtin, "en", "neutral.md"));
    mkdirSync(join(home, "templates"));
    writeFileSync(join(home, "templates", "broken.json"), "{");
    const t = await run(["templates"], home, { builtinTemplatesDir: builtin });
    expect(t.out).toMatch(/^No templates\.\nLoad errors:\n {2}broken\.json \(user\): /);
    expect(t.out).not.toMatch(CYR);

    expect((await run(["lineups"], home)).out).toBe("No lineups.");
    const sHome = tmp();
    await run([...scenarios(sHome), "--topic", "T", "--max-rounds", "3"], sHome);
    const sid = readdirSync(join(sHome, "sessions"))[0]!;
    const saved = await run(["lineups", "save", "Pair", "--from-session", sid], sHome);
    expect(saved.code).toBe(0);
    expect(saved.out).toMatch(/^Lineup (\S+) «Pair» saved: participants 2\.\nStart: council --topic "<topic>" --lineup \1$/);
  });

  it("say in English: confirmation and core refusal", async () => {
    setProcessLanguage("en");
    const home = tmp(), ts = "2026-01-01T00:00:00.000Z";
    createSessionJournal(home, "s1");
    appendEvent(home, "s1", { seq: 1, ts, type: "session_created", pid: 1, session: {
      id: "s1", createdAt: ts, origin: "cli", topic: "T", templateId: null, framing: "",
      participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    } });
    openOwnerQueue(home, "s1");
    expect((await run(["say", "s1", "Short name"], home)).out).toBe("Message for session s1 requested: participants will see it from the next turn.");
    const bad = await run(["say", "nope", "x"], home);
    expect([bad.code, bad.err]).toEqual([2, storeMessages("en").sessionNotFound("nope")]);
  });

  it("materials preview in English: summary and prepared set", async () => {
    setProcessLanguage("en");
    const dir = tmp();
    writeFileSync(join(dir, "notes.md"), "hello");
    const r = await run(["--preview-materials", "--attach", join(dir, "notes.md")]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Materials: 1, size 5 characters \(limit \d+\)\./);
    expect(r.out).toMatch(/Prepared set: [0-9a-f]{32} \(valid for 24 hours; no model calls were made\)\nStart: council --topic "<topic>" --participant <participant> --participant <participant> --prepared-materials [0-9a-f]{32}$/);
  });
});

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMANDS: string[][] = [[], [], [], ["list"], ["home"], ["templates"], ["lineups"], ["lineups", "save", "x"], ["lineups", "save"], ["show", "nope"], ["stop", "nope"],
  ["say", "nope", "hi"], ["say", "nope"], ["status", "nope"], ["continue", "nope"], ["resume", "nope"], ["resume"], ["bogus"], ["providers"], ["providers", "x"], ["run"]];
const FLAGS: ((pick: <T>(xs: T[]) => T, parts: string[]) => string[])[] = [
  (pick) => ["--topic", pick(["T", "", " "])],
  (pick) => ["--topic", pick(["T", "T2"])],
  (_, parts) => parts,
  (_, parts) => parts.slice(0, 2),
  (pick) => ["--participant", pick(["scripted:/no/such.json", "scripted", "zz:m", "=", ""])],
  (pick) => ["--max-rounds", pick(["1", "3", "0", "x", ""])],
  (pick) => ["--rounds", pick(["2", "0"])],
  () => ["--replace", "p1=scripted:x"],
  () => ["--drafts"],
  () => ["--synthesizer", "p2"],
  (pick) => ["--max-tokens", pick(["10", "0", ""])],
  () => ["--no-max-tokens"],
  (pick) => ["--owner-wait-sec", pick(["5", "0", "90000"])],
  () => ["--pause-after-round"],
  (pick) => ["--lineup", pick(["", "l1"])],
  () => ["--preview-materials"],
  (pick) => ["--prepared-materials", pick(["", "abc"])],
  (pick) => ["--include", pick(["", "x"])],
  () => ["--no-ignore"],
  (pick) => ["--url", pick(["", "http://127.0.0.1/"])],
  (pick) => ["--attach", pick(["", "/no/such/path"])],
  () => ["--answer", "q1"],
  () => ["--unknown-flag"],
  () => ["--template", "nope"],
  () => ["--help"],
];

function gen(seed: number, parts: string[]): string[] {
  const rnd = mulberry32(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const argv = [...pick(COMMANDS)];
  const n = Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) argv.push(...pick(FLAGS)(pick, parts));
  return argv;
}

const sessionsOf = (home: string) => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")).length : 0);

describe("Exit codes, flags and machine-readable council output do not depend on the language", () => {
  it("200 generated argument sets: exit code and number of created sessions are equal for en and ru", async () => {
    const scen = tmp();
    const parts = scenarios(scen);
    const seen = new Set<number>();
    for (let seed = 1; seed <= 200; seed++) {
      const argv = gen(seed, parts);
      const got: Record<Language, { code: number; sessions: number }> = {} as never;
      for (const l of ["en", "ru"] as const) {
        setProcessLanguage(l);
        const r = await run(argv);
        got[l] = { code: r.code, sessions: sessionsOf(r.home) };
      }
      expect(got.en, `seed ${seed}: ${JSON.stringify(argv)}`).toEqual(got.ru);
      seen.add(got.en.code);
    }
    // the generator reaches both successful runs and argument refusals
    expect([...seen].sort()).toEqual(expect.arrayContaining([EXIT.consensus, EXIT.usage]));
  });
});
