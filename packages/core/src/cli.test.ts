import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync } from "node:fs";
import { afterAll, describe, it, expect } from "vitest";
import { EXIT, help, includePaths, main } from "./cli.ts";
import { cliMessages } from "./messages/cli.ts";
import type { CliIo } from "./cli.ts";
import type { CliLocation } from "./cli-agents/discovery.ts";
import { configPath, initialRegistry } from "./registry/config.ts";
import { createHash } from "node:crypto";
import { makeEncryptedPdf, makePdf } from "./pdf/fixture.ts";
import { createSession } from "./engine.ts";
import { createScriptedDriver, readScenario } from "./participants/scripted.ts";
import { resolveDataDir } from "./store/data-dir.ts";
import { runStoredSession } from "./store/run.ts";
import { planResume, runResumedSession } from "./store/resume.ts";
import { getProcessLanguage, setProcessLanguage } from "./i18n/process-language.ts";
import { listSessions } from "./store/sessions.ts";
import { appendEvent, createSessionJournal, eventsPath, materialPath, readEvents } from "./store/journal.ts";
import { openOwnerQueue, ownerMessagesDir } from "./store/owner-messages.ts";
import type { SessionEvent } from "./protocol/schema.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const sc = (dir: string, file: string) => join(import.meta.dirname, "../scenarios", dir, file);
const sp = (dir: string, file: string, name?: string) => `${name ? `${name}=` : ""}scripted:${sc(dir, file)}`;
const parts = (...ps: string[]) => ps.flatMap((p) => ["--participant", p]);
const base = ["--topic", "Как назвать кота"];

async function run(argv: string[], over: { env?: Record<string, string | undefined>; signal?: AbortSignal; onOut?: (l: string) => void; inspectDeps?: CliIo["inspectDeps"] } = {}) {
  const env = { COUNCIL_HOME: tmp(), ...(over.env ?? { COUNCIL_DEV: "1" }) };
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    stdout: (t) => { out.push(t); over.onOut?.(t); }, stderr: (t) => err.push(t),
    env, signal: over.signal,
    inspectDeps: { locate: async (agent) => ({ agent, found: false, searchPath: "", reason: `Команда ${agent} не найдена` }), ...over.inspectDeps },
  });
  return { code, out: out.join("\n"), err: err.join("\n"), outLines: out };
}

const two = (dir = "consensus") => parts(sp(dir, "p1.json"), sp(dir, "p2.json"));

describe("council cli", () => {
  it("1. consensus: turns in order, versions, result", async () => {
    const r = await run([...base, ...two(), "--max-rounds", "3"]);
    expect(r.code).toBe(0);
    const i = ["Ход 1", "Ход 2", "Ход 3"].map((s) => r.out.indexOf(s));
    expect(i.every((x) => x >= 0)).toBe(true);
    expect(i).toEqual([...i].sort((a, b) => a - b));
    expect(r.out).toContain(" → версия 1");
    expect(r.out).toContain(" → версия 2");
    expect(r.out).toContain("══ Итог: consensus");
    expect(r.out).toContain("Решение:\nНазвать кота Мурзик Великий.");
  });

  it("2. no-consensus: p1, p2 agree; p3 objects", async () => {
    const r = await run([...base, ...parts(sp("no-consensus", "p1.json"), sp("no-consensus", "p2.json"), sp("no-consensus", "p3.json")), "--max-rounds", "2"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("Согласны: p1, p2");
    expect(r.out).toContain("Возражают:\n  p3 «Участник 3»: По-прежнему нужно более редкое имя.");
  });

  it("3. dropout: two attempts by p2, dropout, consensus", async () => {
    const r = await run([...base, ...parts(sp("dropout", "p1.json"), sp("dropout", "p2.json"), sp("dropout", "p3.json")), "--max-rounds", "3"]);
    expect(r.code).toBe(0);
    const fails = r.outLines.filter((l) => l.startsWith("✗ Ход 2 · p2"));
    expect(fails).toHaveLength(2);
    expect(fails[0]).toContain("попытка 1");
    expect(fails[1]).toContain("попытка 2");
    expect(fails.join()).toContain("call_error");
    expect(r.out).toMatch(/✗ p2 «Участник 2» выбыл: /);
    expect(r.out).toContain("══ Итог: consensus");
  });

  it("4. dropout of two: failed", async () => {
    const r = await run([...base, ...parts(sp("dropout", "p1.json"), sp("dropout", "p2.json")), "--max-rounds", "3"]);
    expect(r.code).toBe(5);
    expect(r.out).toContain("══ Итог: failed");
    expect(r.out).toContain("Причина:");
  });

  it("5. question: normalized turn, question, answer", async () => {
    const r = await run([...base, ...two("question"), "--max-rounds", "3"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("object (agree с вопросами засчитано как object)");
    expect(r.out).toContain("q1 → p1");
    expect(r.out).toMatch(/Ход 3[^\n]*p1[^\n]*\nАргументы:[^\n]*\nОтветы:\n  q1: /);
    expect(r.out).toContain("══ Итог: consensus");
  });

  it("6. without COUNCIL_DEV: exit code 2", async () => {
    const r = await run([...base, ...two(), "--max-rounds", "3"], { env: {} });
    expect(r.code).toBe(2);
    expect(r.err).toContain("COUNCIL_DEV");
    expect(r.out).toBe("");
  });

  it("7. one participant", async () => {
    const r = await run([...base, ...parts(sp("consensus", "p1.json")), "--max-rounds", "3"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("не меньше 2");
    expect(r.err).toContain(help());
    expect(r.out).toBe("");
  });

  it("8. no topic or whitespace only", async () => {
    for (const argv of [[...two(), "--max-rounds", "3"], ["--topic", "   ", ...two(), "--max-rounds", "3"]]) {
      const r = await run(argv);
      expect(r.code).toBe(2);
      expect(r.err).toContain("Тема обязательна");
      expect(r.err).toContain(help());
    }
  });

  it("9. other argument errors", async () => {
    const cases = [
      [...base, "--max-rounds", "3"],
      [...base, ...two(), "--max-rounds", "0"],
      [...base, ...two(), "--max-rounds", "abc"],
      [...base, ...two(), "--max-rounds", "3", "--bogus"],
      [...base, ...parts(sp("consensus", "p1.json"), "openai:x"), "--max-rounds", "3"],
      [...base, ...parts(sp("consensus", "p1.json"), "scripted:/нет/такого.json"), "--max-rounds", "3"],
    ];
    for (const argv of cases) {
      const r = await run(argv);
      expect(r.code).toBe(2);
      expect(r.err).not.toBe("");
      expect(r.out).toBe("");
    }
  });

  it("10. --help", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    for (const s of ["consensus", "внутренняя ошибка", "ошибка аргументов", "no_consensus", "stopped", "failed", "COUNCIL_DEV"]) {
      expect(r.out).toContain(s);
    }
  });

  it("10a. help: token cap counts all model calls (change 104)", () => {
    const section = (l: "en" | "ru") => cliMessages(l).help.split("\n").filter((s) => /^(Token cap|Потолок токенов):/.test(s) || /--max-tokens <n>/.test(s)).join("\n");
    const en = section("en"), ru = section("ru");
    for (const re of [/model calls/, /failed attempts/, /file requests/, /drafts/]) expect(en).toMatch(re);
    for (const re of [/вызовов моделей/, /неудачные попытки/, /запросы файлов/, /черновики/]) expect(ru).toMatch(re);
    expect(en).not.toMatch(/all turns/);
    expect(ru).not.toMatch(/всех ходов/);
  });

  it("11. participant names", async () => {
    const r = await run([...base, ...parts(sp("consensus", "p1.json", "Аня"), sp("consensus", "p2.json")), "--max-rounds", "3"]);
    expect(r.out).toContain("p1 «Аня»");
    expect(r.out).toContain("«Участник 2»");
  });

  it("12. stop by signal", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const r = await run([...base, ...two("slow"), "--max-rounds", "3"], {
      signal: ac.signal, onOut: (l) => { if (l.includes("── Ход 1")) ac.abort(); },
    });
    expect(r.code).toBe(4);
    expect(r.out).toContain("══ Итог: stopped");
    expect(r.out).toContain("Решение:\nНазвать кота Тигра.");
    expect(Date.now() - t0).toBeLessThan(10000);
  });

  it("13. exit codes are distinct", () => {
    const v = Object.values(EXIT);
    expect(new Set(v).size).toBe(v.length);
  });
});

const entry = join(import.meta.dirname, "council.ts");

function spawnCouncil(dir: string, env: NodeJS.ProcessEnv, onOut?: (text: string, kill: () => void) => void) {
  const child = spawn(process.execPath, [entry, ...base, ...two(dir), "--max-rounds", "3"], { env: { ...env, COUNCIL_HOME: tmp() } });
  let stdout = "";
  child.stdout.on("data", (d) => { stdout += d; onOut?.(stdout, () => child.kill("SIGINT")); });
  return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

describe("council.ts entry point", () => {
  it("14. consensus, exit code 0", async () => {
    const r = await spawnCouncil("consensus", { ...process.env, COUNCIL_DEV: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("══ Итог: consensus");
  });

  it("15. SIGINT stops the session, exit code 4", async () => {
    let sent = false;
    const r = await spawnCouncil("slow", { ...process.env, COUNCIL_DEV: "1" }, (text, kill) => {
      if (!sent && text.includes("── Ход 1")) { sent = true; kill(); }
    });
    expect(r.code).toBe(4);
    expect(r.stdout).toContain("══ Итог: stopped");
  });

  it("16. without COUNCIL_DEV, exit code 2", async () => {
    const env = { ...process.env };
    delete env.COUNCIL_DEV;
    expect((await spawnCouncil("consensus", env)).code).toBe(2);
  });
});

const dev = (home: string, extra: Record<string, string> = {}) => ({ COUNCIL_DEV: "1", COUNCIL_HOME: home, ...extra });
const full = (extra: string[] = []) => [...base, ...two(), "--max-rounds", "3", ...extra];
const idOf = (out: string) => /^Сессия (\S+) ·/.exec(out)![1]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("storage and subcommands", () => {
  it("1. launch saves the session", async () => {
    const home = tmp();
    const r = await run(full(), { env: dev(home) });
    const id = idOf(r.out);
    const lines = readFileSync(join(home, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.at(-1).type).toBe("session_finished");
    expect(lines[0].type).toBe("session_created");
  });

  it("1a. --turn-timeout: 2147483 starts without turn_failed; 2147484, 0, 1.5, abc — exit code 2, help, no session (change 108)", async () => {
    const ok = tmp();
    const r = await run(full(["--turn-timeout", "2147483"]), { env: dev(ok) });
    expect(r.code).toBe(0);
    const evs = sessionEvents(ok);
    expect(evs.some((e: { type: string }) => e.type === "turn_failed")).toBe(false);
    expect(evs.find((e: { type: string }) => e.type === "session_created").session.limits.turnTimeoutSec).toBe(2147483);
    for (const v of ["2147484", "0", "1.5", "abc"]) {
      const home = tmp();
      const b = await run(full(["--turn-timeout", v]), { env: dev(home) });
      expect(b.code, v).toBe(2);
      expect(b.err, v).toContain(help());
      expect(b.out, v).toBe("");
      expect(existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : [], v).toEqual([]);
      if (v === "2147484") expect(b.err).toContain("2147483");
    }
  });

  it("2. list: fields, truncation, empty storage", async () => {
    const home = tmp();
    const empty = await run(["list"], { env: dev(home) });
    expect([empty.code, empty.out]).toEqual([0, "Сессий нет."]);
    const topic = "Очень длинная тема обсуждения ".repeat(4);
    const r = await run(["--topic", topic, ...two(), "--max-rounds", "3"], { env: dev(home) });
    const id = idOf(r.out);
    const l = await run(["list"], { env: dev(home) });
    const [lid, date, status, origin, ...t] = l.out.split("  ");
    expect([l.code, lid, status, origin]).toEqual([0, id, "consensus", "cli"]);
    expect(date).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(t.join("  ")).toBe(`${topic.slice(0, 60)}…`);
  });

  it("3. two sessions with one topic", async () => {
    const home = tmp();
    const a = idOf((await run(full(), { env: dev(home) })).out);
    const b = idOf((await run(full(), { env: dev(home) })).out);
    expect(a).not.toBe(b);
    expect(readdirSync(join(home, "sessions")).sort()).toEqual([a, b].sort());
    const l = (await run(["list"], { env: dev(home) })).out;
    expect(l).toContain(a);
    expect(l).toContain(b);
  });

  it("4. show of a finished session", async () => {
    const home = tmp();
    const id = idOf((await run(full(), { env: dev(home) })).out);
    const r = await run(["show", id], { env: dev(home) });
    expect(r.code).toBe(0);
    for (const s of ["Ход 1", "Статус: consensus", "══ Итог: consensus"]) expect(r.out).toContain(s);
  });

  it("5. show of an unknown session", async () => {
    const home = tmp();
    for (const id of ["nope", "../x"]) {
      const r = await run(["show", id], { env: dev(home) });
      expect(r.err).toContain("не найдена");
      expect(r.err).not.toContain(help());
      expect(r.out).toBe("");
      expect(r.code).toBe(2);
    }
  });

  it("6. stop of a finished session", async () => {
    const home = tmp();
    const id = idOf((await run(full(), { env: dev(home) })).out);
    const file = join(home, "sessions", id, "events.jsonl");
    const before = readFileSync(file);
    const r = await run(["stop", id], { env: dev(home) });
    expect(r.err).toContain("завершена");
    expect(r.code).toBe(2);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("7. stop from another process", async () => {
    const home = tmp();
    const child = spawn(process.execPath, [entry, ...base, ...two("slow"), "--max-rounds", "3"], { env: { ...process.env, ...dev(home) } });
    try {
      const closed = new Promise<number | null>((res) => child.on("close", res));
      let id = "";
      for (let i = 0; i < 100 && !id; i++) {
        id = listSessions(home).find((s) => s.status === "running")?.id ?? "";
        if (!id) await sleep(100);
      }
      expect(id).not.toBe("");
      const env = dev(home);
      expect((await run(["list"], { env })).out).toContain("  идёт  ");
      expect((await run(["show", id], { env })).out).toContain("Статус: идёт");
      expect((await run(["stop", id], { env })).code).toBe(0);
      const code = await Promise.race([closed, sleep(5000).then(() => "timeout" as const)]);
      expect(code).toBe(4);
      const last = readFileSync(join(home, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").at(-1)!;
      expect(JSON.parse(last)).toMatchObject({ type: "session_finished", status: "stopped" });
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("8. session of another component is visible", async () => {
    const home = tmp();
    const s = createSession(
      { topic: "Из MCP", framing: "", origin: "mcp", limits: { maxRounds: 3, turnTimeoutSec: 10, contextChars: 1000 },
        participants: [1, 2].map((n) => ({ name: `П${n}`, providerId: "scripted", model: "m", role: null })) },
      { maxParticipants: 8 },
    );
    const drivers = Object.fromEntries(await Promise.all(["p1.json", "p2.json"].map(async (f, i) =>
      [`p${i + 1}`, createScriptedDriver(await readScenario(sc("consensus", f)), { COUNCIL_DEV: "1" })] as const)));
    await runStoredSession({ session: s, drivers, dataDir: home });
    const r = await run(["list"], { env: dev(home) });
    expect(r.out).toContain(`${s.id}  `);
    expect(r.out).toContain("  mcp  Из MCP");
  });

  it("9. home does not create a folder", async () => {
    const home = join(tmp(), "нет-такой");
    const env = dev(home);
    const r = await run(["home"], { env });
    expect([r.code, r.out]).toEqual([0, resolveDataDir(env)]);
    expect(() => readdirSync(home)).toThrow();
  });

  it("10. unavailable data folder", async () => {
    const d = tmp();
    writeFileSync(join(d, "file.txt"), "x");
    const home = join(d, "file.txt", "data");
    const r = await run(["list"], { env: dev(home) });
    expect(r.code).toBe(1);
    expect(r.err).toContain(home);
    expect(r.err).not.toContain(help());
  });

  it("11. launch log without secrets and topic", async () => {
    const home = tmp();
    const r = await run(["--topic", "Секретная тема кота", ...two(), "--max-rounds", "3"], { env: dev(home, { FAKE_API_KEY: "sk-secret-123456" }) });
    const id = idOf(r.out);
    const log = readFileSync(join(home, "logs", "app.log"), "utf8");
    for (const s of ["Start: council run", `Session ${id} started`, `Session ${id} finished`, "Exit: code 0"]) expect(log).toContain(s);
    expect(log).not.toContain("sk-secret-123456");
    expect(log).not.toContain("Секретная тема");
  });

  it("12. argument error goes to the log", async () => {
    const home = tmp();
    const r = await run([...two(), "--max-rounds", "3"], { env: dev(home) });
    expect(r.code).toBe(2);
    expect(readFileSync(join(home, "logs", "app.log"), "utf8")).toContain("ERROR [cli] Argument error");
  });

  it("13. unknown subcommand and extra arguments", async () => {
    for (const argv of [["foo"], ["show"], ["stop"], ["list", "лишнее"], ["home", "x"], ["show", "a", "b"]]) {
      const r = await run(argv, { env: dev(tmp()) });
      expect(r.code).toBe(2);
      expect(r.err).toContain(help());
    }
    expect((await run(["foo"], { env: dev(tmp()) })).err).toContain("Неизвестная команда «foo».");
  });

  it("14. repeated launch does not change the previous journal", async () => {
    const home = tmp();
    const id = idOf((await run(full(), { env: dev(home) })).out);
    const file = join(home, "sessions", id, "events.jsonl");
    const before = readFileSync(file);
    await run(full(), { env: dev(home) });
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readdirSync(join(home, "sessions"))).toHaveLength(2);
  });
});

const FIX = join(import.meta.dirname, "cli-agents/fixtures");
const fixture = (n: string) => join(FIX, n);
const contract = (stance: string, solution: string | null) =>
  JSON.stringify({ stance, reasoning: "r", solution, answers: [], questions: [] });

/** CLI stub in its own folder; per turn: the first call is amend (claude), then agree. */
function cliStub(agent: "claude" | "codex", o: { help?: string } = {}) {
  const root = tmp();
  const helpFile = o.help ?? fixture(agent === "claude" ? "claude-2.1.288-help.txt" : "codex-0.159.2-exec-help.txt");
  const amend = agent === "claude"
    ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "t", structured_output: JSON.parse(contract("amend", "Назвать кота Барсик.")), usage: { input_tokens: 11, output_tokens: 3 }, total_cost_usd: 0.5 })
    : "";
  const agree = agent === "claude"
    ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "t", structured_output: JSON.parse(contract("agree", null)), usage: { input_tokens: 11, output_tokens: 3 }, total_cost_usd: 0.5 })
    : [{ type: "item.completed", item: { id: "i", type: "agent_message", text: contract("agree", null) } }, { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 7 } }].map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(root, "amend"), amend);
  writeFileSync(join(root, "agree"), agree);
  const path = join(root, agent);
  writeFileSync(path, `#!/bin/sh
D="$(dirname "$0")"
case "$1" in
  --version) echo '${agent === "claude" ? "2.1.288 (Claude Code)" : "codex-cli 0.159.2"}'; exit 0;;
  --help) /bin/cat '${helpFile}'; exit 0;;
  features) /bin/cat '${fixture("codex-0.159.2-features.txt")}'; exit 0;;
esac
if [ "$1" = exec ] && [ "$2" = --help ]; then /bin/cat '${helpFile}'; exit 0; fi
: > "$D/args"; for a in "$@"; do printf '%s\\n' "$a" >> "$D/args"; done
cat > "$D/stdin"
n=$(cat "$D/count" 2>/dev/null || echo 0); echo $((n+1)) > "$D/count"
if [ "$n" = 0 ] && [ -s "$D/amend" ]; then cat "$D/amend"; else cat "$D/agree"; fi
`);
  chmodSync(path, 0o755);
  const loc = (extra: Partial<CliLocation> = {}) => async (a: "claude" | "codex"): Promise<CliLocation> =>
    a === agent ? { agent, found: true, path, version: agent === "claude" ? "2.1.288" : "0.159.2", searchPath: process.env.PATH ?? "", ...extra } : { agent: a, found: false, searchPath: "", reason: `Команда ${a} не найдена` };
  return { root, path, loc, file: (n: string) => join(root, n) };
}
const both = (c: ReturnType<typeof cliStub>, x: ReturnType<typeof cliStub>, extra: Partial<CliLocation> = {}) => ({
  locate: async (a: "claude" | "codex") => (a === "claude" ? c : x).loc(extra)(a),
  listModels: async () => ({ models: ["opus", "sonnet"], confirmed: true }),
});
const sessionEvents = (home: string) => {
  const id = readdirSync(join(home, "sessions"))[0]!;
  return readFileSync(join(home, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
};
const writeConfig = (home: string, mut: (r: ReturnType<typeof initialRegistry>) => unknown) => {
  const r = initialRegistry(["claude", "codex"]);
  writeFileSync(configPath(home), JSON.stringify(mut(r) ?? r, null, 2));
};

describe("registry and CLI participants", () => {
  it("1. providers without CLI: empty config.json and the line 'No providers'", async () => {
    const home = tmp();
    const r = await run(["providers"], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`Провайдеров нет: CLI claude и codex не найдены. Установите CLI или опишите провайдера в ${configPath(home)}.`);
    expect(JSON.parse(readFileSync(configPath(home), "utf8")).providers).toEqual([]);
  });

  it("2. providers: both CLIs found", async () => {
    const home = tmp();
    const c = cliStub("claude");
    const x = cliStub("codex");
    const r = await run(["providers"], { env: dev(home), inspectDeps: both(c, x) });
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(configPath(home), "utf8")).providers.map((p: { id: string }) => p.id)).toEqual(["claude", "codex"]);
    expect(r.out).toContain(`claude  cli  доступен  версия 2.1.288  ${c.path}`);
    expect(r.out).toContain(`codex  cli  доступен  версия 0.159.2  ${x.path}`);
    expect(r.outLines.filter((l) => l.startsWith("  модели: default, opus, sonnet"))).toHaveLength(2);
  });

  it("3. providers: no --tools, unconfirmed list", async () => {
    const home = tmp();
    const help = join(tmp(), "help.txt");
    writeFileSync(help, readFileSync(fixture("claude-2.1.288-help.txt"), "utf8").split("\n").filter((l) => !l.includes("--tools")).join("\n"));
    const c = cliStub("claude", { help });
    const r = await run(["providers"], { env: dev(home), inspectDeps: {
      locate: c.loc(), listModels: async () => ({ models: [], confirmed: false, reason: "нет перечня" }),
    } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/claude  cli  недоступен: .*--tools/);
    expect(r.out).toContain("  перечень моделей не подтверждён: нет перечня");
    expect(r.out).toContain("  модели: default");
  });

  it("4. providers with an extra argument", async () => {
    const r = await run(["providers", "x"], { env: dev(tmp()) });
    expect(r.code).toBe(2);
    expect(r.err).toContain(help());
  });

  it("5. defaults from the registry and the participant limit", async () => {
    const home = tmp();
    writeConfig(home, (r) => ({ ...r, defaults: { ...r.defaults, maxRounds: 1 } }));
    const a = await run([...base, ...two()], { env: dev(home) });
    expect(a.out).toContain("лимит кругов: 1");
    const b = await run([...base, ...two(), "--max-rounds", "3"], { env: dev(home) });
    expect(b.out).toContain("лимит кругов: 3");
    writeConfig(home, (r) => ({ ...r, defaults: { ...r.defaults, maxParticipants: 2 } }));
    const c = await run([...base, ...parts(sp("consensus", "p1.json"), sp("consensus", "p2.json"), sp("consensus", "p1.json"))], { env: dev(home) });
    expect(c.code).toBe(2);
    expect(c.err).toMatch(/2/);
    expect(c.err).toContain("Ошибка:");
  });

  it("6. existing config.json is not changed", async () => {
    const home = tmp();
    writeConfig(home, () => undefined);
    const before = readFileSync(configPath(home));
    await run([...base, ...two()], { env: dev(home) });
    await run(["providers"], { env: dev(home) });
    expect(readFileSync(configPath(home)).equals(before)).toBe(true);
  });

  it("7. session with CLI participants on stubs", async () => {
    const home = tmp();
    const c = cliStub("claude");
    const x = cliStub("codex");
    const r = await run([...base, ...parts("claude:haiku", "Кодекс=codex"), "--max-rounds", "3"], { env: dev(home), inspectDeps: both(c, x) });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("══ Итог: consensus");
    const events = sessionEvents(home);
    const ps = events[0].session.participants;
    expect(ps.map((p: Record<string, unknown>) => [p.providerId, p.model, p.name])).toEqual([
      ["claude", "haiku", "Claude Code (haiku)"], ["codex", "default", "Кодекс"],
    ]);
    const usage = events.filter((e) => e.type === "turn_completed").map((e) => JSON.stringify(e));
    expect(usage.some((u) => u.includes("0.5") && u.includes("11"))).toBe(true);
    const args = readFileSync(c.file("args"), "utf8").split("\n");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
  });

  it("8. participants from the registry without --participant", async () => {
    const home = tmp();
    const c = cliStub("claude");
    const x = cliStub("codex");
    writeConfig(home, () => undefined);
    const r = await run([...base, "--max-rounds", "3"], { env: dev(home), inspectDeps: both(c, x) });
    expect(r.code).toBe(0);
    expect(sessionEvents(home)[0].session.participants.map((p: { providerId: string }) => p.providerId)).toEqual(["claude", "codex"]);
  });

  it("9. unavailable provider: no session is created", async () => {
    const home = tmp();
    const c = cliStub("claude");
    writeConfig(home, () => undefined);
    const r2 = await run([...base, ...parts("claude", "codex"), "--max-rounds", "3"], { env: dev(home), inspectDeps: { locate: async (a) => (a === "claude" ? c.loc()(a) : { agent: a, found: false, searchPath: "", reason: "Команда codex не найдена" }) } });
    expect(r2.code).toBe(2);
    expect(r2.err).toContain("«codex» недоступен: Команда codex не найдена");
    expect(r2.err).not.toContain(help());
    expect(existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []).toEqual([]);
  });

  it("10. unknown provider", async () => {
    const home = tmp();
    writeConfig(home, () => undefined);
    const r = await run([...base, ...parts("openai:x", "claude")], { env: dev(home) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Неизвестный провайдер «openai»: в реестре есть claude, codex;");
  });

  it("11. registry empty and no participants", async () => {
    const r = await run(base);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Участников взять неоткуда");
    expect(r.err).toContain(help());
  });

  it("12. broken config.json", async () => {
    const home = tmp();
    writeConfig(home, (r) => ({ ...r, defaults: { ...r.defaults, maxRounds: "5" } }));
    const s = await run([...base, ...two()], { env: dev(home) });
    expect(s.code).toBe(2);
    expect(s.err).toContain("defaults.maxRounds");
    expect(s.err).not.toContain(help());
    expect(existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []).toEqual([]);
    expect((await run(["providers"], { env: dev(home) })).code).toBe(2);
    expect((await run(["list"], { env: dev(home) })).code).toBe(0);
    expect((await run(["home"], { env: dev(home) })).code).toBe(0);
  });

  it("13. provider warning", async () => {
    const home = tmp();
    const c = cliStub("claude");
    const x = cliStub("codex");
    const r = await run([...base, ...parts("claude", "codex"), "--max-rounds", "3"], { env: dev(home), inspectDeps: both(c, x, { warning: "версия новее проверенной" }) });
    expect(r.code).toBe(0);
    expect(r.err).toContain("Предупреждение: провайдер «claude»: версия новее проверенной");
  });

  it("14. topic with special characters reaches stdin verbatim", async () => {
    const home = tmp();
    const mark = join(tmp(), "mark");
    const topic = `он сказал "да" и 'нет' $HOME $(touch ${mark})\nвторая строка`;
    const c = cliStub("claude");
    const x = cliStub("codex");
    const r = await run(["--topic", topic, ...parts("claude", "codex"), "--max-rounds", "3"], { env: dev(home), inspectDeps: both(c, x) });
    expect(r.code).toBe(0);
    expect(readFileSync(c.file("stdin"), "utf8")).toContain(topic);
    expect(existsSync(mark)).toBe(false);
  });

  it("15. --help describes providers and the participant entry", async () => {
    const r = await run(["--help"]);
    for (const s of ["council providers", "[имя=]<провайдер>[:<модель>]", "Аня=claude:haiku", "codex:<модель>", "config.json"]) expect(r.out).toContain(s);
  });

  it("16. --help mentions history-pins.json", async () => {
    const r = await run(["--help"]);
    expect(r.out).toContain("history-pins.json");
  });

  it("17. --help mentions the template editor", async () => {
    const r = await run(["--help"]);
    for (const s of ["редактор шаблона", "«Сохранить как шаблон»", "от 1 до 20"]) expect(r.out).toContain(s);
  });
});

describe("owner materials: --attach and --materials-chars", () => {
  const real = () => realpathSync(tmp());
  const argv = (...extra: string[]) => [...base, ...two(), "--max-rounds", "3", ...extra];
  const sessionDirs = (home: string) => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []);
  const filesUnder = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? filesUnder(f) : [f]; });
  const everything = (home: string, r: { out: string; err: string }) => {
    const log = join(home, "logs", "app.log");
    return [r.out, r.err, existsSync(log) ? readFileSync(log, "utf8") : "", ...(existsSync(join(home, "sessions")) ? filesUnder(join(home, "sessions")).map((f) => readFileSync(f, "utf8")) : [])].join("\n");
  };
  const created = (home: string) => sessionEvents(home)[0].session;

  it("1. file and folder: summary before the session id, metadata in the journal", async () => {
    const root = real();
    writeFileSync(join(root, "one.md"), "один");
    const dir = join(root, "docs");
    mkdirSync(join(dir, ".cache"), { recursive: true });
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "a.txt"), "альфа");
    writeFileSync(join(dir, "b.txt"), "бета!!");
    writeFileSync(join(dir, "bin.dat"), Buffer.from([65, 0, 66]));
    const home = tmp();
    const r = await run(argv("--attach", join(root, "one.md"), "--attach", dir), { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Материалы: 3, объём 15 символов (лимит 60000).");
    expect(r.out).toContain("Пропущено: 3");
    expect(r.out).toContain("  docs/.cache — скрытое имя");
    expect(r.out).toContain("  docs/node_modules — в списке игнорирования");
    expect(r.out).toContain("  docs/bin.dat — нетекстовый файл");
    expect(r.out.indexOf("Материалы:")).toBeLessThan(r.out.indexOf("Сессия "));
    const s = created(home);
    expect(s.origin).toBe("cli");
    expect(s.materials).toHaveLength(3);
    for (const m of s.materials) {
      expect(m.text).toBeUndefined();
      expect(Object.keys(m).sort()).toEqual(["chars", "id", "name", "sha256"]);
      expect(m.name).not.toContain(root);
    }
  });

  it("2. --materials-chars and the value from the registry", async () => {
    const root = real();
    writeFileSync(join(root, "x.txt"), "x");
    const h1 = tmp();
    expect((await run(argv("--attach", join(root, "x.txt"), "--materials-chars", "80000"), { env: dev(h1) })).code).toBe(0);
    expect(created(h1).limits.materialsChars).toBe(80000);
    const h2 = tmp();
    const r2 = await run(argv("--attach", join(root, "x.txt")), { env: dev(h2) });
    expect(created(h2).limits.materialsChars).toBe(60000);
    expect(r2.out).toContain("(лимит 60000)");
    const h3 = tmp();
    writeConfig(h3, (r) => { r.defaults.materialsChars = 1234; });
    const r3 = await run(argv("--attach", join(root, "x.txt")), { env: dev(h3) });
    expect(r3.out).toContain("(лимит 1234)");
    expect(created(h3).limits.materialsChars).toBe(1234);
  });

  it("3. limit exceeded: exit code 2, no session", async () => {
    const root = real();
    writeFileSync(join(root, "big.txt"), "12345");
    writeFileSync(join(root, "small.txt"), "12");
    const home = tmp();
    const r = await run(argv("--attach", join(root, "big.txt"), "--attach", join(root, "small.txt"), "--materials-chars", "1"), { env: dev(home) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Материалы не приняты:");
    for (const s of ["7", "лимит 1", "big.txt", "small.txt"]) expect(r.err).toContain(s);
    expect(r.err).not.toContain(help());
    expect(sessionDirs(home).filter((d) => existsSync(join(home, "sessions", d, "events.jsonl")))).toEqual([]);
  });

  it("4. invalid limit: reason and help, exit code 2", async () => {
    const root = real();
    writeFileSync(join(root, "x.txt"), "x");
    for (const v of ["0", "1.5", "abc", "9007199254740993"]) {
      const home = tmp();
      const r = await run(argv("--attach", join(root, "x.txt"), "--materials-chars", v), { env: dev(home) });
      expect(r.code, v).toBe(2);
      expect(r.err).toContain("--materials-chars: нужно целое число не меньше 1.");
      expect(r.err).toContain(help());
      expect(sessionDirs(home)).toEqual([]);
    }
  });

  it("5. empty --attach", async () => {
    for (const v of ["", "   "]) {
      const r = await run(argv("--attach", v));
      expect(r.code).toBe(2);
      expect(r.err).toContain("--attach: нужен путь к файлу или папке.");
      expect(r.err).toContain(help());
    }
  });

  it("6. refusals: paths, binary file, .env", async () => {
    const root = real();
    const miss1 = join(root, "нет1.txt");
    const miss2 = join(root, "нет2.txt");
    writeFileSync(join(root, "bin.dat"), Buffer.from([65, 0, 66]));
    const mark = "МАРКЕР-СЕКРЕТ-7731";
    writeFileSync(join(root, ".env.local"), `KEY=${mark}`);
    mkdirSync(join(root, "withenv"));
    writeFileSync(join(root, "withenv", ".env"), `KEY=${mark}`);
    writeFileSync(join(root, "withenv", "ok.txt"), "ок");
    const cases: { paths: string[]; names: string[] }[] = [
      { paths: [miss1], names: ["нет1.txt"] },
      { paths: [miss1, miss2], names: ["нет1.txt", "нет2.txt"] },
      { paths: [join(root, "bin.dat")], names: ["bin.dat"] },
      { paths: [join(root, ".env.local")], names: [".env.local"] },
    ];
    for (const c of cases) {
      const home = tmp();
      const r = await run(argv(...c.paths.flatMap((p) => ["--attach", p])), { env: dev(home) });
      expect(r.code, c.paths.join()).toBe(2);
      expect(r.err).toContain("Материалы не приняты:");
      for (const n of c.names) expect(r.err).toContain(n);
      expect(r.err).not.toContain(root);
      expect(everything(home, r)).not.toContain(root);
      expect(sessionDirs(home).filter((d) => existsSync(join(home, "sessions", d, "events.jsonl")))).toEqual([]);
      expect(everything(home, r)).not.toContain(mark);
    }
    // .env inside a folder — skipped, not refused: the start goes on, the secret is not read
    const home = tmp();
    const r = await run(argv("--attach", join(root, "withenv")), { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("  withenv/.env — файл окружения — защита секретов");
    expect(everything(home, r)).not.toContain(mark);
  });

  it("7. material text does not reach stdout, stderr or the log", async () => {
    const root = real();
    const mark = "УНИКАЛЬНЫЙ-МАРКЕР-5520";
    writeFileSync(join(root, "m.txt"), `текст ${mark}`);
    const home = tmp();
    const r = await run(argv("--attach", join(root, "m.txt")), { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain(mark);
    expect(readFileSync(join(home, "logs", "app.log"), "utf8")).not.toContain(mark);
  });

  it("8. empty folder: not an error, no materials key", async () => {
    const root = real();
    mkdirSync(join(root, "empty"));
    const home = tmp();
    const r = await run(argv("--attach", join(root, "empty")), { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Материалы: 0, объём 0 символов (лимит 60000).");
    expect("materials" in created(home)).toBe(false);
  });

  it("9. relative path is counted from the current folder", async () => {
    const root = real();
    writeFileSync(join(root, "rel.txt"), "относительный");
    const prev = process.cwd();
    process.chdir(root);
    try {
      const r = await run(argv("--attach", "rel.txt"));
      expect(r.code).toBe(0);
      expect(r.out).toContain("Материалы: 1, объём 13 символов");
    } finally {
      process.chdir(prev);
    }
  });

  it("10. without new flags: no 'Materials:' line, journal as before", async () => {
    const home = tmp();
    const r = await run(argv(), { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Материалы:");
    const s = created(home);
    expect(s.origin).toBe("cli");
    expect("materials" in s).toBe(false);
  });

  it("12. PDF: text layer in the attachment, snapshot equals the text; encrypted — exit code 2; help", async () => {
    const root = real();
    const text = "Первая страница\n\nВторая страница";
    writeFileSync(join(root, "a.pdf"), makePdf(["Первая страница", "Вторая страница"]));
    writeFileSync(join(root, "enc.pdf"), makeEncryptedPdf());
    const home = tmp();
    const r = await run(argv("--attach", join(root, "a.pdf")), { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Материалы: 1, объём ${text.length} символов`);
    expect(readFileSync(materialPath(home, created(home).id, "m1"), "utf8")).toBe(text);
    const h2 = tmp();
    const bad = await run(argv("--attach", join(root, "enc.pdf")), { env: dev(h2) });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("Материалы не приняты:");
    expect(bad.err).toContain("PDF зашифрован");
    const help = await run(["--help"]);
    expect(help.out).toContain("Из PDF берётся текстовый слой (на файл не больше 100 МиБ, 2000 страниц, 30 секунд, 512 МиБ памяти и 20000000 знаков)");
  }, 30_000);

  it("11. --help describes the flags", async () => {
    const r = await run(["--help"]);
    for (const s of ["--attach", "--materials-chars", "отказ материалов"]) expect(r.out).toContain(s);
  });
});

describe("council say: owner message", () => {
  const ts = "2026-01-01T00:00:00.000Z";
  const session = (id: string) => ({
    id, createdAt: ts, origin: "cli" as const, topic: "Тема", templateId: null, framing: "",
    participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  });
  const turn = (n: number, seq: number): SessionEvent => ({
    seq, ts, type: "turn_completed", turn: n, round: 1, participantId: `p${n}`, stance: "agree", normalized: false,
    reasoning: `аргумент ${n}`, solution: null, version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
  });
  const finished = (seq: number): SessionEvent => ({ seq, ts, type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [] });
  const make = (home: string, id: string, events: SessionEvent[], pid = 1) => {
    createSessionJournal(home, id);
    appendEvent(home, id, { seq: 1, ts, type: "session_created", session: session(id), pid });
    for (const e of events) appendEvent(home, id, e);
  };
  const running = (home: string, id = "s1") => { make(home, id, []); openOwnerQueue(home, id); return id; };
  const requests = (home: string, id: string) => readdirSync(ownerMessagesDir(home, id)).filter((f) => f.endsWith(".json"));
  const textOf = (home: string, id: string) => requests(home, id).map((f) => JSON.parse(readFileSync(join(ownerMessagesDir(home, id), f), "utf8")).text);

  it("success: confirmation and one request file", async () => {
    const home = tmp();
    const id = running(home);
    const r = await run(["say", id, "Имя короткое"], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).toBe(`Реплика для сессии ${id} запрошена: участники увидят её со следующего хода.`);
    expect(r.err).toBe("");
    expect(textOf(home, id)).toEqual(["Имя короткое"]);
  });

  it("the text is passed verbatim, including a dash after --", async () => {
    const home = tmp();
    const id = running(home);
    const multi = "строка  с  пробелами\nвторая строка";
    expect((await run(["say", id, multi], { env: dev(home) })).code).toBe(0);
    expect((await run(["say", id, "--", "-минус в начале"], { env: dev(home) })).code).toBe(0);
    expect(textOf(home, id).sort()).toEqual([multi, "-минус в начале"].sort());
  });

  it("no text or two texts: reason and help, exit code 2", async () => {
    const home = tmp();
    const id = running(home);
    for (const argv of [["say"], ["say", id], ["say", id, "a", "b"]]) {
      const r = await run(argv, { env: dev(home) });
      expect(r.code).toBe(2);
      expect(r.err).toContain("Команда say принимает два аргумента: <id> и <текст>.");
      expect(r.err).toContain(help());
    }
    expect(requests(home, id)).toEqual([]);
  });

  it("empty text: no help, exit code 2", async () => {
    const home = tmp();
    const id = running(home);
    const r = await run(["say", id, "  \n "], { env: dev(home) });
    expect(r.code).toBe(2);
    expect(r.err).toBe("Реплика должна быть непустой.");
    expect(r.err).not.toContain(help());
    expect(requests(home, id)).toEqual([]);
  });

  it("finished, interrupted and unknown sessions reject the message", async () => {
    const home = tmp();
    make(home, "fin", [turn(1, 2), finished(3)]);
    const fin = readFileSync(eventsPath(home, "fin"));
    const rf = await run(["say", "fin", "текст"], { env: dev(home) });
    expect([rf.code, rf.err]).toEqual([2, "Сессия fin уже завершена: consensus."]);
    expect(readFileSync(eventsPath(home, "fin")).equals(fin)).toBe(true);

    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((res) => child.once("exit", res));
    make(home, "dead", [turn(1, 2)], child.pid!);
    const dead = readFileSync(eventsPath(home, "dead"));
    const rd = await run(["say", "dead", "текст"], { env: dev(home) });
    expect(rd.code).toBe(2);
    expect(rd.err).toContain("исполнитель не работает");
    expect(readFileSync(eventsPath(home, "dead")).equals(dead)).toBe(true);
    expect(existsSync(ownerMessagesDir(home, "dead"))).toBe(false);

    const ru = await run(["say", "нет-такой", "текст"], { env: dev(home) });
    expect(ru.code).toBe(2);
    expect(ru.err).toContain("не найдена");
    expect(ru.err).not.toContain(help());
    expect(existsSync(join(home, "sessions", "нет-такой"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("сбой записи: код 1, причина в stderr, без подтверждения", async () => {
    const home = tmp();
    const id = running(home);
    const dir = ownerMessagesDir(home, id);
    chmodSync(dir, 0o555);
    try {
      const r = await run(["say", id, "текст"], { env: dev(home) });
      expect(r.code).toBe(EXIT.internal);
      expect(r.err).toContain("Ошибка: не удалось записать реплику — ");
      expect(r.out).toBe("");
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("does not create config.json", async () => {
    const home = tmp();
    const id = running(home);
    expect((await run(["say", id, "текст"], { env: dev(home) })).code).toBe(0);
    expect(existsSync(configPath(home))).toBe(false);
  });

  it("show prints the message in chronological order", async () => {
    const home = tmp();
    const text = "Имя должно быть коротким,\nдо пяти букв";
    make(home, "sh", [
      turn(1, 2), turn(2, 3),
      { seq: 4, ts, type: "owner_message", id: "o1", text, afterTurn: 2, requestId: "r1" },
      turn(3, 5), finished(6),
    ]);
    const r = await run(["show", "sh"], { env: dev(home) });
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    const at = (s: string) => lines.findIndex((l) => l.includes(s));
    const remark = lines.indexOf("── Владелец · o1 · после хода 2");
    expect(remark).toBeGreaterThan(-1);
    expect(remark).toBeGreaterThan(at("── Ход 2"));
    expect(remark).toBeLessThan(at("── Ход 3"));
    expect(r.out).toContain(`── Владелец · o1 · после хода 2\n${text}`);
    expect(r.out).toContain("Статус: consensus");
  });

  describe("show: owner choice", () => {
    const amend = (n: number, seq: number, v: number): SessionEvent => ({ ...turn(n, seq), stance: "amend", solution: `Текст версии ${v}\nвторая строка`, version: v } as SessionEvent);
    const object = (n: number, seq: number, v: number): SessionEvent => ({ ...turn(n, seq), stance: "object", version: v, reasoning: `возражение ${n}` } as SessionEvent);
    const noCons = (seq: number): SessionEvent => ({ seq, ts, type: "session_finished", status: "no_consensus", version: 3, agreed: ["p1"], objectors: [{ participantId: "p2", reasoning: "не согласен с третьей" }] } as SessionEvent);
    const pick = (seq: number, note?: string): SessionEvent => ({ seq, ts: "2026-02-02T10:00:00.000Z", type: "owner_selected_version", version: 1, statusAtSelection: "no_consensus", ...(note ? { note } : {}) } as SessionEvent);
    const base3 = [amend(1, 2, 1), amend(2, 3, 2), amend(1, 4, 3), object(2, 5, 3), noCons(6)];
    const show = async (events: SessionEvent[]) => {
      const home = tmp();
      make(home, "ow", events);
      const r = await run(["show", "ow"], { env: dev(home) });
      return { r, lines: r.out.split("\n"), home };
    };

    it("choice block: original result, the block before 'Total:', full text of the version", async () => {
      const { r, lines } = await show([...base3, pick(7, "Первая версия проще")]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Статус: no_consensus");
      expect(r.out).toContain("Версия 3, автор");
      expect(r.out).toContain("не согласен с третьей");
      const at = (s: string) => lines.findIndex((l) => l.startsWith(s));
      const ev = at("── Владелец выбрал версию 1 · исход на момент выбора: no_consensus");
      expect(ev).toBeGreaterThan(-1);
      expect(ev).toBeLessThan(at("Статус:"));
      expect(ev).toBeGreaterThan(lines.map((l, i) => (l.startsWith("── Ход") ? i : -1)).reduce((a, b) => Math.max(a, b)));
      const blk = at("══ Выбор владельца: версия 1 (не согласие моделей)");
      expect(blk).toBeGreaterThan(at("Решение:"));
      expect(lines.slice(blk, blk + 6)).toEqual([
        "══ Выбор владельца: версия 1 (не согласие моделей)",
        "Выбрано: 2026-02-02T10:00:00.000Z, исход на момент выбора: no_consensus",
        "Заметка: Первая версия проще",
        "Текст версии 1:",
        "Текст версии 1",
        "вторая строка",
      ]);
      expect(blk).toBeLessThan(at("Всего:"));
    });

    it("without a choice the output is a subsequence of the output with a choice", async () => {
      const without = (await show(base3)).r.out;
      const withSel = (await show([...base3, pick(7, "н")])).r.out;
      expect(without).not.toContain("Выбор владельца");
      const w = withSel.split("\n");
      let i = 0;
      for (const l of without.split("\n")) { while (i < w.length && w[i] !== l) i++; expect(i).toBeLessThan(w.length); i++; }
    });

    it("show does not change the journal", async () => {
      const { home } = await show([...base3, pick(7)]);
      const before = readFileSync(eventsPath(home, "ow"), "utf8");
      await run(["show", "ow"], { env: dev(home) });
      expect(readFileSync(eventsPath(home, "ow"), "utf8")).toBe(before);
    });

    it("without a note there are no 'Note:' lines", async () => {
      expect((await show([...base3, pick(7)])).r.out).not.toContain("Заметка:");
    });

    it("after a choice, continuation to a new result: the block stays, the outcome is the same, status is current", async () => {
      const resumed = { seq: 8, ts, type: "session_resumed", pid: 1, maxRounds: 5 } as SessionEvent;
      const { r } = await show([...base3, pick(7), resumed, turn(1, 9), finished(10)]);
      expect(r.out).toContain("══ Выбор владельца: версия 1 (не согласие моделей)");
      expect(r.out).toContain("Выбрано: 2026-02-02T10:00:00.000Z, исход на момент выбора: no_consensus");
      expect(r.out).toContain("Статус: consensus");
    });
  });

  it("--help mentions the owner choice in show", async () => {
    expect((await run(["--help"])).out).toContain("show <id>  ход и состояние сессии; выбор владельца");
  });

  it("--help mentions say", async () => {
    expect((await run(["--help"])).out).toContain("council say <id> [--answer <qN>] <текст>");
  });
});

describe("council say --answer: questions to the owner", () => {
  const ts = "2026-01-01T00:00:00.000Z";
  const session = (id: string) => ({
    id, createdAt: ts, origin: "cli" as const, topic: "Тема", templateId: null, framing: "",
    participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  });
  const asked = (to: string): SessionEvent => ({
    seq: 2, ts, type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "agree", normalized: false,
    reasoning: "аргумент", solution: null, version: 1, questions: [{ id: "q1", to, text: "Таблица или текст?" }], answers: [],
    attempts: 1, usage: {}, durationMs: 1,
  });
  const closed = (seq: number, reason: "answered" | "unanswered"): SessionEvent => ({ seq, ts, type: "question_closed", questionId: "q1", reason });
  const make = (home: string, id: string, events: SessionEvent[]) => {
    createSessionJournal(home, id);
    appendEvent(home, id, { seq: 1, ts, type: "session_created", session: session(id), pid: 1 });
    for (const e of events) appendEvent(home, id, e);
    openOwnerQueue(home, id);
    return id;
  };
  const requests = (home: string, id: string) => readdirSync(ownerMessagesDir(home, id)).filter((f) => f.endsWith(".json"));
  const OK = (id: string) => `Ответ на вопрос q1 для сессии ${id} запрошен: участники увидят его со следующего хода.`;

  it("success: confirmation, one request file with questionId, journal unchanged", async () => {
    const home = tmp();
    const id = make(home, "s1", [asked("owner")]);
    const before = readFileSync(eventsPath(home, id));
    const r = await run(["say", id, "--answer", "q1", "Формат — таблица"], { env: dev(home) });
    expect([r.code, r.out, r.err]).toEqual([0, OK(id), ""]);
    const files = requests(home, id);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(ownerMessagesDir(home, id), files[0]!), "utf8"))).toMatchObject({ questionId: "q1", text: "Формат — таблица" });
    expect(readFileSync(eventsPath(home, id)).equals(before)).toBe(true);
  });

  it("the flag can be given after the text", async () => {
    const home = tmp();
    const id = make(home, "s1", [asked("owner")]);
    const r = await run(["say", id, "Таблица", "--answer", "q1"], { env: dev(home) });
    expect([r.code, r.out]).toEqual([0, OK(id)]);
  });

  it("refusals: exact reason without help, exit code 2, no request and no journal changes", async () => {
    const cases: [string, SessionEvent[], string, string][] = [
      ["unknown", [asked("owner")], "q9", "Вопрос q9 не найден."],
      ["toparticipant", [asked("p2")], "q1", "Вопрос q1 не адресован владельцу."],
      ["answered", [asked("owner"), closed(3, "answered")], "q1", "Вопрос q1 уже закрыт: отвечен."],
      ["unanswered", [asked("owner"), closed(3, "unanswered")], "q1", "Вопрос q1 уже закрыт: остался без ответа."],
    ];
    for (const [name, events, q, reason] of cases) {
      const home = tmp();
      const id = make(home, name, events);
      const before = readFileSync(eventsPath(home, id));
      const r = await run(["say", id, "--answer", q, "текст"], { env: dev(home) });
      expect([r.code, r.err]).toEqual([2, reason]);
      expect(r.err).not.toContain(help());
      expect(requests(home, id)).toEqual([]);
      expect(readFileSync(eventsPath(home, id)).equals(before)).toBe(true);
    }
  });

  it("--answer without a value: reason and help, exit code 2, no request", async () => {
    const home = tmp();
    const id = make(home, "s1", [asked("owner")]);
    const r = await run(["say", id, "текст", "--answer"], { env: dev(home) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--answer");
    expect(r.err).toContain(help());
    expect(requests(home, id)).toEqual([]);
  });

  it("--answer with another command: exit code 2 and the say text", async () => {
    const home = tmp();
    const id = make(home, "s1", [asked("owner")]);
    const r = await run(["show", id, "--answer", "q1"], { env: dev(home) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Флаг --answer относится только к команде say.");
  });

  it("a finished session rejects the answer, journal unchanged", async () => {
    const home = tmp();
    const id = make(home, "fin", [asked("owner"), { seq: 3, ts, type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [] }]);
    const before = readFileSync(eventsPath(home, id));
    const r = await run(["say", id, "--answer", "q1", "текст"], { env: dev(home) });
    expect([r.code, r.err]).toEqual([2, "Сессия fin уже завершена: consensus."]);
    expect(readFileSync(eventsPath(home, id)).equals(before)).toBe(true);
  });

  it("say without --answer: the previous confirmation", async () => {
    const home = tmp();
    const id = make(home, "s1", [asked("owner")]);
    const r = await run(["say", id, "Просто реплика"], { env: dev(home) });
    expect([r.code, r.out]).toEqual([0, `Реплика для сессии ${id} запрошена: участники увидят её со следующего хода.`]);
  });

  it("--help describes --answer and questions to the owner", async () => {
    const r = await run(["--help"]);
    expect(r.out).toContain("--answer <qN>");
    expect(r.out).toContain("Вопросы владельцу: участник может адресовать вопрос владельцу");
  });

  it("print: question to the owner with a hint, closed without an answer before turn 3; show — without a hint", async () => {
    const home = tmp();
    const r = await run([...base, ...parts(sp("owner-questions", "silent-p1.json"), sp("owner-questions", "silent-p2.json")), "--max-rounds", "3"], { env: dev(home) });
    expect(r.code).toBe(0);
    const id = idOf(r.out);
    const q = r.outLines.findIndex((l) => l.startsWith("Вопрос владельцу · q1 · p1 «Участник 1»: "));
    expect(q).toBeGreaterThan(-1);
    expect(r.outLines[q + 1]).toBe(`  ответить: council say ${id} --answer q1 "<текст>"`);
    const close = r.outLines.indexOf("  вопрос q1 остался без ответа");
    expect(close).toBeGreaterThan(q);
    expect(close).toBeLessThan(r.outLines.findIndex((l) => l.startsWith("── Ход 3")));
    expect(r.out).not.toContain("Вопросы:");

    const s = await run(["show", id], { env: dev(home) });
    expect(s.code).toBe(0);
    expect(s.out).toContain("Вопрос владельцу · q1 · p1 «Участник 1»: В каком формате нужен отчёт: таблица или текст?");
    expect(s.out).not.toContain("ответить:");
    expect(s.out.indexOf("вопрос q1 остался без ответа")).toBeLessThan(s.out.indexOf("── Ход 3"));
    expect(s.out).toContain("══ Итог: consensus");
  });

  it("dropout: question closed without an answer before the dropout line, session reaches the result", async () => {
    const r = await run([...base, ...parts(sp("owner-questions", "dropout-p1.json"), sp("owner-questions", "dropout-p2.json"), sp("owner-questions", "dropout-p3.json")), "--max-rounds", "3"]);
    expect(r.code).toBe(0);
    const closeAt = r.out.indexOf("вопрос q1 остался без ответа");
    expect(closeAt).toBeGreaterThan(-1);
    expect(closeAt).toBeLessThan(r.out.indexOf("p2 «Участник 2» выбыл"));
    expect(r.out).toContain("══ Итог: consensus");
  });

  it("answer during a turn: applied after turn 2, turns 3 and 4 give consensus", { timeout: 40_000 }, async () => {
    const home = tmp();
    const child = spawn(process.execPath, [entry, ...base, ...parts(sp("owner-questions", "answer-p1.json"), sp("owner-questions", "answer-p2.json")), "--max-rounds", "3"], { env: { ...process.env, ...dev(home) } });
    try {
      let stdout = "";
      child.stdout.on("data", (c) => { stdout += c; });
      const closedP = new Promise<number | null>((res) => child.on("close", res));
      let id = "";
      for (let i = 0; i < 100 && !id; i++) {
        const cand = listSessions(home).find((s) => s.status === "running")?.id ?? "";
        const events = cand ? readEvents(home, cand)?.events ?? [] : [];
        if (events.some((e) => e.type === "turn_started" && e.turn === 2)) id = cand;
        else await sleep(100);
      }
      expect(id).not.toBe("");
      expect(readEvents(home, id)?.events.at(-1)).toMatchObject({ type: "turn_started", turn: 2 });
      const r = await run(["say", id, "--answer", "q1", "Формат — таблица"], { env: dev(home) });
      expect([r.code, r.out]).toEqual([0, OK(id)]);
      expect(await Promise.race([closedP, sleep(30_000).then(() => "timeout" as const)])).toBe(0);
      const header = "── Владелец · o1 · после хода 2 · ответ на q1";
      for (const out of [stdout, (await run(["show", id], { env: dev(home) })).out]) {
        const at = (s: string) => out.indexOf(s);
        expect(at(header)).toBeGreaterThan(at("── Ход 2"));
        expect(at(header)).toBeLessThan(at("── Ход 3"));
        expect(at("── Ход 3")).toBeLessThan(at("── Ход 4"));
        expect(out).toContain("══ Итог: consensus");
      }
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("council resume", () => {
  const twoR = () => parts(sp("resume", "p1.json"), sp("resume", "p2.json"));
  const seed = async (home: string, maxRounds = 2, ps = twoR()) => {
    const r = await run([...base, ...ps, "--max-rounds", String(maxRounds)], { env: dev(home) });
    return { id: idOf(r.out), r };
  };
  const bytes = (home: string, id: string) => readFileSync(eventsPath(home, id));
  const resume = (home: string, ...a: string[]) => run(["resume", ...a], { env: dev(home) });
  const lineOf = (out: string, start: string) => out.split("\n").find((l) => l.startsWith(start));

  it("1. --rounds 2: same id, agreement, turn numbers continue, show with the full history", async () => {
    const home = tmp();
    const { id, r: first } = await seed(home);
    expect(first.code).toBe(3);
    const r = await resume(home, id, "--rounds", "2");
    expect(r.code).toBe(0);
    expect(lineOf(r.out, "Продолжение сессии")).toBe(`Продолжение сессии ${id}: ещё кругов 2 (общий лимит 4), не более 12 вызовов моделей (активных участников 2 × 2 × 3).`);
    expect(r.out.indexOf("Продолжение сессии")).toBeLessThan(r.out.indexOf("— Продолжено: общий лимит кругов 4 —"));
    expect(r.out).toContain("── Ход 5 · круг 3 · p1");
    expect(r.out).toContain("── Ход 6 · круг 3 · p2");
    expect(r.out).not.toContain("── Ход 4 ");
    expect(r.out).toContain("══ Итог: consensus");
    expect(r.out).toContain("Решение:\nНазвать кота Мурзик.");
    expect(listSessions(home).map((x) => x.id)).toEqual([id]);
    const sh = await run(["show", id], { env: dev(home) });
    for (const x of ["── Ход 1 ", "── Ход 4 ", "— Продолжено: общий лимит кругов 4 —", "── Ход 6 ", "Статус: consensus"]) expect(sh.out).toContain(x);
    expect(sh.outLines.at(-1)).toMatch(/^Всего: ходов 6, длительность \d+\.\d с(, стоимость \$0\.0000)?$/);
    expect(sh.out.indexOf("Ход 4")).toBeLessThan(sh.out.indexOf("Продолжено"));
    const l = await run(["list"], { env: dev(home) });
    expect(l.out).toContain(`${id}  `);
    expect(l.out).toContain("  consensus  ");
  });

  it("2. without --rounds: remainder with an unfinished round, limit 18", async () => {
    const home = tmp();
    const ac = new AbortController();
    const first = await run([...base, ...twoR(), "--max-rounds", "4"], { env: dev(home), signal: ac.signal, onOut: (l) => { if (l.includes("── Ход 2")) ac.abort(); } });
    expect(first.code).toBe(4);
    const id = idOf(first.out);
    const r = await resume(home, id);
    expect(lineOf(r.out, "Продолжение сессии")).toBe(`Продолжение сессии ${id}: ещё кругов 3 (общий лимит 4), не более 18 вызовов моделей (активных участников 2 × 3 × 3).`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("── Ход 3 · круг 2 · p1");
  });

  it("3. limit 12: three participants, one dropped out, two rounds", async () => {
    const home = tmp();
    const { id, r: first } = await seed(home, 1, parts(sp("resume", "p1.json"), sp("dropout", "p2.json"), sp("resume", "p2.json")));
    expect(first.out).toMatch(/✗ p2 «Участник 2» выбыл: /);
    expect(first.code).toBe(3);
    const r = await resume(home, id, "--rounds", "2");
    expect(lineOf(r.out, "Продолжение сессии")).toBe(`Продолжение сессии ${id}: ещё кругов 2 (общий лимит 3), не более 12 вызовов моделей (активных участников 2 × 2 × 3).`);
  });

  it("4. invalid arguments: exit code 2, help, journal unchanged", async () => {
    const home = tmp();
    const { id } = await seed(home);
    const before = bytes(home, id);
    const cases: [string[], string][] = [
      [["resume"], "ровно один аргумент"],
      [["resume", id, "лишний"], "ровно один аргумент"],
      [["resume", id, "--rounds", "0"], "--rounds"],
      [["resume", id, "--rounds", "abc"], "--rounds"],
      [["resume", id, "--topic", "x"], "флаг --topic не принимается"],
      [["resume", id, "--participant", "claude"], "флаг --participant не принимается"],
      [["resume", id, "--max-rounds", "3"], "флаг --max-rounds не принимается"],
      [["resume", id, "--template", "x"], "флаг --template не принимается"],
      [["resume", id, "--attach", "x"], "флаг --attach не принимается"],
      [["show", id, "--rounds", "1"], "--rounds принимается только командой resume"],
    ];
    for (const [argv, why] of cases) {
      const r = await run(argv, { env: dev(home) });
      expect([r.code, argv]).toEqual([2, argv]);
      expect(r.err).toContain(why);
      expect(r.err).toContain(help());
      expect(r.out).toBe("");
    }
    expect(bytes(home, id).equals(before)).toBe(true);
  });

  it("5. refusals: exit code 2 without help, no events", async () => {
    const home = tmp();
    const reject = async (id: string, why: string, ...extra: string[]) => {
      const before = existsSync(eventsPath(home, id)) ? bytes(home, id) : null;
      const r = await resume(home, id, ...extra);
      expect([r.code, id]).toEqual([2, id]);
      expect(r.err).toContain(`Ошибка: `);
      expect(r.err).toContain(why);
      expect(r.err).not.toContain(help());
      expect(r.out).toBe("");
      if (before) expect(bytes(home, id).equals(before)).toBe(true);
    };
    await reject("no-such-session", "не найдена");
    const done = idOf((await run(full(), { env: dev(home) })).out);
    await reject(done, "согласие достигнуто");
    const { id: lim } = await seed(home);
    await reject(lim, "--rounds");

    writeConfig(home, () => undefined);
    const s = createSession({
      topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 20000 },
      participants: ["claude", "codex"].map((p) => ({ name: p, providerId: p, model: "default", role: null })),
    }, { maxParticipants: 8 });
    const stepR = (stance: string, solution: string | null) => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });
    await runStoredSession({
      session: s, dataDir: home,
      drivers: { p1: createScriptedDriver({ steps: [stepR("amend", "v1")] }, { COUNCIL_DEV: "1" }), p2: createScriptedDriver({ steps: [stepR("object", null)] }, { COUNCIL_DEV: "1" }) },
    });
    await reject(s.id, "недоступен", "--rounds", "1");

    const text = "Текст материала";
    const m = { id: "m1", name: "заметка.txt", chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex"), text };
    const sm = createSession({
      topic: "Тема", framing: "", origin: "cli", materials: [m],
      limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 20000, materialsChars: 1000 },
      participants: [1, 2].map((n) => ({ name: `П${n}`, providerId: "scripted", model: sc("resume", `p${n}.json`), role: null })),
    }, { maxParticipants: 8 });
    await runStoredSession({
      session: sm, dataDir: home, materials: [m],
      drivers: { p1: createScriptedDriver({ steps: [stepR("amend", "v1")] }, { COUNCIL_DEV: "1" }), p2: createScriptedDriver({ steps: [stepR("object", null)] }, { COUNCIL_DEV: "1" }) },
    });
    rmSync(materialPath(home, sm.id, "m1"));
    await reject(sm.id, "Материал «заметка.txt»", "--rounds", "1");
  });

  describe("hints to the owner in a continued session", () => {
    const hints = () => parts(sp("resume-hints", "p1.json"), sp("resume-hints", "p2.json"));

    it("question to the owner: council say hint with the id of the continuable session", async () => {
      const home = tmp();
      const { id, r: first } = await seed(home, 1, hints());
      expect(first.code).toBe(3);
      expect(first.out).not.toContain("Вопрос владельцу");
      const r = await resume(home, id, "--rounds", "1");
      expect(r.code).toBe(3);
      const q = r.outLines.findIndex((l) => l.startsWith("Вопрос владельцу · q1 · p1 «Участник 1»: "));
      expect(q).toBeGreaterThan(-1);
      expect(r.outLines[q + 1]).toBe(`  ответить: council say ${id} --answer q1 "<текст>"`);
    });

    it("show of a continued session with a question — without hints", async () => {
      const home = tmp();
      const { id } = await seed(home, 1, hints());
      expect((await resume(home, id, "--rounds", "1")).code).toBe(3);
      const s = await run(["show", id], { env: dev(home) });
      expect(s.out).toContain("Вопрос владельцу · q1 · p1 «Участник 1»: ");
      expect(s.out).not.toContain("ответить:");
      expect(s.out).not.toContain("продолжить:");
    });

    it("owner wait: continue and say --answer hints with the id of the continuable session", async () => {
      const home = tmp();
      const { id, r: first } = await seed(home, 1, [...hints(), "--wait-for-owner", "--owner-wait-sec", "2"]);
      expect(first.code).toBe(3);
      expect(first.out).not.toContain("Ожидание владельца w");
      const r = await resume(home, id, "--rounds", "1");
      expect(r.code).toBe(3);
      const w = r.outLines.findIndex((l) => l.startsWith("⏸ Ожидание владельца w1 · "));
      expect(w).toBeGreaterThan(-1);
      expect(r.outLines.slice(w + 1, w + 3)).toEqual([`  продолжить: council continue ${id}`, `  ответить: council say ${id} --answer q1 "<текст>"`]);
    }, 15_000);
  });

  it("6. new limit without consent: exit code 3 and objectors", async () => {
    const home = tmp();
    const { id } = await seed(home, 1);
    const r = await resume(home, id, "--rounds", "1");
    expect(r.code).toBe(3);
    expect(r.out).toContain("══ Итог: no_consensus");
    expect(r.out).toContain("Возражают:");
  });

  it("7. signal stop of the new segment: exit code 4", async () => {
    const home = tmp();
    const { id } = await seed(home);
    const ac = new AbortController();
    const r = await run(["resume", id, "--rounds", "2"], { env: dev(home), signal: ac.signal, onOut: (l) => { if (l.includes("— Продолжено")) ac.abort(); } });
    expect(r.code).toBe(4);
    expect(r.out).toContain("══ Итог: stopped");
    expect(lineOf((await run(["list"], { env: dev(home) })).out, id)).toContain("  stopped  ");
  });

  it("8. list and show during a segment: 'running'; after — the last result", async () => {
    const home = tmp();
    const ac1 = new AbortController();
    const first = await run([...base, ...parts(sp("resume", "slow1.json"), sp("resume", "slow2.json")), "--max-rounds", "1"], {
      env: dev(home), signal: ac1.signal, onOut: (l) => { if (l.includes("── Ход 1")) ac1.abort(); },
    });
    expect(first.code).toBe(4);
    const id = idOf(first.out);
    const ac2 = new AbortController();
    let during: Promise<[Awaited<ReturnType<typeof run>>, Awaited<ReturnType<typeof run>>]> | undefined;
    const r = await run(["resume", id, "--rounds", "2"], {
      env: dev(home), signal: ac2.signal,
      onOut: (l) => {
        if (!l.includes("— Продолжено") || during) return;
        during = Promise.all([run(["list"], { env: dev(home) }), run(["show", id], { env: dev(home) })]);
        void during.then(() => ac2.abort());
      },
    });
    const [list, show] = await during!;
    expect(list.out).toContain("  идёт  ");
    expect(show.out).toContain("Статус: идёт");
    expect(show.out).toContain("— Продолжено: общий лимит кругов 2 —");
    expect(r.code).toBe(4);
    const after = await run(["list"], { env: dev(home) });
    expect(after.out).toContain("  stopped  ");
  });

  it("9. removed owner messages are printed before the new turns", async () => {
    const home = tmp();
    const { id } = await seed(home);
    const q = ownerMessagesDir(home, id);
    mkdirSync(q, { recursive: true });
    writeFileSync(join(q, "000000000000001-a.json"), JSON.stringify({ text: "потерянная реплика" }));
    const r = await resume(home, id, "--rounds", "2");
    expect(r.code).toBe(0);
    const head = `Удалено неприменённых реплик владельца: 1. Отправьте заново командой council say ${id} "<текст>":`;
    expect(r.outLines).toContain(head);
    expect(r.outLines).toContain("  потерянная реплика");
    expect(r.out.indexOf(head)).toBeLessThan(r.out.indexOf("── Ход 5"));
  });

  it("10. --help describes resume and --rounds", async () => {
    const r = await run(["--help"]);
    expect(r.out).toContain("council resume <id> [--rounds <n>]");
    expect(r.out).toContain("--rounds <n>");
    expect(r.out).toContain("interrupted, no_consensus или stopped");
  });
});

describe("council resume --replace", () => {
  const step = (stance: string, solution: string | null = null) => ({ response: { stance, reasoning: "Сценарный ответ.", solution, answers: [], questions: [] } });
  const file = (dir: string, name: string, steps: unknown[]) => { const p = join(dir, name); writeFileSync(p, JSON.stringify({ steps })); return p; };
  const agree = (n = 6) => Array.from({ length: n }, () => step("agree"));
  const fail2 = [{ error: "Сценарный сбой вызова" }, { error: "Сценарный сбой вызова" }];
  const bytes = (home: string, id: string) => readFileSync(eventsPath(home, id));
  const resume = (home: string, ...a: string[]) => run(["resume", ...a], { env: dev(home) });
  // p2 drops out on the first turn, only p1 remains: failure with reasonCode
  const seedFailed = async () => {
    const home = tmp(), dir = tmp();
    const p1 = file(dir, "p1.json", [step("amend", "Назвать кота Мурзик."), ...agree()]);
    const p2 = file(dir, "p2.json", fail2);
    const neu = file(dir, "n.json", agree());
    const r = await run([...base, ...parts(`scripted:${p1}`, `scripted:${p2}`), "--max-rounds", "2"], { env: dev(home) });
    return { home, dir, p1, p2, neu, id: idOf(r.out), first: r };
  };
  const jsonl = (home: string, id: string) => readFileSync(eventsPath(home, id), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

  it("1. failed (fewer than two active) + --replace: agreement, one session_resumed entry, old journal is a prefix", async () => {
    const { home, neu, id, first } = await seedFailed();
    expect(first.code).toBe(5);
    expect(first.out).toContain(`Сессию можно продолжить с заменой выбывшего участника: council resume ${id} --replace <pN>=<провайдер>:<модель>`);
    const before = bytes(home, id);
    const r = await resume(home, id, "--rounds", "2", "--replace", `p2=scripted:${neu}`);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe(`Продолжение сессии ${id}: ещё кругов 2 (общий лимит 3), не более 12 вызовов моделей (активных участников 2 × 2 × 3).`);
    expect(lines[1]).toMatch(/^Замена: p2 «Участник 2» → p3 «Участник 3» \(scripted:.+n\.json\) — причина: выбыл: .+/);
    expect(lines[2]).toBe("Согласия сброшены: все активные участники подтверждают текущую версию заново.");
    expect(lines[3]).toBe("Активный состав: p1 «Участник 1», p3 «Участник 3».");
    expect(r.out).toContain("══ Итог: consensus");
    const after = bytes(home, id);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    const resumed = jsonl(home, id).filter((e) => e.type === "session_resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.replacements).toMatchObject([{ oldParticipantId: "p2", participant: { id: "p3", name: "Участник 3" } }]);
    expect(listSessions(home).map((x) => x.id)).toEqual([id]);
    const sh = await run(["show", id], { env: dev(home) });
    expect(sh.out).toContain("  замена: p2 → p3 «Участник 3»");
  });

  it("2. stopped with an unavailable active p2: without --replace refusal, with --replace — reason 'unavailable'", async () => {
    const home = tmp(), dir = tmp();
    const p1 = file(dir, "p1.json", [step("amend", "Назвать кота Мурзик."), ...agree()]);
    const p2 = file(dir, "p2.json", [step("object"), ...agree()]);
    const neu = file(dir, "n.json", agree());
    const ac = new AbortController();
    const first = await run([...base, ...parts(`scripted:${p1}`, `scripted:${p2}`), "--max-rounds", "3"], { env: dev(home), signal: ac.signal, onOut: (l) => { if (l.includes("── Ход 2")) ac.abort(); } });
    expect(first.code).toBe(4);
    const id = idOf(first.out);
    rmSync(p2);
    const before = bytes(home, id);
    const no = await resume(home, id);
    expect(no.code).toBe(2);
    expect(no.err).toContain("p2");
    expect(bytes(home, id).equals(before)).toBe(true);
    const r = await resume(home, id, "--replace", `p2=scripted:${neu}`);
    expect(r.err).toBe("");
    expect(r.out).toMatch(/Замена: p2 «Участник 2» → p3 «Участник 3» \(scripted:.+\) — причина: недоступен: /);
    expect(r.code).toBe(0);
  });

  it("3. replacement refusals: exit code 2, journal unchanged", async () => {
    const home = tmp(), dir = tmp();
    const p1 = file(dir, "p1.json", [step("amend", "Назвать кота Мурзик."), ...agree()]);
    const p2 = file(dir, "p2.json", [step("object"), ...agree()]);
    const neu = file(dir, "n.json", agree());
    const first = await run([...base, ...parts(`scripted:${p1}`, `scripted:${p2}`), "--max-rounds", "1"], { env: dev(home) });
    expect(first.code).toBe(3);
    const id = idOf(first.out);
    const before = bytes(home, id);
    const n = `scripted:${neu}`;
    const cases: [string[], string][] = [
      [["--rounds", "1", "--replace", `p2=${n}`], "доступн"],
      [["--rounds", "1", "--replace", `p2=${n}`, "--replace", `p2=${n}`], "дважды"],
      [["--rounds", "1", "--replace", `p9=${n}`], "p9"],
    ];
    for (const [argv, why] of cases) {
      const r = await resume(home, id, ...argv);
      expect([r.code, argv]).toEqual([2, argv]);
      expect(r.err).toContain(why);
      expect(r.out).toBe("");
      expect(bytes(home, id).equals(before)).toBe(true);
    }
  });

  it("4. failed without --replace names the one to replace; failed without reasonCode is rejected even with a replacement", async () => {
    const { home, neu, id } = await seedFailed();
    const before = bytes(home, id);
    const no = await resume(home, id);
    expect(no.code).toBe(2);
    expect(no.err).toContain("p2");
    expect(bytes(home, id).equals(before).valueOf()).toBe(true);
    const evs = jsonl(home, id);
    const last = evs.at(-1)!;
    expect(last.type).toBe("session_finished");
    delete last.reasonCode;
    writeFileSync(eventsPath(home, id), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const stripped = bytes(home, id);
    const r = await resume(home, id, "--rounds", "2", "--replace", `p2=scripted:${neu}`);
    expect(r.code).toBe(2);
    expect(r.err).toContain("сбоем");
    expect(bytes(home, id).equals(stripped)).toBe(true);
  });

  it("5. invalid --replace values and --replace not with resume: exit code 2 with help", async () => {
    const { home, id } = await seedFailed();
    const before = bytes(home, id);
    for (const v of ["p2", "x=scripted:f", "p2=", "p2=неизвестный:модель"]) {
      const r = await resume(home, id, "--replace", v);
      expect([r.code, v]).toEqual([2, v]);
      expect(r.err).toContain(help());
      expect(r.out).toBe("");
      expect(bytes(home, id).equals(before)).toBe(true);
    }
    const bad = await run([...base, ...two(), "--replace", "p2=scripted:f"], { env: dev(home) });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("флаг --replace принимается только командой resume");
    expect(bad.err).toContain(help());
  });

  it("6. explicit name: --replace p2=New=scripted:<file>", async () => {
    const { home, neu, id } = await seedFailed();
    const r = await resume(home, id, "--rounds", "2", "--replace", `p2=Новый=scripted:${neu}`);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Замена: p2 «Участник 2» → p3 «Новый» /);
    expect(r.out).toContain("Активный состав: p1 «Участник 1», p3 «Новый».");
  });

  it("7. lineups save --from-session after a replacement saves the current lineup", async () => {
    const { home, neu, id, p1 } = await seedFailed();
    expect((await resume(home, id, "--rounds", "2", "--replace", `p2=scripted:${neu}`)).code).toBe(0);
    const r = await run(["lineups", "save", "После замены", "--from-session", id], { env: dev(home) });
    expect(r.code).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, "lineups.json"), "utf8"));
    expect(saved).toHaveLength(1);
    expect(saved[0].participants).toEqual([
      { providerId: "scripted", model: p1, role: null },
      { providerId: "scripted", model: neu, role: null },
    ]);
  });

  it("8. --help describes --replace", async () => {
    const r = await run(["--help"]);
    expect(r.out).toContain("[--replace <pN>=<запись>]…");
    expect(r.out).toContain("  --replace <pN>=<запись>");
  });
});

describe("council: token cap", () => {
  const tc = (file: string) => sp("token-cap", file);
  const pair = () => parts(tc("p1.json"), tc("p2.json"));
  const agree = () => parts(tc("agree/p1.json"), tc("agree/p2.json"));
  const bytes = (home: string, id: string) => readFileSync(eventsPath(home, id));
  const launch = (home: string, ...a: string[]) => run([...base, ...pair(), "--max-rounds", "5", ...a], { env: dev(home) });
  const spend = (out: string) => out.split("\n").filter((l) => l.startsWith("Расход:"));
  const saved = (home: string, id: string) => readFileSync(eventsPath(home, id), "utf8").trim().split("\n").map((l) => JSON.parse(l) as SessionEvent);
  const finish = (home: string, id: string) => saved(home, id).find((e) => e.type === "session_finished") as Extract<SessionEvent, { type: "session_finished" }>;

  it("1. explicit cap: spend per turn, stop on the third turn, exit code 4", async () => {
    const home = tmp();
    const r = await launch(home, "--max-tokens", "1200");
    expect(r.code).toBe(4);
    expect(r.outLines).toContain("Потолок токенов: 1200");
    expect(spend(r.out)).toEqual([500, 1000, 1500].map((n) => `Расход: израсходовано ${n} из 1200 токенов`));
    expect(r.out).not.toContain("── Ход 4");
    expect(r.out).toContain("══ Итог: stopped");
    expect(r.outLines).toContain("Причина: потолок токенов — израсходовано 1500 из 1200");
    expect(r.out).toContain("Версия 2, автор p1");
    expect(r.out).toContain("Возражают:\n  p2 «Участник 2»: ");
    const id = idOf(r.out);
    expect(finish(home, id).reason).toBe("token_cap");
    const created = saved(home, id)[0] as Extract<SessionEvent, { type: "session_created" }>;
    expect(created.session.limits.maxTotalTokens).toBe(1200);
  });

  it("2. cap from the registry", async () => {
    const home = tmp();
    const j = JSON.parse(JSON.stringify(initialRegistry([])));
    j.defaults.maxTotalTokens = 1200;
    writeFileSync(configPath(home), JSON.stringify(j));
    const r = await launch(home);
    expect(r.outLines).toContain("Потолок токенов: 1200 (из реестра)");
    expect(r.code).toBe(4);
    expect(r.outLines).toContain("Причина: потолок токенов — израсходовано 1500 из 1200");
  });

  it("3. --no-max-tokens disables the cap from the registry", async () => {
    const home = tmp();
    const j = JSON.parse(JSON.stringify(initialRegistry([])));
    j.defaults.maxTotalTokens = 1200;
    writeFileSync(configPath(home), JSON.stringify(j));
    const r = await launch(home, "--no-max-tokens");
    expect(r.outLines).toContain("Потолок токенов: потолка нет");
    expect(r.code).toBe(3);
    expect(r.out).toContain("══ Итог: no_consensus");
    expect(r.out).not.toContain("потолок токенов —");
    const created = saved(home, idOf(r.out))[0] as Extract<SessionEvent, { type: "session_created" }>;
    expect(created.session.limits.maxTotalTokens).toBeUndefined();
  });

  it("4. invalid value: reason, help, exit code 2, no sessions", async () => {
    const home = tmp();
    for (const extra of [["--max-tokens", "0"], ["--max-tokens", "abc"], ["--max-tokens", "1.5"], ["--max-tokens", "-3"], ["--max-tokens", "100", "--no-max-tokens"]]) {
      const r = await launch(home, ...extra);
      expect([r.code, extra]).toEqual([2, extra]);
      expect(r.err).toContain("Ошибка:");
      expect(r.err).toContain(help());
      expect(r.out).toBe("");
    }
    expect(listSessions(home)).toEqual([]);
  });

  it("5. consent on exceeding takes priority over the cap", async () => {
    const r = await run([...base, ...agree(), "--max-rounds", "5", "--max-tokens", "800"], { env: dev(tmp()) });
    expect(r.code).toBe(0);
    expect(spend(r.out)).toEqual(["Расход: израсходовано 500 из 800 токенов", "Расход: израсходовано 1200 из 800 токенов"]);
    expect(r.out).toContain("══ Итог: consensus");
    expect(r.out).not.toContain("Причина:");
  });

  it("6. turns without spend data: accounting incomplete, no stop", async () => {
    const r = await run([...base, ...two(), "--max-rounds", "3", "--max-tokens", "100"], { env: dev(tmp()) });
    expect(r.code).toBe(0);
    expect(spend(r.out).every((l) => l === "Расход: участники не сообщают токены, учёт неполный; потолок 100 не проверяется")).toBe(true);
    expect(spend(r.out).length).toBeGreaterThan(0);
    expect(r.out).not.toMatch(/израсходовано 0/);
    expect(r.out).toContain("══ Итог: consensus");
    expect(r.outLines).toContain("Учёт токенов неполный: потолок 100 мог не сработать");
  });

  it("7. without flags and without a registry value: spend without a cap, no cap lines", async () => {
    const r = await launch(tmp());
    expect(r.code).toBe(3);
    expect(spend(r.out).slice(0, 2)).toEqual(["Расход: 500 токенов, потолка нет", "Расход: 1000 токенов, потолка нет"]);
    expect(r.out).not.toContain("Потолок токенов:");
  });

  it("8. show: reason with code, tokens and cap", async () => {
    const home = tmp();
    const id = idOf((await launch(home, "--max-tokens", "1200")).out);
    const r = await run(["show", id], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("token_cap (потолок токенов)");
    expect(r.outLines.at(-1)).toMatch(/токены 900 \/ 600.*потолок 1200/);
    expect(r.out).not.toContain("Расход:");
  });

  it("9-12. resume: refusals, new cap, cap removal", async () => {
    const home = tmp();
    const id = idOf((await launch(home, "--max-tokens", "1200")).out);
    const before = bytes(home, id);
    const resume = (...a: string[]) => run(["resume", id, ...a], { env: dev(home) });

    const noFlags = await resume();
    expect(noFlags.code).toBe(2);
    expect(noFlags.err).toContain("1200");
    expect(noFlags.err).toContain("1500");
    expect(noFlags.err).toContain("--max-tokens");
    expect(noFlags.err).toContain("--no-max-tokens");
    const low = await resume("--rounds", "2", "--max-tokens", "1500");
    expect(low.code).toBe(2);
    expect(low.err).toMatch(/не выше/);
    for (const extra of [["--max-tokens", "0"], ["--max-tokens", "5", "--no-max-tokens"]]) {
      const r = await resume("--rounds", "2", ...extra);
      expect([r.code, extra]).toEqual([2, extra]);
      expect(r.err).toContain(help());
    }
    expect(bytes(home, id).equals(before)).toBe(true);

    const up = await resume("--rounds", "2", "--max-tokens", "2500");
    expect(up.code).toBe(4);
    expect(up.out.indexOf("Потолок токенов: 2500, уже израсходовано 1500")).toBeGreaterThan(-1);
    expect(up.out.indexOf("Потолок токенов: 2500, уже израсходовано 1500")).toBeLessThan(up.out.indexOf("── Ход 4"));
    expect(spend(up.out)).toEqual(["Расход: израсходовано 2000 из 2500 токенов", "Расход: израсходовано 2500 из 2500 токенов"]);
    expect(up.outLines).toContain("Причина: потолок токенов — израсходовано 2500 из 2500");
    let ev = saved(home, id);
    expect(ev.filter((e) => e.type === "session_created")).toHaveLength(1);
    const resumed = ev.filter((e) => e.type === "session_resumed") as Extract<SessionEvent, { type: "session_resumed" }>[];
    expect(resumed.map((e) => e.maxTotalTokens)).toEqual([2500]);

    const off = await resume("--rounds", "1", "--no-max-tokens");
    expect(off.code).toBe(3);
    expect(off.out).toContain("Потолок токенов: потолка нет, уже израсходовано 2500");
    expect(off.out).toContain("══ Итог: no_consensus");
    expect(off.out).not.toContain("потолок токенов —");
    expect(spend(off.out)).toEqual(["Расход: 3000 токенов, потолка нет"]);
    ev = saved(home, id);
    expect((ev.filter((e) => e.type === "session_resumed") as Extract<SessionEvent, { type: "session_resumed" }>[]).map((e) => e.maxTotalTokens)).toEqual([2500, null]);
    const sh = await run(["show", id], { env: dev(home) });
    expect(sh.out).toContain("потолок токенов 2500");
    expect(sh.out).toContain("потолок снят");
  });

  it("13. cap flags on list, show, stop — usage error", async () => {
    for (const argv of [["list", "--max-tokens", "5"], ["show", "x", "--no-max-tokens"], ["stop", "x", "--max-tokens", "5"]]) {
      const r = await run(argv, { env: dev(tmp()) });
      expect([r.code, argv]).toEqual([2, argv]);
      expect(r.err).toContain("принимаются только запуском и командой resume");
    }
  });

  it("14. help describes the flags, token_cap and the overrun by one turn", () => {
    for (const s of ["--max-tokens <n>", "--no-max-tokens", "token_cap", "превышен на один ход"]) expect(help()).toContain(s);
  });

  it("15. old session without a cap: show reads it, journal unchanged", async () => {
    const home = tmp();
    const ts = "2026-01-01T00:00:00.000Z";
    createSessionJournal(home, "old1");
    appendEvent(home, "old1", {
      seq: 1, ts, type: "session_created", pid: 1,
      session: {
        id: "old1", createdAt: ts, origin: "cli", topic: "Тема", templateId: null, framing: "",
        participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
        limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
      },
    });
    appendEvent(home, "old1", { seq: 2, ts, type: "session_finished", status: "no_consensus", version: null, agreed: [], objectors: [] } as SessionEvent);
    const before = bytes(home, "old1");
    const r = await run(["show", "old1"], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Статус: no_consensus");
    expect(r.out).not.toContain("потолок");
    expect(bytes(home, "old1").equals(before)).toBe(true);
  });
});

describe("owner wait", () => {
  const ts = "2026-01-01T00:00:00.000Z";
  const future = () => new Date(Date.now() + 120_000).toISOString();
  const session = (id: string) => ({
    id, createdAt: ts, origin: "cli" as const, topic: "Тема", templateId: null, framing: "",
    participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  });
  const turn = (seq: number, questions: { id: string; to: string; text: string }[] = []): SessionEvent => ({
    seq, ts, type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "amend", normalized: false,
    reasoning: "аргумент", solution: "Текст", version: 1, questions, answers: [], attempts: 1, usage: {}, durationMs: 1,
  });
  const started = (seq: number, deadline = future()): SessionEvent => ({
    seq, ts, type: "owner_wait_started", waitId: "w1", reasons: ["round_boundary", "owner_question"], questionIds: ["q1"], afterTurn: 1, deadline,
  });
  const q1 = [{ id: "q1", to: "owner", text: "Таблица или текст?" }];
  const make = (home: string, id: string, events: SessionEvent[], pid = 1) => {
    createSessionJournal(home, id);
    appendEvent(home, id, { seq: 1, ts, type: "session_created", session: session(id), pid });
    for (const e of events) appendEvent(home, id, e);
    openOwnerQueue(home, id);
    return id;
  };
  const waiting = (home: string, deadline?: string, pid = 1) => make(home, "s1", [turn(2, q1), started(3, deadline)], pid);
  const bytes = (home: string, id: string) => readFileSync(eventsPath(home, id));
  const files = (home: string, id: string) => readdirSync(ownerMessagesDir(home, id)).filter((f) => f.endsWith(".json"));
  const journal = (home: string, id: string) => readFileSync(eventsPath(home, id), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const tmpScenario = (name: string, steps: object[]) => {
    const f = join(tmp(), name);
    writeFileSync(f, JSON.stringify({ steps: steps.map((response) => ({ response })) }));
    return f;
  };
  const amend = (t: string) => ({ stance: "amend", reasoning: "довод", solution: t, answers: [], questions: [] });
  const agree = { stance: "agree", reasoning: "согласен", solution: null, answers: [], questions: [] };

  it("1. off by default", async () => {
    const home = tmp();
    const r = await run([...base, ...two(), "--max-rounds", "3"], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("Ожидание владельца:");
    const ev = journal(home, idOf(r.out));
    expect(ev.some((e) => String(e.type).startsWith("owner_wait_"))).toBe(false);
    expect("ownerWait" in ev[0].session).toBe(false);
  });

  it("2. flag checks", async () => {
    for (const v of ["0", "1.5", "86401", "abc"]) {
      const home = tmp();
      const r = await run([...base, ...two(), "--pause-after-round", "--owner-wait-sec", v], { env: dev(home) });
      expect(r.code, v).toBe(2);
      expect(r.err).toContain("--owner-wait-sec: нужно целое число от 1 до 86400.");
      expect(r.err).toContain("Использование:");
      expect(existsSync(join(home, "sessions"))).toBe(false);
    }
    const no = await run([...base, ...two(), "--owner-wait-sec", "5"]);
    expect(no.code).toBe(2);
    expect(no.err).toContain("флаг --owner-wait-sec требует --pause-after-round или --wait-for-owner.");
    for (const argv of [["resume", "x"], ["show", "x"], ["say", "x", "т"]]) {
      expect((await run([...argv, "--pause-after-round"])).code, argv[0]).toBe(2);
    }
    expect((await run(["show", "x", "--wait-for-owner"])).err).toContain("принимаются только запуском");
  });

  it("3. flags reach the session", async () => {
    const home = tmp();
    const quick = parts(`scripted:${tmpScenario("a.json", [amend("Текст")])}`, `scripted:${tmpScenario("b.json", [agree])}`);
    const r = await run([...base, ...quick, "--max-rounds", "3", "--pause-after-round", "--owner-wait-sec", "7"], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(journal(home, idOf(r.out))[0].session.ownerWait).toEqual({ pauseAfterRound: true, timeoutSec: 7 });
    expect(r.out).toContain("Ожидание владельца: пауза после каждого круга, срок 7 с. По истечении срока обсуждение продолжится само в пределах лимита кругов.");
    const home2 = tmp();
    const r2 = await run([...base, ...quick, "--max-rounds", "3", "--wait-for-owner"], { env: dev(home2) });
    expect(journal(home2, idOf(r2.out))[0].session.ownerWait).toEqual({ waitForOwner: true });
    expect(r2.out).toContain("Ожидание владельца: ответ на вопрос владельцу, срок 300 с.");
  });

  it("4. status: running session in a wait", async () => {
    const home = tmp();
    const id = waiting(home);
    const before = bytes(home, id);
    const r = await run(["status", id], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.outLines[0]).toBe(`Сессия ${id}: идёт`);
    expect(r.outLines[1]).toMatch(/^Круг \d+ из 3, ходов: 1$/);
    expect(r.outLines[2]).toBe("Ожидание владельца w1: пауза после круга; вопрос владельцу");
    expect(r.out).toContain("  q1 · p1 «n1»: Таблица или текст?");
    expect(r.out).toMatch(/Срок: \S+, осталось \d+ с/);
    expect(r.out).toContain(`  продолжить: council continue ${id}`);
    expect(r.out).toContain(`  ответить: council say ${id} --answer q1 "<текст>"`);
    expect(bytes(home, id).equals(before)).toBe(true);
    expect(existsSync(configPath(home))).toBe(false);
  });

  it("5. status: no wait, interrupted, unknown, expired deadline", async () => {
    const home = tmp();
    make(home, "n1", [turn(2)]);
    expect((await run(["status", "n1"], { env: dev(home) })).out).toContain("Ожидания владельца нет.");
    const h2 = tmp();
    const id = waiting(h2, undefined, 2 ** 22 + 12345);
    const r = await run(["status", id], { env: dev(h2) });
    expect(r.out).toContain(`Исполнитель не работает: ожидание продолжится после council resume ${id}.`);
    expect(r.out).not.toContain("council continue");
    const un = await run(["status", "nope"], { env: dev(home) });
    expect(un.code).toBe(2);
    expect(un.err).toBe("Сессия nope не найдена.");
    const h3 = tmp();
    waiting(h3, "2026-01-02T00:00:00.000Z");
    expect((await run(["status", "s1"], { env: dev(h3) })).out).toContain("Срок: 2026-01-02T00:00:00.000Z, истёк");
  });

  it("6. continue: request to release the wait", async () => {
    const home = tmp();
    const id = waiting(home);
    const before = bytes(home, id);
    const r = await run(["continue", id], { env: dev(home) });
    expect([r.code, r.out]).toEqual([0, `Продолжение сессии ${id} запрошено: ожидание w1 будет снято.`]);
    const fs = files(home, id);
    expect(fs).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(ownerMessagesDir(home, id), fs[0]!), "utf8")).releaseWaitId).toBe("w1");
    expect(bytes(home, id).equals(before)).toBe(true);
    expect(existsSync(configPath(home))).toBe(false);
  });

  it("7. continue: refusals without help", async () => {
    const home = tmp();
    make(home, "nw", [turn(2)]);
    make(home, "fin", [turn(2), { seq: 3, ts, type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [] }]);
    make(home, "dead", [turn(2), started(3)], 2 ** 22 + 12345);
    for (const [id, text] of [["nw", "не ждёт владельца"], ["fin", "уже завершена"], ["dead", "прервана"], ["nope", "не найдена"]] as const) {
      const r = await run(["continue", id], { env: dev(home) });
      expect(r.code, id).toBe(2);
      expect(r.err, id).toContain(text);
      expect(r.err).not.toContain("Использование:");
    }
  });

  it("8. a message does not release the pause", async () => {
    const home = tmp();
    const id = waiting(home);
    const s1 = (await run(["status", id], { env: dev(home) })).outLines;
    expect((await run(["say", id, "текст"], { env: dev(home) })).code).toBe(0);
    const s2 = (await run(["status", id], { env: dev(home) })).outLines;
    const pick = (l: string[]) => [l[2], l.find((x) => x.startsWith("Срок:"))!.replace(/, осталось.*/, "")];
    expect(pick(s2)).toEqual(pick(s1));
  });

  it("9. continue vs resume", async () => {
    const home = tmp();
    const id = waiting(home);
    const r = await run(["resume", id], { env: dev(home) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("идёт: исполнитель ещё работает");
    expect((await run(["continue", id], { env: dev(home) })).code).toBe(0);
  });

  it("10. show prints the wait events", async () => {
    const home = tmp();
    const plain = make(home, "p", [turn(2)]);
    const plainOut = (await run(["show", plain], { env: dev(home) })).out;
    expect(plainOut).not.toContain("Ожидание");
    make(home, "w", [
      turn(2, q1), started(3),
      { seq: 4, ts, type: "owner_wait_updated", waitId: "w1", reasons: ["round_boundary"], questionIds: [] },
      { seq: 5, ts, type: "owner_wait_finished", waitId: "w1", reason: "continued" },
      { seq: 6, ts, type: "owner_wait_started", waitId: "w2", reasons: ["round_boundary"], questionIds: [], afterTurn: 1, deadline: future() },
    ]);
    const out = (await run(["show", "w"], { env: dev(home) })).out;
    const at = (s: string) => out.indexOf(s);
    expect(out).toContain("⏸ Ожидание владельца w1 · пауза после круга; вопрос владельцу (q1) · до ");
    expect(at("⏸ Ожидание владельца w1")).toBeGreaterThan(at("── Ход 1"));
    expect(at("  ожидание w1: остаётся — пауза после круга")).toBeGreaterThan(at("⏸ Ожидание владельца w1"));
    expect(at("▶ Ожидание w1 снято: владелец продолжил")).toBeGreaterThan(at("  ожидание w1:"));
    expect(at("⏸ Ожидание владельца w2")).toBeGreaterThan(at("▶ Ожидание w1"));
    expect(out).not.toContain("council continue");
    expect(out).toMatch(/Согласны: [^\n]*\nОжидание владельца w2: пауза после круга · до /);
  });

  it("11. live launch: pause, message, continue", { timeout: 40_000 }, async () => {
    const home = tmp();
    const a = tmpScenario("a.json", [amend("Текст А"), agree]);
    const b = tmpScenario("b.json", [amend("Текст Б"), agree]);
    const child = spawn(process.execPath, [entry, ...base, ...parts(`scripted:${a}`, `scripted:${b}`), "--max-rounds", "3", "--pause-after-round", "--owner-wait-sec", "30"], { env: { ...process.env, ...dev(home) } });
    try {
      let stdout = "";
      child.stdout.on("data", (c) => { stdout += c; });
      const closedP = new Promise<number | null>((res) => child.on("close", res));
      let id = "";
      for (let i = 0; i < 150 && !id; i++) {
        const cand = listSessions(home).find((s) => s.status === "running")?.id ?? "";
        if (cand && existsSync(eventsPath(home, cand)) && readFileSync(eventsPath(home, cand), "utf8").includes("owner_wait_started")) id = cand;
        else await sleep(100);
      }
      expect(id).not.toBe("");
      const env = dev(home);
      const st = await run(["status", id], { env });
      expect(st.out).toContain("Ожидание владельца w1: пауза после круга");
      const turns = () => journal(home, id).filter((e) => e.type === "turn_started").length;
      const n = turns();
      await sleep(1000);
      expect(turns()).toBe(n);
      expect((await run(["say", id, "реплика"], { env })).code).toBe(0);
      for (let i = 0; i < 50 && !journal(home, id).some((e) => e.type === "owner_message"); i++) await sleep(100);
      expect(journal(home, id).some((e) => e.type === "owner_message")).toBe(true);
      expect((await run(["status", id], { env })).out).toContain("Ожидание владельца w1: пауза после круга");
      expect(journal(home, id).some((e) => e.type === "owner_wait_finished")).toBe(false);
      expect((await run(["continue", id], { env })).code).toBe(0);
      expect(await Promise.race([closedP, sleep(30_000).then(() => "timeout" as const)])).toBe(0);
      const ev = journal(home, id);
      const fin = ev.findIndex((e) => e.type === "owner_wait_finished");
      expect(ev[fin]).toMatchObject({ waitId: "w1", reason: "continued" });
      expect(ev.slice(fin).some((e) => e.type === "turn_started")).toBe(true);
      expect(stdout).toContain("⏸ Ожидание владельца w1");
      expect(stdout).toContain(`  продолжить: council continue ${id}`);
      expect(stdout).toContain("▶ Ожидание w1 снято: владелец продолжил");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("12. help", async () => {
    const r = await run(["--help"]);
    for (const s of ["council status <id>", "council continue <id>", "--pause-after-round", "--wait-for-owner", "--owner-wait-sec <N>", "Ожидание владельца",
      "show <id>  ход и состояние сессии; выбор владельца", "council say <id> [--answer <qN>] <текст>", "council resume <id> [--rounds <n>]", "interrupted, no_consensus или stopped", "Без --wait-for-owner обсуждение ответа не ждёт"]) {
      expect(r.out).toContain(s);
    }
    expect(help()).toContain("отклонённое снятие ожидания");
  });
});

describe("folder snapshot in the terminal: --attach of a large folder", () => {
  const real = () => realpathSync(tmp());
  const argv = (...extra: string[]) => [...base, ...two(), "--max-rounds", "3", ...extra];
  const filesUnder = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? filesUnder(f) : [f]; });
  const everything = (home: string, r: { out: string; err: string }) => {
    const log = join(home, "logs", "app.log");
    return [r.out, r.err, existsSync(log) ? readFileSync(log, "utf8") : "", ...(existsSync(join(home, "sessions")) ? filesUnder(join(home, "sessions")).map((f) => readFileSync(f, "utf8")) : [])].join("\n");
  };
  const MARK = "МАРКЕР-ТЕЛА-ФАЙЛА-4417";
  const bigText = `// ${MARK}\n` + "x".repeat(300);
  const fixture = (extra: Record<string, string> = {}) => {
    const root = real();
    mkdirSync(join(root, "proj", "src"), { recursive: true });
    writeFileSync(join(root, "proj", "README.md"), "Описание проекта");
    writeFileSync(join(root, "proj", "src", "a.ts"), bigText);
    for (const [n, t] of Object.entries(extra)) writeFileSync(join(root, "proj", n), t);
    return root;
  };
  const scen = (dir: string, name: string, steps: object[]) => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify({ steps }));
    return `scripted:${f}`;
  };
  const resp = (stance: string, solution: string | null, files: string[] = [], expectPrompt?: string) => ({
    ...(expectPrompt ? { expectPrompt } : {}),
    response: { stance, reasoning: "Довод.", solution, answers: [], questions: [], files },
  });
  const read = async () => {
    const root = fixture();
    const dir = tmp();
    const home = tmp();
    const p1 = scen(dir, "p1.json", [resp("object", null, ["proj/src/a.ts"]), resp("amend", "Решение", [], MARK), resp("agree", null)]);
    const p2 = scen(dir, "p2.json", [resp("agree", null)]);
    const r = await run([...base, ...parts(p1, p2), "--max-rounds", "3", "--attach", join(root, "proj"), "--materials-chars", "100"], { env: dev(home) });
    return { root, home, r };
  };

  it("1. folder over the limit: summary, snapshot in the session and on disk; 6. without an absolute root", async () => {
    const root = fixture();
    const home = tmp();
    const r = await run(argv("--attach", join(root, "proj"), "--materials-chars", "100"), { env: dev(home) });
    expect(r.code).toBe(0);
    const chars = "Описание проекта".length + bigText.length;
    for (const l of [
      "Материалы: 1,",
      `Снимок папки: файлов 2, объём ${chars} знаков (граница 20000000).`,
      "Не вошло в исходный набор: 1",
      "  proj/src/a.ts — не описание — из папки больше лимита берутся только описания",
    ]) expect(r.out).toContain(l);
    expect(r.out.indexOf("Снимок папки:")).toBeLessThan(r.out.indexOf("Сессия "));
    expect(r.out.indexOf("Не вошло в исходный набор")).toBeLessThan(r.out.indexOf("Сессия "));
    const session = sessionEvents(home)[0].session;
    expect(session.workspace).toEqual({ files: 2, chars });
    expect(session.materials).toHaveLength(1);
    const id = readdirSync(join(home, "sessions"))[0]!;
    expect(readFileSync(join(home, "sessions", id, "workspace", "proj", "src", "a.ts"), "utf8")).toBe(bigText);
    expect(everything(home, r)).not.toContain(root);
  });

  it("2. read on request: line in the feed, file text does not reach output or log; 7. show", async () => {
    const { home, r } = await read();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Прочитано из папки: proj/src/a.ts — ${bigText.length} знаков`);
    for (const t of [r.out, r.err, readFileSync(join(home, "logs", "app.log"), "utf8")]) expect(t).not.toContain(MARK);
    const id = readdirSync(join(home, "sessions"))[0]!;
    const shown = await run(["show", id], { env: dev(home) });
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`Прочитано из папки: proj/src/a.ts — ${bigText.length} знаков`);
  });

  it("3. an explicit file inside a folder over the limit enters the set once", async () => {
    const root = fixture();
    const chars = "Описание проекта".length + bigText.length;
    for (const order of [["src/a.ts", ""], ["", "src/a.ts"]] as const) {
      const home = tmp();
      const flags = order.flatMap((rel) => ["--attach", rel ? join(root, "proj", rel) : join(root, "proj")]);
      const r = await run(argv(...flags, "--materials-chars", String(bigText.length + 5)), { env: dev(home) });
      expect(r.code, order.join("|")).toBe(0);
      expect(r.out, order.join("|")).toContain(`Снимок папки: файлов 2, объём ${chars} знаков`);
      const session = sessionEvents(home)[0].session;
      const mats = session.materials as { name: string }[];
      expect(mats.filter((m) => m.name.endsWith("a.ts")).map((m) => m.name), order.join("|")).toEqual(["proj/src/a.ts"]);
      expect(session.workspace, order.join("|")).toEqual({ files: 2, chars });
    }
  });

  it("4. more than 20 files not included: 20 lines and '… and 6 more'", async () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < 25; i++) extra[`f${String(i).padStart(2, "0")}.ts`] = "код";
    const root = fixture(extra);
    const home = tmp();
    const r = await run(argv("--attach", join(root, "proj"), "--materials-chars", "20"), { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Не вошло в исходный набор: 26 "); // 25 files f*.ts and src/a.ts
    expect(r.outLines.filter((l) => /^ {2}proj\/.* — /.test(l))).toHaveLength(20);
    expect(r.out).toContain("  … и ещё 6");
  });

  it("5. snapshot limit 20000000: refusal, session not created, help not printed", async () => {
    const root = real();
    mkdirSync(join(root, "big"));
    writeFileSync(join(root, "big", "a.txt"), "a".repeat(10000000));
    writeFileSync(join(root, "big", "b.txt"), "b".repeat(10000001));
    const home = tmp();
    const r = await run(argv("--attach", join(root, "big")), { env: dev(home) });
    expect(r.code).toBe(2);
    for (const t of ["Материалы не приняты:", "20000001", "20000000"]) expect(r.err).toContain(t);
    expect(r.err).not.toContain(root);
    const sd = join(home, "sessions");
    expect((existsSync(sd) ? readdirSync(sd) : []).filter((d) => existsSync(join(sd, d, "events.jsonl")))).toEqual([]);
    expect(r.out + r.err).not.toContain("Использование");
  });

  it("8. help: limit and snapshot", async () => {
    expect(help()).toContain("20000000");
    expect(help()).toContain("снимок");
  });
});

describe("journal of a newer version in council output", () => {
  const ts = "2026-01-01T00:00:00.000Z";
  const session = (id: string) => ({
    id, createdAt: ts, origin: "cli" as const, topic: "Тема", templateId: null, framing: "",
    participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  });
  const turn = (seq: number): SessionEvent => ({
    seq, ts, type: "turn_completed", turn: seq - 1, round: 1, participantId: `p${(seq % 2) + 1}`, stance: "agree", normalized: false,
    reasoning: "аргумент", solution: null, version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
  });
  const finished = (seq: number): SessionEvent => ({ seq, ts, type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [] });
  const future = (seq: number) => `{"seq":${seq},"ts":"${ts}","type":"future_event"}\n`;
  const NEWER = "журнал записан более новой версией, прочитан до события №3";
  const ADVICE = "Обновите приложение, чтобы прочитать сессию целиком.";
  // Journal: session_created, two turns, an unknown line (seq 4), then more events; pid dead or alive
  const make = (home: string, id: string, opts: { pid?: number; head?: SessionEvent[]; tail?: SessionEvent[] } = {}) => {
    createSessionJournal(home, id);
    appendEvent(home, id, { seq: 1, ts, type: "session_created", session: session(id), pid: opts.pid ?? 1 });
    for (const e of opts.head ?? [turn(2), turn(3)]) appendEvent(home, id, e);
    appendFileSync(eventsPath(home, id), future(4));
    for (const e of opts.tail ?? [turn(5)]) appendEvent(home, id, e);
    return id;
  };
  const deadPid = async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((res) => child.once("exit", res));
    return child.pid!;
  };
  const sha = (home: string, id: string) => createHash("sha256").update(readFileSync(eventsPath(home, id))).digest("hex");

  it("list and status: session without a result — 'state not determined', without the word 'interrupted'", async () => {
    for (const pid of [1, await deadPid()]) {
      const home = tmp();
      make(home, "s1", { pid });
      const l = await run(["list"], { env: dev(home) });
      expect(l.code).toBe(0);
      expect(l.out).toContain(`состояние не определено · ${NEWER}`);
      expect(l.out).not.toMatch(/прервана|идёт|running|interrupted/);
      expect(l.out.split("\n").filter((x) => x === ADVICE)).toHaveLength(1);
      const st = await run(["status", "s1"], { env: dev(home) });
      expect(st.code).toBe(0);
      expect(st.out).toContain(`Сессия s1: состояние не определено · ${NEWER}`);
      expect(st.out).toContain(`\n${ADVICE}`);
      expect(st.out).not.toMatch(/прервана|идёт|running|interrupted|council resume/);
    }
  });

  it("status: owner wait for a session without a result does not promise 'continue' or 'resume'", async () => {
    for (const pid of [1, await deadPid()]) {
      const home = tmp();
      const wait: SessionEvent = { seq: 3, ts, type: "owner_wait_started", waitId: "w1", reasons: ["round_boundary"], questionIds: [], afterTurn: 2, deadline: new Date(Date.now() + 120_000).toISOString() };
      make(home, "w", { pid, head: [turn(2), wait], tail: [] });
      const st = await run(["status", "w"], { env: dev(home) });
      expect(st.out).toContain("Ожидание владельца w1");
      expect(st.out).not.toMatch(/продолжить: council|council resume|прервана|идёт/);
    }
  });

  it("result before the unknown line is shown with a note", async () => {
    const home = tmp();
    make(home, "s1", { head: [turn(2), finished(3)], tail: [] });
    const l = await run(["list"], { env: dev(home) });
    expect(l.out).toContain(`consensus · ${NEWER}`);
    expect(l.out).not.toContain("состояние не определено");
    const st = await run(["status", "s1"], { env: dev(home) });
    expect(st.out).toContain(`Сессия s1: consensus · ${NEWER}`);
  });

  it("show: note", async () => {
    const home = tmp();
    make(home, "s1");
    const r = await run(["show", "s1"], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Статус: состояние не определено · ${NEWER}\n${ADVICE}`);
    expect(r.out).not.toMatch(/прервана|идёт/);
    make(home, "s2", { head: [turn(2), finished(3)], tail: [] });
    const f = await run(["show", "s2"], { env: dev(home) });
    expect(f.out).toContain(`Статус: consensus · ${NEWER}`);
  });

  it("resume, say, continue: exit code 2 and the newer-version text, journal unchanged", async () => {
    const home = tmp();
    make(home, "s1");
    const before = sha(home, "s1");
    for (const argv of [["resume", "s1"], ["say", "s1", "текст"], ["continue", "s1"]]) {
      const r = await run(argv, { env: dev(home) });
      expect(r.code).toBe(2);
      expect(r.err).toContain("более новой версией");
      expect(r.err).toContain("№3");
      expect(r.err).not.toContain("журнал сессии повреждён");
      expect(sha(home, "s1")).toBe(before);
    }
  });

  it("stop: newer_version session — request accepted, exit code 0", async () => {
    const home = tmp();
    make(home, "s1");
    const before = sha(home, "s1");
    const r = await run(["stop", "s1"], { env: dev(home) });
    expect([r.code, r.out]).toEqual([0, "Остановка сессии s1 запрошена."]);
    expect(sha(home, "s1")).toBe(before);
  });

  it("corrupted: note about corruption, status unchanged", async () => {
    // truncated tail without \n instead of an unknown line
    const home2 = tmp();
    createSessionJournal(home2, "c");
    appendEvent(home2, "c", { seq: 1, ts, type: "session_created", session: session("c"), pid: 1 });
    appendEvent(home2, "c", turn(2));
    appendFileSync(eventsPath(home2, "c"), '{"seq":3,"ts":"');
    const l = await run(["list"], { env: dev(home2) });
    expect(l.out).toContain("идёт");
    expect(l.out).toContain(" · журнал повреждён, прочитан до события №2");
    expect(l.out).not.toMatch(/состояние не определено|Обновите приложение/);
    const st = await run(["status", "c"], { env: dev(home2) });
    expect(st.out).toContain("Сессия c: идёт · журнал повреждён, прочитан до события №2");
    expect(st.out).not.toContain("Обновите приложение");
    const sh = await run(["show", "c"], { env: dev(home2) });
    expect(sh.out).toContain("Статус: идёт · журнал повреждён, прочитан до события №2");
  });
});

describe("terminal .gitignore rules: --include and --no-ignore", () => {
  const real = () => realpathSync(tmp());
  const MARK = "МАРКЕР-СБОРКИ-7071";
  const RULE = "исключён правилом .gitignore: ";
  const fixture = () => {
    const root = real();
    for (const [n, t] of Object.entries({
      "proj/.gitignore": "out/\n", "proj/README.md": "Описание", "proj/src/a.ts": "код",
      "proj/out/main.js": `// ${MARK}\n${"x".repeat(2000)}`, "proj/out/assets/b.js": "b",
      "proj/pkg/.gitignore": "gen/\n", "proj/pkg/gen/c.ts": "c", "proj/pkg/d.ts": "d",
    })) {
      mkdirSync(join(root, n, ".."), { recursive: true });
      writeFileSync(join(root, n), t);
    }
    return root;
  };
  const scen = (name: string, steps: object[]) => {
    const f = join(tmp(), name);
    writeFileSync(f, JSON.stringify({ steps }));
    return `scripted:${f}`;
  };
  const resp = (stance: string, solution: string | null, files: string[] = [], expectPrompt?: string) => ({
    ...(expectPrompt ? { expectPrompt } : {}),
    response: { stance, reasoning: "Довод.", solution, answers: [], questions: [], files },
  });
  // the first participant asks for out/main.js and on the second step waits for expect in the request
  const asking = (expect: string) => [...base, ...parts(scen("p1.json", [resp("object", null, ["proj/out/main.js"]), resp("amend", "Решение", [], expect), resp("agree", null)]), scen("p2.json", [resp("agree", null)])), "--max-rounds", "3"];
  const quiet = [...base, ...two(), "--max-rounds", "3"];
  const section = (r: { outLines: string[] }) => {
    const from = r.outLines.findIndex((l) => l.startsWith("Исключено правилами: "));
    if (from < 0) return null;
    const rows: string[] = [];
    for (let i = from + 1; r.outLines[i]?.startsWith("  "); i++) rows.push(r.outLines[i]!);
    return { head: r.outLines[from]!, rows };
  };
  const workspaceFiles = (home: string) => {
    const dir = join(home, "sessions", readdirSync(join(home, "sessions"))[0]!, "workspace");
    const walk = (d: string, rel: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n), `${rel}${n}/`) : [`${rel}${n}`]));
    return walk(dir, "").sort();
  };
  const all = (home: string, r: { out: string; err: string }) => {
    const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [readFileSync(join(d, n), "utf8")])) : []);
    return [r.out, r.err, ...walk(home)].join("\n");
  };

  it("Excluded by rules: section with reasons before the session line, excluded files are not in the snapshot; without return: the participant does not get the file", async () => {
    const root = fixture();
    const home = tmp();
    const r = await run([...asking("нет в папке владельца"), "--attach", join(root, "proj")], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(section(r)).toEqual({ head: "Исключено правилами: 2", rows: [`  proj/out/ — ${RULE}out/`, `  proj/pkg/gen/ — ${RULE}gen/`] });
    expect(r.out.indexOf("Исключено правилами:")).toBeLessThan(r.out.indexOf("Сессия "));
    expect(r.out).toContain("Пропущено: 2"); // two hidden .gitignore; the rule-excluded ones are not counted here
    expect(workspaceFiles(home)).toEqual(["proj/README.md", "proj/pkg/d.ts", "proj/src/a.ts"]);
    expect(all(home, r)).not.toContain(MARK);
    expect(all(home, r)).not.toContain(root);
    expect(all(home, r)).not.toContain("excludedPath");
  });

  it("File return: --include brings the file back, the rest stays excluded, the participant gets the file from the snapshot", async () => {
    const root = fixture();
    const home = tmp();
    const r = await run([...asking(MARK), "--attach", join(root, "proj"), "--include", join(root, "proj/out/main.js")], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(section(r)!.rows).toEqual([`  proj/out/assets/ — ${RULE}out/`, `  proj/pkg/gen/ — ${RULE}gen/`]);
    expect(workspaceFiles(home)).toEqual(["proj/README.md", "proj/out/main.js", "proj/pkg/d.ts", "proj/src/a.ts"]);
    expect(r.out).toContain("══ Итог: consensus");
  });

  it("Rules off: --no-ignore — no section, snapshot unchanged", async () => {
    const root = fixture();
    const home = tmp();
    const r = await run([...asking(MARK), "--attach", join(root, "proj"), "--no-ignore"], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(section(r)).toBeNull();
    expect(workspaceFiles(home)).toEqual(["proj/README.md", "proj/out/assets/b.js", "proj/out/main.js", "proj/pkg/d.ts", "proj/pkg/gen/c.ts", "proj/src/a.ts"]);
  });

  it("Invalid return: a path the rules did not exclude — exit code 2 without help; --include with --no-ignore — exit code 2 with help; no session", async () => {
    const root = fixture();
    for (const bad of [join(root, "proj/src/a.ts"), join(root, "proj/нет.ts"), "чужое/x.ts"]) {
      const home = tmp();
      const r = await run([...quiet, "--attach", join(root, "proj"), "--include", bad], { env: dev(home) });
      expect(r.code, bad).toBe(2);
      expect(r.err).toContain("Материалы не приняты:");
      expect(r.err).toContain(`${bad.split("/").pop()}»: путь не найден среди исключённых правилами .gitignore`);
      expect(r.err).not.toContain("Использование:");
      expect(r.err).not.toContain(root);
      expect(listSessions(home)).toEqual([]);
    }
    const combos: string[][] = [
      ["--attach", join(root, "proj"), "--include", join(root, "proj/out"), "--no-ignore"],
      ["--include", join(root, "proj/out")],
      ["--attach", join(root, "proj"), "--include", ""],
    ];
    for (const extra of combos) {
      const home = tmp();
      const r = await run([...quiet, ...extra], { env: dev(home) });
      expect(r.code, extra.join(" ")).toBe(2);
      expect(r.err).toContain("--include");
      expect(r.err).toContain(help());
      expect(listSessions(home)).toEqual([]);
    }
    for (const cmd of [["list", "--no-ignore"], ["resume", "x", "--include", "a"]]) expect((await run(cmd, { env: dev(tmp()) })).code).toBe(2);
  });

  it("Launch from the shown set: preview prints the section, after .gitignore changes the launch uses what was shown", async () => {
    const root = fixture();
    const home = tmp();
    const pv = await run(["--attach", join(root, "proj"), "--include", join(root, "proj/pkg/gen"), "--preview-materials"], { env: dev(home) });
    expect(pv.code).toBe(0);
    expect(section(pv)).toEqual({ head: "Исключено правилами: 1", rows: [`  proj/out/ — ${RULE}out/`] });
    expect(pv.out.indexOf("Исключено правилами:")).toBeLessThan(pv.out.indexOf("Подготовленный набор:"));
    expect(pv.out).toContain("proj/pkg/gen/c.ts");
    expect(pv.out).not.toContain(MARK);
    expect(pv.out).not.toContain("proj/out/main.js");
    const id = /Подготовленный набор: ([0-9a-f]{32})/.exec(pv.out)![1]!;

    writeFileSync(join(root, "proj/.gitignore"), "src/\n");
    const r = await run([...asking("нет в папке владельца"), "--prepared-materials", id], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(section(r)).toEqual(section(pv));
    expect(workspaceFiles(home)).toEqual(["proj/README.md", "proj/pkg/d.ts", "proj/pkg/gen/c.ts", "proj/src/a.ts"]);

    for (const extra of [["--include", join(root, "proj/out")], ["--no-ignore"]]) {
      const bad = await run([...quiet, "--prepared-materials", id, ...extra], { env: dev(home) });
      expect(bad.code).toBe(2);
      expect(bad.err).toContain("набор уже подготовлен");
    }
  });

  it("Return by the printed name: the name from the section is accepted from any current folder; with two folders of the same name — exit code 2", async () => {
    const one = fixture(), other = fixture();
    const home = tmp();
    const r = await run([...quiet, "--attach", join(one, "proj"), "--include", "proj/out/"], { env: dev(home) });
    expect(r.code).toBe(0);
    expect(section(r)!.rows).toEqual([`  proj/pkg/gen/ — ${RULE}gen/`]);
    expect(workspaceFiles(home)).toContain("proj/out/assets/b.js");

    const home2 = tmp();
    const twice = await run([...quiet, "--attach", join(one, "proj"), "--attach", join(other, "proj"), "--include", "proj/out/"], { env: dev(home2) });
    expect(twice.code).toBe(2);
    expect(twice.err).toContain("укажите абсолютный путь");
    expect(listSessions(home2)).toEqual([]);
  });

  it("Return by the printed name: ambiguity does not depend on the current folder", () => {
    const roots = ["/a/proj", "/b/proj"];
    for (const cwd of ["/a", "/b", "/c"]) expect(() => includePaths(["proj/out/"], roots, cwd), cwd).toThrow(/укажите абсолютный путь/);
    expect(includePaths(["/b/proj/out", "proj/out/x.js", "../a/proj/out"], ["/a/proj"], "/b")).toEqual(["/b/proj/out", "/a/proj/out/x.js", "/a/proj/out"]);
    expect(includePaths(["out/main.js"], ["/a/proj"], "/a/proj")).toEqual(["/a/proj/out/main.js"]);
  });

  it("Distinguishable names of same-named folders: return by the suffixed name from any folder", () => {
    const x = tmp();
    const a = join(x, "a", "proj");
    const b = join(x, "b", "proj");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const other = tmp();
    expect(includePaths(["proj (2)/out/"], [a, b], other)).toEqual([join(b, "out/")]);
    expect(() => includePaths(["proj/out/"], [a, b], other)).toThrow(/укажите абсолютный путь/);
  });

  it("help describes --include, --no-ignore and the rule 'an explicit file is not excluded'", () => {
    for (const t of ["--include <путь>", "--no-ignore", "явно указанный в --attach файл правилами не исключается", "Исключено правилами"]) expect(help()).toContain(t);
    expect(help()).not.toContain(".gitignore не разбирается");
  });
});

describe("council: accumulated session spend with continuation", () => {
  it("Accumulated session metrics: failure of turn 2 before the continuation counts toward 270 tokens and the cap", async () => {
    const home = tmp();
    const ac = new AbortController();
    let n = 0;
    // turn 2: invalid answer of 250 tokens, the retry cut short by a stop
    const p2First = {
      call: () => {
        if (n++ === 0) return Promise.resolve({ text: "это не JSON", usage: { inputTokens: 150, outputTokens: 100 } });
        ac.abort();
        return new Promise<never>(() => {});
      },
    };
    const session = createSession(
      {
        topic: "Как назвать кота", framing: "", origin: "cli",
        limits: { maxRounds: 2, turnTimeoutSec: 30, contextChars: 20000, maxTotalTokens: 270 },
        participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })),
      },
      { maxParticipants: 8, id: "f1" },
    );
    await runStoredSession({
      session, dataDir: home, signal: ac.signal,
      drivers: { p1: createScriptedDriver({ steps: [{ response: { stance: "amend", reasoning: "r", solution: "v1", answers: [], questions: [] } }] }, { COUNCIL_DEV: "1" }), p2: p2First },
    });
    const plan = planResume(home, "f1", { isAlive: () => false });
    const valid = JSON.stringify({ stance: "object", reasoning: "r", solution: null, answers: [], questions: [] });
    await runResumedSession({
      dataDir: home, plan, isAlive: () => false,
      drivers: {
        p1: createScriptedDriver({ steps: [] }, { COUNCIL_DEV: "1" }),
        p2: { call: async () => ({ text: valid, usage: { inputTokens: 10, outputTokens: 10 } }) },
      },
    });
    const refused = await run(["resume", "f1", "--max-tokens", "270"], { env: dev(home) });
    const shown = await run(["show", "f1"], { env: dev(home) });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("новый потолок токенов 270 не выше уже израсходованного 270");
    expect(shown.out).toMatch(/Причина: token_cap/);
    expect(shown.out).toMatch(/токены 160 \/ 110/);
  });
});

describe("council: spend of the failure in the previous segment and the file request", () => {
  const stepOf = (response: object, usage?: { inputTokens: number; outputTokens: number }) => ({ response, ...usage });
  const amendOf = (t: string) => ({ stance: "amend", reasoning: "довод", solution: t, answers: [], questions: [] });
  const agreeOf = { stance: "agree", reasoning: "согласен", solution: null, answers: [], questions: [] };
  const scenarioWith = (steps: object[]) => {
    const f = join(tmp(), "steps.json");
    writeFileSync(f, JSON.stringify({ steps }));
    return f;
  };

  it("Accumulated session metrics: the spend line after the turn sees the file request tokens", async () => {
    const dir = realpathSync(tmp());
    writeFileSync(join(dir, "a.txt"), "текст файла");
    const home = tmp();
    // p1: file request of 1000 tokens, then two failures without spend and a dropout; p1's turns not completed
    const p1 = scenarioWith([
      stepOf({ stance: "object", reasoning: "нужен файл", solution: null, answers: [], questions: [], files: ["a.txt"] }, { inputTokens: 600, outputTokens: 400 }),
      { error: "таймаут", retryable: true },
      { error: "таймаут", retryable: true },
    ]);
    // p2: finished turn without tokens
    const p2 = scenarioWith([stepOf(amendOf("v1"))]);
    const p3 = scenarioWith([stepOf({ stance: "object", reasoning: "возражаю", solution: null, answers: [], questions: [] })]);
    const r = await run(
      [...base, "--participant", `scripted:${p1}`, "--participant", `scripted:${p2}`, "--participant", `scripted:${p3}`, "--max-rounds", "1", "--attach", dir],
      { env: dev(home) },
    );
    const spend = r.out.split("\n").filter((l) => l.startsWith("Расход:"));
    expect(spend.length).toBeGreaterThan(0);
    expect(spend[0]).toMatch(/^Расход: 1000 токенов, потолка нет/);
    expect(r.out).not.toContain("участники не сообщают токены");
  });
});

describe("Shared log: loading settings per council command", () => {
  const settingsLines = (home: string) => readFileSync(join(home, "logs", "app.log"), "utf8").split("\n").filter((l) => l.includes("Settings loaded"));
  const logText = (home: string) => readFileSync(join(home, "logs", "app.log"), "utf8");

  it("providers and run write one 'Settings loaded' line, templates and lineups — none", async () => {
    const key = "sk-log-quit-cli-117";
    const home = tmp();
    expect((await run(["providers"], { env: dev(home, { OPENAI_API_KEY: key }) })).code).toBe(0);
    expect(settingsLines(home)).toEqual([expect.stringMatching(new RegExp(` INFO \\[cli\\] Settings loaded: .*config\\.json, providers: 0$`))]);
    expect(settingsLines(home)[0]).toContain(configPath(home));
    expect(logText(home)).toContain("Start: council providers");
    expect(logText(home)).toContain("Exit: code 0");
    expect(logText(home)).not.toContain(key);

    for (const cmd of ["templates", "lineups"]) {
      const h = tmp();
      expect((await run([cmd], { env: dev(h) })).code).toBe(0);
      expect(settingsLines(h)).toEqual([]);
      expect(logText(h)).toContain(`Start: council ${cmd}`);
      expect(logText(h)).toContain("Exit: code 0");
    }

    const r = tmp();
    expect((await run([...base, ...two(), "--max-rounds", "3"], { env: dev(r) })).code).toBe(0);
    expect(settingsLines(r)).toHaveLength(1);
  });
});

describe("council resume --message", () => {
  const bytes = (home: string, id: string) => readFileSync(eventsPath(home, id));
  const step = (stance: string, solution: string | null) => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });
  // Round 1 ends in consensus; the scenarios keep agreeing after it.
  const seed = async (home: string) => {
    const f = (name: string, steps: unknown[]) => { const p = join(home, name); writeFileSync(p, JSON.stringify({ steps })); return `scripted:${p}`; };
    const r = await run([...base, ...parts(f("p1.json", [step("amend", "v1"), step("agree", null), step("agree", null)]), f("p2.json", [step("agree", null), step("agree", null), step("agree", null)])), "--max-rounds", "3"], { env: dev(home) });
    expect(r.code).toBe(0);
    return idOf(r.out);
  };

  it("invalid --message: empty, whitespace, repeated, on another command — exit code 2 with help, journal unchanged", async () => {
    const home = tmp();
    const id = await seed(home);
    const before = bytes(home, id);
    const cases: [string[], string][] = [
      [["resume", id, "--message", ""], "--message"],
      [["resume", id, "--message", "  \t "], "--message"],
      [["resume", id, "--message", "a", "--message", "b"], "--message"],
      [["show", id, "--message", "a"], "--message принимается только командой resume"],
      [["say", id, "x", "--message", "a"], "--message принимается только командой resume"],
    ];
    for (const [argv, why] of cases) {
      const r = await run(argv, { env: dev(home) });
      expect([r.code, argv]).toEqual([2, argv]);
      expect(r.err).toContain(why);
      expect(r.err).toContain(help());
    }
    expect(bytes(home, id).equals(before)).toBe(true);
  });

  it("consensus without --message: exit code 2, reason names consensus and --message in ru and en, journal unchanged", async () => {
    const home = tmp();
    const id = await seed(home);
    const before = bytes(home, id);
    const ru = await run(["resume", id], { env: dev(home) });
    expect(ru.code).toBe(2);
    expect(ru.err).toContain("согласие достигнуто: продолжить можно только с репликой владельца");
    expect(ru.err).toContain(`council resume ${id} --message`);
    const lang = getProcessLanguage();
    setProcessLanguage("en");
    try {
      const en = await run(["resume", id], { env: dev(home) });
      expect(en.code).toBe(2);
      expect(en.err).toContain("consensus reached: it can be resumed only with an owner message");
      expect(en.err).toContain(`council resume ${id} --message`);
    } finally {
      setProcessLanguage(lang);
    }
    expect(bytes(home, id).equals(before)).toBe(true);
  });

  it("consensus with --message: the owner message is printed before the turns, numbering continues, show has it between turns", async () => {
    const home = tmp();
    const id = await seed(home);
    const r = await run(["resume", id, "--rounds", "1", "--message", "Учтите ещё бюджет"], { env: dev(home) });
    expect(r.code).toBe(0);
    const at = (s: string) => r.out.indexOf(s);
    expect(r.out).toContain(`Продолжение сессии ${id}: ещё кругов 1 (общий лимит 2), не более 6 вызовов моделей (активных участников 2 × 1 × 3).`);
    expect(at("Продолжение сессии")).toBeLessThan(at("── Владелец · o1 · после хода 2"));
    expect(at("── Владелец · o1 · после хода 2")).toBeLessThan(at("Учтите ещё бюджет"));
    expect(at("Учтите ещё бюджет")).toBeGreaterThan(at("— Продолжено"));
    expect(at("Учтите ещё бюджет")).toBeLessThan(at("── Ход 3 · круг 2 · p1"));
    expect(r.out).toContain("── Ход 4 · круг 2 · p2");
    expect(r.out).toContain("══ Итог: consensus");
    const evs = readEvents(home, id)!.events;
    const i = evs.findIndex((e) => e.type === "session_resumed");
    expect(evs[i + 1]).toMatchObject({ type: "owner_message", id: "o1", text: "Учтите ещё бюджет", afterTurn: 2 });
    const sh = await run(["show", id], { env: dev(home) });
    expect(sh.out.indexOf("── Ход 2 ")).toBeLessThan(sh.out.indexOf("Учтите ещё бюджет"));
    expect(sh.out.indexOf("Учтите ещё бюджет")).toBeLessThan(sh.out.indexOf("── Ход 3 "));
  });
});

describe("Отказ хода из-за несовпадения закрепления: council show", () => {
  it("Отказ хода из-за несовпадения закрепления: a guard reason is printed verbatim as a failed turn, with no retry and no completed turn after it", async () => {
    const home = tmp();
    const ts = "2026-01-01T00:00:00.000Z";
    const reason = "Закреплённый claude 9.1.0: контрольная сумма не совпала: у /d/cli/claude/9.1.0/bin/claude abc, ожидалась def; бинарник из PATH не используется";
    const id = "guard";
    createSessionJournal(home, id);
    const events = [
      { type: "session_created", pid: 1, session: { id, createdAt: ts, origin: "cli", topic: "Тема", templateId: null, framing: "", participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })), limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 } } },
      { type: "turn_started", turn: 1, round: 1, participantId: "p1" },
      { type: "turn_failed", turn: 1, round: 1, participantId: "p1", attempt: 1, kind: "call_error", message: reason },
      { type: "participant_dropped", participantId: "p1", reason: `Ошибка вызова без повтора: ${reason}` },
    ];
    events.forEach((e, i) => appendEvent(home, id, { seq: i + 1, ts, ...e } as SessionEvent));
    const r = await run(["show", id], { env: { COUNCIL_HOME: home, COUNCIL_DEV: "1" } });
    expect(r.outLines.filter((l) => l.startsWith("✗ Ход 1 · p1"))).toEqual([`✗ Ход 1 · p1 «n1» · попытка 1 · call_error: ${reason}`]);
    expect(r.out).toContain("✗ p1 «n1» выбыл: Ошибка вызова без повтора: Закреплённый claude 9.1.0: контрольная сумма не совпала");
    expect(r.out).not.toContain("попытка 2");
  });
});
