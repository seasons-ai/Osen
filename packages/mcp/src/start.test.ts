import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { setProcessLanguage, createLogger, FOLDER_LIMITS, listSessions, loadTemplates, readSession, readEvents, requestStop } from "@model-council/core";
import type { CliLocation } from "@model-council/core";
import { configPath, initialRegistry, lineupsPath, saveLineup } from "@model-council/core";
import { main } from "../../core/src/cli.ts";
import { writeExecutable } from "../../core/src/executable.testutil.ts";
import { cleanupActiveLaunches, councilStart } from "./start.ts";
import { makeImageOnlyPdf, makePdf } from "../../core/src/pdf/fixture.ts";
import { councilStatus } from "./status.ts";
import type { StartView } from "./start.ts";
import { ToolError } from "./context.ts";
import type { ToolContext } from "./context.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-")); tmps.push(d); return d; };
// Sessions run in detached executors: stop what is still running and wait for the executor pids to exit before the folders are removed.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
afterAll(async () => {
  for (const d of tmps) {
    for (const s of listSessions(d)) {
      if (s.status !== "running") continue;
      const pid = readSession(d, s.id)?.state.pid ?? null;
      requestStop(d, s.id);
      for (let i = 0; i < 200 && pid !== null && alive(pid); i++) await sleep(50);
    }
  }
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
}, 30_000);

const templatesDir = join(import.meta.dirname, "../../../templates");
const scenariosDir = join(import.meta.dirname, "../../core/scenarios");
const councilLaunch = { command: process.execPath, args: [join(import.meta.dirname, "../../core/src/council.ts")], env: {} };
const FIX = join(import.meta.dirname, "../../core/src/cli-agents/fixtures");

const notFound = async (agent: "claude" | "codex"): Promise<CliLocation> => ({ agent, found: false, searchPath: "", reason: `Команда ${agent} не найдена` });

function ctxOf(over: Partial<ToolContext> = {}): ToolContext {
  const dataDir = over.dataDir ?? tmp();
  const env = over.env ?? { COUNCIL_DEV: "1" };
  return {
    dataDir, env, logger: createLogger(dataDir, "mcp", env), builtinTemplatesDir: templatesDir, scenariosDir,
    shutdown: new AbortController().signal, councilLaunch, inspectDeps: { locate: notFound }, ...over,
  };
}

const start = (ctx: ToolContext, input: Parameters<typeof councilStart.run>[1]) => councilStart.run(ctx, input) as Promise<StartView>;
const sc = (n: string) => ({ providerId: "scripted", model: n });
const two = [sc("consensus/p1.json"), sc("consensus/p2.json")];

async function until<T>(what: string, f: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`waited 20000 ms for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const finished = (ctx: ToolContext, id: string) => until("session finished", () => { const s = readSession(ctx.dataDir, id); return s && s.state.finish !== null ? s : null; });

async function rejectsTool(ctx: ToolContext, input: Parameters<typeof councilStart.run>[1], re: RegExp) {
  const e = await start(ctx, input).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ToolError);
  expect((e as Error).message).toMatch(re);
  expect(listSessions(ctx.dataDir)).toEqual([]);
}

function cliStub(agent: "claude" | "codex") {
  const root = tmp();
  const help = join(FIX, agent === "claude" ? "claude-2.1.288-help.txt" : "codex-0.159.2-exec-help.txt");
  const c = JSON.stringify({ stance: "agree", reasoning: "r", solution: null, answers: [], questions: [] });
  const out = agent === "claude"
    ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "t", structured_output: JSON.parse(c), usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 })
    : [{ type: "item.completed", item: { id: "i", type: "agent_message", text: c } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }].map((e) => JSON.stringify(e)).join("\n");
  writeFileSync(join(root, "out"), out);
  const path = join(root, agent);
  writeExecutable(path, `#!/bin/sh
D="$(dirname "$0")"
case "$1" in
  --version) echo '${agent === "claude" ? "2.1.288 (Claude Code)" : "codex-cli 0.159.2"}'; exit 0;;
  --help) /bin/cat '${help}'; exit 0;;
  features) /bin/cat '${join(FIX, "codex-0.159.2-features.txt")}'; exit 0;;
esac
if [ "$1" = exec ] && [ "$2" = --help ]; then /bin/cat '${help}'; exit 0; fi
cat > /dev/null
cat "$D/out"
`);
  return async (a: "claude" | "codex"): Promise<CliLocation> =>
    a === agent ? { agent, found: true, path, version: agent === "claude" ? "2.1.288" : "0.159.2", searchPath: process.env.PATH ?? "" } : notFound(a);
}

describe("council_start", () => {
  it("1. two scripted participants: sessionId immediately, reaches consensus", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "Как назвать кота", participants: two });
    const s = readSession(ctx.dataDir, v.sessionId)!;
    expect(s.state.session).toMatchObject({ origin: "mcp", topic: "Как назвать кота" });
    expect(s.state.session!.participants.map((p) => [p.providerId, p.model, p.name])).toEqual([
      ["scripted", "consensus/p1.json", "Сценарный (consensus/p1.json)"], ["scripted", "consensus/p2.json", "Сценарный (consensus/p2.json)"],
    ]);
    expect(v.participants.map((p) => p.id)).toEqual(s.state.session!.participants.map((p) => p.id));
    expect(v.maxCalls).toBe(30);
    expect((await finished(ctx, v.sessionId)).status).toBe("consensus");
  });

  it("2. topic only: participants and limit from the registry, neutral frame", async () => {
    const dataDir = tmp();
    const inspectDeps = { locate: cliStub("claude"), listModels: async () => ({ models: [], confirmed: true }) };
    const codex = cliStub("codex");
    const both = async (a: "claude" | "codex") => (a === "claude" ? inspectDeps.locate(a) : codex(a));
    const deps = { ...inspectDeps, locate: both };
    // the CLI stubs cannot be handed to a separate process: the executor runs in this one
    const ctx = ctxOf({ dataDir, inspectDeps: deps, spawnExecutor: async (file, errPath) => main(["run-prepared", file], { stdout: () => {}, stderr: (t) => appendFileSync(errPath, t), env: { COUNCIL_HOME: dataDir }, inspectDeps: deps }) });
    const v = await start(ctx, { topic: "Тема по умолчанию" });
    const reg = JSON.parse(readFileSync(configPath(dataDir), "utf8"));
    expect(v.templateId).toBeNull();
    expect(v.maxRounds).toBe(reg.defaults.maxRounds);
    expect(v.participants.map((p) => [p.providerId, p.model])).toEqual(reg.defaults.participants.map((p: { providerId: string; model: string }) => [p.providerId, p.model]));
    const first = readEvents(dataDir, v.sessionId)!.events[0] as { type: string; session: { framing: string } };
    expect(first.type).toBe("session_created");
    expect(first.session.framing).toBe(loadTemplates({ builtinDir: templatesDir, userDir: join(dataDir, "templates") }).neutralFraming);
    await finished(ctx, v.sessionId);
  });

  it("3. template and three participants: the template's frame and roles", async () => {
    const ctx = ctxOf();
    const t = loadTemplates({ builtinDir: templatesDir, userDir: join(ctx.dataDir, "templates") }).templates.find((x) => x.roles.length >= 3)!;
    const v = await start(ctx, { topic: "Тема", templateId: t.id, participants: ["p1", "p2", "p3"].map((p) => sc(`no-consensus/${p}.json`)) });
    const s = readSession(ctx.dataDir, v.sessionId)!.state.session!;
    expect(s.framing).toBe(t.framing);
    expect(s.participants.map((p) => p.role)).toEqual(t.roles.slice(0, 3));
    expect(v.templateId).toBe(t.id);
    expect(v.maxCalls).toBe(3 * v.maxRounds * 3);
    await finished(ctx, v.sessionId);
  });

  describe("4. errors without creating a session", () => {
    it("empty topic", async () => rejectsTool(ctxOf(), { topic: "  ", participants: two }, /Тема/));
    it("language: empty topic on en — English text without Cyrillic, no session created", async () => {
      setProcessLanguage("en");
      try {
        const ctx = ctxOf();
        const e = await start(ctx, { topic: "  ", participants: two }).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(ToolError);
        expect((e as Error).message).not.toMatch(/[А-Яа-яЁё]/);
        expect((e as Error).message).toMatch(/topic/i);
        expect(listSessions(ctx.dataDir)).toEqual([]);
        await rejectsTool(ctx, { topic: "т", lineupId: "x", participants: two }, /incompatible/);
      } finally { setProcessLanguage("ru"); }
    });
    it("unknown template", async () => rejectsTool(ctxOf(), { topic: "т", templateId: "нет-такого", participants: two }, /нет-такого/));
    it("unknown provider", async () => rejectsTool(ctxOf(), { topic: "т", participants: [sc("consensus/p1.json"), { providerId: "ghost" }] }, /«ghost»/));
    it("unavailable provider", async () => {
      const dataDir = tmp();
      writeFileSync(configPath(dataDir), JSON.stringify(initialRegistry(["claude", "codex"]), null, 2));
      await rejectsTool(ctxOf({ dataDir }), { topic: "т", participants: [{ providerId: "claude" }, sc("consensus/p1.json")] }, /Claude Code.*недоступен: .*не найдена/);
    });
    it("one participant", async () => rejectsTool(ctxOf(), { topic: "т", participants: [sc("consensus/p1.json")] }, /не меньше 2/));
    it("maxRounds 0 and 21", async () => {
      await rejectsTool(ctxOf(), { topic: "т", participants: two, maxRounds: 0 }, /от 1 до 20/);
      await rejectsTool(ctxOf(), { topic: "т", participants: two, maxRounds: 21 }, /от 1 до 20/);
    });
    it("unknown scenario", async () => rejectsTool(ctxOf(), { topic: "т", participants: [sc("consensus/p1.json"), sc("нет.json")] }, /Сценарий «нет.json» недоступен/));
    it("scripted with scenariosDir null: the error names COUNCIL_DEV (ru and en), no session created", async () => {
      const ctx = ctxOf({ scenariosDir: null });
      await rejectsTool(ctx, { topic: "т", participants: two }, /^Сценарные участники доступны только при COUNCIL_DEV=1\.$/);
      await rejectsTool(ctx, { topic: "т", participants: [sc("consensus/p1.json"), sc("нет.json")] }, /COUNCIL_DEV/);
      setProcessLanguage("en");
      try {
        await rejectsTool(ctx, { topic: "т", participants: two }, /^Scripted participants are available only with COUNCIL_DEV=1\.$/);
      } finally { setProcessLanguage("ru"); }
      expect(listSessions(ctx.dataDir)).toEqual([]);
    });
    it("explicit empty participants with providers in the registry: minimum 2, got 0 (ru and en)", async () => {
      const dataDir = tmp();
      writeFileSync(configPath(dataDir), JSON.stringify(initialRegistry(["claude", "codex"]), null, 2));
      const ctx = ctxOf({ dataDir });
      await rejectsTool(ctx, { topic: "т", participants: [] }, /^Нужно не меньше 2 участников, получено 0\.$/);
      setProcessLanguage("en");
      try {
        await rejectsTool(ctx, { topic: "т", participants: [] }, /^At least 2 participants are required, got 0\.$/);
      } finally { setProcessLanguage("ru"); }
      expect(listSessions(dataDir)).toEqual([]);
    });
    it("participants not set, the registry has no providers and no default participants: nothing to take from; explicit [] — got 0", async () => {
      const dataDir = tmp();
      const empty = initialRegistry([]);
      writeFileSync(configPath(dataDir), JSON.stringify(empty, null, 2));
      const ctx = ctxOf({ dataDir });
      await rejectsTool(ctx, { topic: "т" }, /Участников взять неоткуда/);
      await rejectsTool(ctx, { topic: "т", participants: [] }, /получено 0/);
    });
  });

  it("5. a discussion participant does not convene a discussion", async () => {
    await rejectsTool(ctxOf({ env: { COUNCIL_DEV: "1", COUNCIL_PARTICIPANT: "1" } }), { topic: "т", participants: two }, /Участник обсуждения не может/);
  });

  it("6. maxRounds is passed to the session", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "т", participants: two, maxRounds: 2 });
    expect(v.maxRounds).toBe(2);
    expect(v.maxCalls).toBe(12);
    expect(readSession(ctx.dataDir, v.sessionId)!.state.session!.limits.maxRounds).toBe(2);
    await finished(ctx, v.sessionId);
  });

  it("7. maxCalls: three participants and maxRounds 3 give 27", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "т", participants: ["p1", "p2", "p3"].map((p) => sc(`no-consensus/${p}.json`)), maxRounds: 3 });
    expect(v.maxCalls).toBe(27);
    expect(v.next).toContain("maxCalls");
    await finished(ctx, v.sessionId);
  });
});

describe("council_start: materials", () => {
  const real = () => realpathSync(tmp());
  const put = (dir: string, files: Record<string, string | Uint8Array>) => {
    for (const [n, t] of Object.entries(files)) { mkdirSync(join(dir, n, ".."), { recursive: true }); writeFileSync(join(dir, n), t); }
  };
  const three = ["p1", "p2", "p3"].map((p) => sc(`no-consensus/${p}.json`));
  const appLog = (ctx: ToolContext) => readFileSync(join(ctx.dataDir, "logs/app.log"), "utf8");

  it("1. a file and a folder: three materials, snapshots are in the session", async () => {
    const ctx = ctxOf(); const fx = real();
    put(fx, { "a.txt": "альфа", "dir/b.txt": "бета-бета", "dir/c.txt": "гамма" });
    const v = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "a.txt"), join(fx, "dir")] });
    expect(v.materials).toEqual({ count: 3, chars: "альфа".length + "бета-бета".length + "гамма".length, skipped: [], left: { count: 0, items: [] } });
    expect(v.folder).toEqual({ files: 2, chars: "бета-бета".length + "гамма".length });
    const s = readSession(ctx.dataDir, v.sessionId)!;
    expect(s.state.session!.materials!.map((m) => m.name)).toEqual(["a.txt", "dir/b.txt", "dir/c.txt"]);
    const snap = (n: number) => readFileSync(join(ctx.dataDir, "sessions", v.sessionId, "materials", `m${n}.txt`), "utf8");
    expect([snap(1), snap(2), snap(3)]).toEqual(["альфа", "бета-бета", "гамма"]);
    expect(v.next).toContain("materials");
    await finished(ctx, v.sessionId);
  });

  it("2. without attachments and with an empty list: the previous behaviour", async () => {
    for (const extra of [{}, { attachments: [] }]) {
      const ctx = ctxOf();
      const v = await start(ctx, { topic: "т", participants: two, ...extra });
      expect(v.materials).toEqual({ count: 0, chars: 0, skipped: [], left: { count: 0, items: [] } });
      expect(readSession(ctx.dataDir, v.sessionId)!.state.session).not.toHaveProperty("materials");
      expect(existsSync(join(ctx.dataDir, "sessions", v.sessionId, "materials"))).toBe(false);
      expect(v.next).not.toContain("materials");
      await finished(ctx, v.sessionId);
    }
  });

  it("3. relative paths are rejected, all are listed", async () => {
    await rejectsTool(ctxOf(), { topic: "т", participants: two, attachments: ["src/a.ts"] }, /src\/a\.ts[^]*абсолютн|абсолютн[^]*src\/a\.ts/);
    const fx = real(); put(fx, { "ok.txt": "x" });
    await rejectsTool(ctxOf(), { topic: "т", participants: two, attachments: [join(fx, "ok.txt"), "src/a.ts", "./b.md"] }, /src\/a\.ts[^]*\.\/b\.md/);
  });

  it("4. several reasons: path not found and .env.local, no secret in the error", async () => {
    const fx = real(); put(fx, { ".env.local": "TOKEN=СЕКРЕТ-16" });
    const ctx = ctxOf();
    const e = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "нет.txt"), join(fx, ".env.local")] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    const m = (e as ToolError).message;
    expect(m).toContain("нет.txt");
    expect(m).toContain(".env.local");
    expect(m).not.toContain("СЕКРЕТ-16");
    expect(listSessions(ctx.dataDir)).toEqual([]);
    expect((e as ToolError).logText).toMatch(/reasons 2/);
    expect((e as ToolError).logText).not.toContain(fx);
  });

  it("Exclusion by .gitignore rules: the response has the name and reason without excludedPath and an absolute path", async () => {
    const fx = real();
    put(fx, { "dir/.gitignore": "out/\n", "dir/b.txt": "ТЕКСТ-B-16", "dir/out/main.js": "ТЕКСТ-OUT-16" });
    const v = await start(ctxOf(), { topic: "т", participants: two, attachments: [join(fx, "dir")] });
    expect(v.materials.count).toBe(1);
    expect(v.materials.skipped).toEqual([{ name: "dir/.gitignore", reason: "скрытое имя" }, { name: "dir/out/", reason: "исключён правилом .gitignore: out/" }]);
    const j = JSON.stringify(v);
    expect(j).not.toContain("excludedPath");
    expect(j).not.toContain(fx);
    expect(j).not.toContain("ТЕКСТ-");
  });

  it("5. skips: node_modules and a binary file, no texts or paths in the response", async () => {
    const fx = real();
    put(fx, { "dir/b.txt": "ТЕКСТ-B-16", "dir/node_modules/x.txt": "ТЕКСТ-X-16", "dir/bin.dat": Buffer.from([65, 0, 66]) });
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "dir")] });
    expect(v.materials.count).toBe(1);
    expect(v.materials.skipped.find((x) => x.name.endsWith("node_modules"))!.reason).toMatch(/в списке игнорирования/);
    expect(v.materials.skipped.find((x) => x.name.endsWith("bin.dat"))!.reason).toMatch(/двоичный файл неизвестного формата/);
    const j = JSON.stringify(v);
    expect(j).not.toContain("ТЕКСТ-");
    expect(j).not.toContain(fx);
    await finished(ctx, v.sessionId);
  });

  it("6. limit exceeded: size, limit and the largest file, no session", async () => {
    const dataDir = tmp();
    const reg = initialRegistry([]);
    writeFileSync(configPath(dataDir), JSON.stringify({ ...reg, defaults: { ...reg.defaults, materialsChars: 1 } }));
    const fx = real(); put(fx, { "big.txt": "длинный текст" });
    await rejectsTool(ctxOf({ dataDir }), { topic: "т", participants: two, attachments: [join(fx, "big.txt")] }, /лимит 1[^]*big\.txt|big\.txt[^]*лимит 1/);
  });

  it("7a. PDF: text layer in an attachment; scanned — refusal, no session", async () => {
    const ctx = ctxOf(); const fx = real();
    put(fx, { "a.pdf": makePdf(["Первая страница", "Вторая страница"]), "scan.pdf": makeImageOnlyPdf() });
    const v = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "a.pdf")] });
    expect(v.materials.count).toBe(1);
    expect(v.materials.chars).toBe("Первая страница\n\nВторая страница".length);
    await finished(ctx, v.sessionId);
    const ctx2 = ctxOf();
    await rejectsTool(ctx2, { topic: "т", participants: two, attachments: [join(fx, "scan.pdf")] }, /не найден текст/);
    expect(listSessions(ctx2.dataDir)).toEqual([]);
  }, 30_000);

  it("7. three participants, three rounds: maxCalls 27", async () => {
    const ctx = ctxOf(); const fx = real(); put(fx, { "a.txt": "а" });
    const v = await start(ctx, { topic: "т", participants: three, maxRounds: 3, attachments: [join(fx, "a.txt")] });
    expect(v.maxCalls).toBe(27);
    await finished(ctx, v.sessionId);
  });

  it("8. journal: no labels or paths, the count and size are present; errors' logText without paths", async () => {
    const ctx = ctxOf(); const fx = real();
    put(fx, { "a.txt": "МЕТКА-ЖУРНАЛ-16" });
    const v = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "a.txt")] });
    await finished(ctx, v.sessionId);
    const missing = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "нет.txt")] }).catch((x: unknown) => x) as ToolError;
    const rel = await start(ctx, { topic: "т", participants: two, attachments: ["src/a.ts"] }).catch((x: unknown) => x) as ToolError;
    for (const e of [missing, rel]) {
      expect(e.logText).toMatch(/\d/);
      expect(e.logText).not.toMatch(/нет\.txt|a\.ts/);
      expect(e.logText).not.toContain(fx);
    }
    const log = appLog(ctx);
    expect(log).not.toContain("МЕТКА-ЖУРНАЛ-16");
    expect(log).not.toContain(fx);
    expect(log).toMatch(/materials 1, size 15/);
  });
});

describe("council_start: token cap", () => {
  const cap = [sc("token-cap/p1.json"), sc("token-cap/p2.json")];
  const withDefault = (n: number) => {
    const dataDir = tmp();
    const reg = initialRegistry([]);
    reg.defaults.maxTotalTokens = n;
    writeFileSync(configPath(dataDir), JSON.stringify(reg));
    return ctxOf({ dataDir });
  };
  const appLog = (ctx: ToolContext) => readFileSync(join(ctx.dataDir, "logs/app.log"), "utf8");

  it("1. explicit cap: in the response, in the session, token_cap stop after the third turn", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "т", participants: cap, maxRounds: 5, maxTotalTokens: 1200 });
    expect(v.maxTotalTokens).toBe(1200);
    const s = await finished(ctx, v.sessionId);
    expect(s.state.session!.limits.maxTotalTokens).toBe(1200);
    expect(s.status).toBe("stopped");
    expect(s.state.finish!.reason).toBe("token_cap");
    expect(s.state.turns).toHaveLength(3);
  });

  it("2. default cap from the registry", async () => {
    const ctx = withDefault(20000);
    const v = await start(ctx, { topic: "т", participants: two });
    expect(v.maxTotalTokens).toBe(20000);
    await finished(ctx, v.sessionId);
  });

  it("3. an explicit value beats the registry", async () => {
    const ctx = withDefault(20000);
    const v = await start(ctx, { topic: "т", participants: two, maxTotalTokens: 777 });
    expect(v.maxTotalTokens).toBe(777);
    expect(readSession(ctx.dataDir, v.sessionId)!.state.session!.limits.maxTotalTokens).toBe(777);
    await finished(ctx, v.sessionId);
  });

  it("4. neither a value nor a registry: null and no field in limits", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "т", participants: two });
    expect(v.maxTotalTokens).toBeNull();
    await finished(ctx, v.sessionId);
    expect("maxTotalTokens" in readSession(ctx.dataDir, v.sessionId)!.state.session!.limits).toBe(false);
  });

  it("5. invalid value: refusal, no sessions", async () => {
    for (const n of [0, -5, 1.5]) await rejectsTool(ctxOf(), { topic: "т", participants: two, maxTotalTokens: n }, /целым числом не меньше 1/);
  });

  it("6. maxCalls does not depend on the cap", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "т", participants: cap, maxRounds: 4, maxTotalTokens: 1200 });
    expect(v.maxCalls).toBe(2 * 4 * 3);
    await finished(ctx, v.sessionId);
  });

  it("7. the app journal names the cap or its absence", async () => {
    const a = ctxOf(); const b = ctxOf();
    await finished(a, (await start(a, { topic: "т", participants: two, maxTotalTokens: 1200 })).sessionId);
    await finished(b, (await start(b, { topic: "т", participants: two })).sessionId);
    expect(appLog(a)).toContain("token cap 1200");
    expect(appLog(b)).toContain("no token cap");
  });
});

describe("council_start: waiting for the owner", () => {
  const ev = (ctx: ToolContext, id: string) => readEvents(ctx.dataDir, id)!.events as unknown as { type: string; reason?: string }[];
  const types = (ctx: ToolContext, id: string) => ev(ctx, id).map((e) => e.type);

  it("1. without fields: ownerWait null, the session is not in the journal, no owner_wait_*", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "т", participants: two });
    expect(v.ownerWait).toBeNull();
    expect(v.next).not.toContain("ожидание владельца");
    await finished(ctx, v.sessionId);
    expect("ownerWait" in readSession(ctx.dataDir, v.sessionId)!.state.session!).toBe(false);
    expect(types(ctx, v.sessionId).filter((t) => t.startsWith("owner_wait_"))).toEqual([]);
    expect(readFileSync(join(ctx.dataDir, "logs/app.log"), "utf8")).toContain("owner wait: none");
  });

  it("2. invalid deadline: refusal before the session is created", async () => {
    for (const n of [0, -5, 1.5, 86401]) await rejectsTool(ctxOf(), { topic: "т", participants: two, pauseAfterRound: true, ownerWaitSec: n }, /ownerWaitSec/);
  });

  it("3. deadline without the mode: refusal", async () => {
    await rejectsTool(ctxOf(), { topic: "т", participants: two, ownerWaitSec: 30 }, /только вместе/);
    await rejectsTool(ctxOf(), { topic: "т", participants: two, pauseAfterRound: false, ownerWaitSec: 30 }, /только вместе/);
  });

  it("4. finite pause: the wait expires, the discussion goes on by itself", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "т", participants: [sc("owner-wait/plain-p1.json"), sc("owner-wait/plain-p2.json")], maxRounds: 3, pauseAfterRound: true, ownerWaitSec: 1 });
    expect(v.ownerWait).toEqual({ pauseAfterRound: true, waitForOwner: false, timeoutSec: 1 });
    expect(v.next).toContain("Включено ожидание владельца (срок 1 с");
    await finished(ctx, v.sessionId);
    const e = ev(ctx, v.sessionId);
    const started = e.findIndex((x) => x.type === "owner_wait_started");
    const done = e.findIndex((x) => x.type === "owner_wait_finished");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(started);
    expect(e[done]!.reason).toBe("expired");
    expect(e.slice(done).some((x) => x.type === "turn_started")).toBe(true);
    expect(readFileSync(join(ctx.dataDir, "logs/app.log"), "utf8")).toContain("owner wait: pause after round yes, answer to a question no, timeout 1 s");
  });

  it("5. default deadline 300", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "т", participants: [sc("owner-wait/ask-p1.json"), sc("owner-wait/answer-p2.json")], waitForOwner: true });
    requestStop(ctx.dataDir, v.sessionId);
    expect(v.ownerWait).toEqual({ pauseAfterRound: false, waitForOwner: true, timeoutSec: 300 });
    expect(readSession(ctx.dataDir, v.sessionId)!.state.session!.ownerWait).toEqual({ waitForOwner: true });
    await finished(ctx, v.sessionId);
  });

  it("6. tool description", () => {
    for (const w of ["pauseAfterRound", "waitForOwner", "ownerWaitSec", "только по просьбе владельца"]) expect(councilStart.description).toContain(w);
  });
});

describe("council_start: folder snapshot", () => {
  const real = () => realpathSync(tmp());
  const put = (dir: string, files: Record<string, string | Uint8Array>) => {
    for (const [n, t] of Object.entries(files)) { mkdirSync(join(dir, n, ".."), { recursive: true }); writeFileSync(join(dir, n), t); }
  };
  const appLog = (ctx: ToolContext) => readFileSync(join(ctx.dataDir, "logs/app.log"), "utf8");
  const withLimit = (materialsChars: number) => {
    const dataDir = tmp();
    const reg = initialRegistry([]);
    writeFileSync(configPath(dataDir), JSON.stringify({ ...reg, defaults: { ...reg.defaults, materialsChars } }));
    return ctxOf({ dataDir });
  };
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

  it("a. folder larger than the limit: initial set, the rest in the snapshot, no texts or paths in the response", async () => {
    const ctx = ctxOf(); const fx = real();
    const code = (i: number) => `// ТЕКСТ-КОД-${i}\n` + "x".repeat(2980);
    const files: Record<string, string> = { "proj/README.md": "ТЕКСТ-README короткий" };
    for (let i = 0; i < 30; i++) files[`proj/src/f${String(i).padStart(2, "0")}.ts`] = code(i);
    put(fx, files);
    const chars = Object.values(files).reduce((n, t) => n + t.length, 0);
    const v = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "proj")] });
    expect(v.materials.count).toBe(1);
    expect(v.materials.left.count).toBe(30);
    expect(v.materials.left.items).toHaveLength(20);
    for (const it of v.materials.left.items) expect(it.reason).not.toBe("");
    expect(v.folder).toEqual({ files: 31, chars });
    expect(v.maxCalls).toBe(2 * v.maxRounds * 3);
    expect(v.next).toContain("folder");
    const s = readSession(ctx.dataDir, v.sessionId)!;
    expect(s.state.session!.workspace).toEqual({ files: 31, chars });
    expect(readFileSync(join(ctx.dataDir, "sessions", v.sessionId, "workspace/proj/src/f00.ts"), "utf8")).toBe(files["proj/src/f00.ts"]);
    const j = JSON.stringify(v);
    expect(j).not.toContain("ТЕКСТ-");
    expect(j).not.toContain(fx);
    expect(appLog(ctx)).toContain("snapshot files 31");
    await finished(ctx, v.sessionId);
  });

  it("b. a participant reads a file from the snapshot", async () => {
    const ctx = withLimit(1000); const fx = real();
    put(fx, { "sample/README.md": "Короткое описание", "sample/src/engine.ts": "export const x = 1;\n".repeat(150) });
    const v = await start(ctx, { topic: "т", participants: [sc("folder/p1.json"), sc("folder/p2.json")], attachments: [join(fx, "sample")] });
    expect(v.materials.left.count).toBe(1);
    const s = await finished(ctx, v.sessionId);
    expect(s.state.turns.some((t) => t.filesRead?.some((f) => f.name === "sample/src/engine.ts"))).toBe(true);
  });

  it("c. snapshot boundary: refusal, no session or traces", async () => {
    const ctx = ctxOf(); const fx = real();
    put(fx, { "huge/big.txt": "x".repeat(FOLDER_LIMITS.snapshotChars + 1) });
    const e = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "huge")] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ToolError);
    const m = (e as ToolError).message;
    expect(m).toContain(String(FOLDER_LIMITS.snapshotChars + 1));
    expect(m).toContain(String(FOLDER_LIMITS.snapshotChars));
    expect(listSessions(ctx.dataDir)).toEqual([]);
    const dir = join(ctx.dataDir, "sessions");
    expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true);
    expect((e as ToolError).logText).not.toContain(fx);
    if (existsSync(join(ctx.dataDir, "logs/app.log"))) expect(appLog(ctx)).not.toContain(fx);
  });

  it("d. a secret in the folder: skipped, no label anywhere", async () => {
    const ctx = ctxOf(); const fx = real();
    put(fx, { "dir/a.txt": "обычный текст", "dir/.env.local": "TOKEN=СЕКРЕТ-D" });
    const v = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "dir")] });
    expect(v.materials.skipped.find((x) => x.name.endsWith(".env.local"))!.reason).toMatch(/окружения/);
    await finished(ctx, v.sessionId);
    expect(JSON.stringify(v)).not.toContain("СЕКРЕТ-D");
    expect(appLog(ctx)).not.toContain("СЕКРЕТ-D");
    for (const f of walk(join(ctx.dataDir, "sessions", v.sessionId))) expect(readFileSync(f, "utf8"), f).not.toContain("СЕКРЕТ-D");
  });

  it("e. files only: no folder", async () => {
    const ctx = ctxOf(); const fx = real();
    put(fx, { "a.txt": "альфа" });
    const v = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "a.txt")] });
    expect(v.folder).toBeNull();
    expect(v.materials.left).toEqual({ count: 0, items: [] });
    expect(existsSync(join(ctx.dataDir, "sessions", v.sessionId, "workspace"))).toBe(false);
    await finished(ctx, v.sessionId);
  });

  it("f. tool description", () => {
    for (const w of ["снимка папки", "по запросу", "materials.left.count", "(folder)"]) expect(councilStart.description).toContain(w);
  });

  it("Material details in the start response: no texts or absolute paths", async () => {
    const SEED = 20260509;
    let a = SEED;
    const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const LIMIT = 2000;
    type Case = { files: Record<string, string | Uint8Array>; extra?: string };
    const mark = (c: number, n: number, size: number) => `ТЕКСТ-${c}-${n}-`.padEnd(size, "x");
    const cases: ((c: number) => Case)[] = [
      (c) => ({ files: { "d/README.md": mark(c, 0, 100), "d/a.ts": mark(c, 1, 200) } }),
      (c) => ({ files: { "d/README.md": mark(c, 0, 100), "d/a.ts": mark(c, 1, 3000), "d/b.ts": mark(c, 2, 3000) } }),
      (c) => ({ files: { "d/a.ts": mark(c, 1, 3000), "d/b.ts": mark(c, 2, 3000) } }),
      (c) => ({ files: { "d/a.txt": mark(c, 1, 100), "d/node_modules/x.txt": mark(c, 2, 100), "d/bin.dat": Buffer.from([65, 0, 66]), "d/.env": `K=СЕКРЕТ-${c}-` } }),
      (c) => ({ files: { "d/a.ts": mark(c, 1, 300), "d/b.ts": mark(c, 2, 3000) }, extra: "d/a.ts" }),
    ];
    const exts = ["md", "txt", "ts", "json"];
    for (let i = 0; i < 25; i++) {
      const c = i + 1;
      const k: Case = i < cases.length ? cases[i]!(c) : (() => {
        const files: Record<string, string> = {};
        for (let n = 0; n < int(1, 8); n++) files[`d/${Array.from({ length: int(0, 3) }, (_, j) => `s${j}`).join("/")}/f${n}.${exts[int(0, 3)]}`.replace("//", "/")] = mark(c, n, int(50, 2600));
        if (rnd() < 0.4) files["d/.env.local"] = `K=СЕКРЕТ-${c}-`;
        return { files };
      })();
      const ctx = withLimit(LIMIT); const fx = real();
      put(fx, k.files);
      const where = `случай ${c}, зерно ${SEED}`;
      const v = await start(ctx, { topic: "т", participants: two, attachments: [join(fx, "d"), ...(k.extra ? [join(fx, k.extra)] : [])] });
      await finished(ctx, v.sessionId);
      const st = await councilStatus.run(ctx, { sessionId: v.sessionId });
      for (const [what, text] of [["start", JSON.stringify(v)], ["status", JSON.stringify(st)], ["app.log", appLog(ctx)]] as const) {
        for (const bad of ["ТЕКСТ-", "СЕКРЕТ-", fx]) expect(text.includes(bad), `${where}: «${bad}» в ${what}`).toBe(false);
      }
    }
}, 180_000); // CPU-bound: the ceiling only guards against a hang, a busy machine slows it several times
});

describe("council_start: named lineups", () => {
  const lp = (providerId: string, model: string, role: string | null = null) => ({ providerId, model, role });
  const save = (ctx: ToolContext, name: string, participants: ReturnType<typeof lp>[]) => saveLineup(ctx.dataDir, { name, participants });

  it("L7. lineup with roles and a template: roles exactly from the lineup, the template's frame", async () => {
    const ctx = ctxOf();
    const t = loadTemplates({ builtinDir: templatesDir, userDir: join(ctx.dataDir, "templates") }).templates.find((x) => x.roles.length >= 2)!;
    const l = await save(ctx, "Два сценария", [lp("scripted", "consensus/p2.json", "Критик"), lp("scripted", "consensus/p1.json")]);
    const v = await start(ctx, { topic: "Тема", templateId: t.id, lineupId: l.id });
    const s = readSession(ctx.dataDir, v.sessionId)!.state.session!;
    expect(s.origin).toBe("mcp");
    expect(s.participants.map((p) => [p.model, p.role])).toEqual([["consensus/p2.json", "Критик"], ["consensus/p1.json", null]]);
    expect(t.roles[1]).toBeTruthy();
    expect(s.framing).toBe(t.framing);
    expect(s.templateId).toBe(t.id);
    expect(v.lineup).toEqual({ id: l.id, name: "Два сценария", notes: [] });
    expect(v.next).not.toContain("lineup.notes");
    await finished(ctx, v.sessionId);
  });

  it("L8. a scenario in the lineup — the absolute path of the file", async () => {
    const ctx = ctxOf();
    const l = await save(ctx, "Пути", [lp("scripted", join(scenariosDir, "consensus/p1.json")), lp("scripted", join(scenariosDir, "consensus/p2.json"))]);
    const v = await start(ctx, { topic: "Тема", lineupId: l.id });
    expect((await finished(ctx, v.sessionId)).status).toBe("consensus");
  });

  it("L9. lineupId together with participants — refusal, including with an empty list", async () => {
    const ctx = ctxOf();
    const l = await save(ctx, "Пара", [lp("scripted", "consensus/p1.json"), lp("scripted", "consensus/p2.json")]);
    await rejectsTool(ctx, { topic: "Т", lineupId: l.id, participants: two }, /несовместимы/);
    await rejectsTool(ctx, { topic: "Т", lineupId: l.id, participants: [] }, /несовместимы/);
  });

  it("L10. unknown lineupId", async () => {
    await rejectsTool(ctxOf(), { topic: "Т", lineupId: "нет-такого" }, /не найден/);
  });

  it("L11. removed provider: refusal with a reason, the file does not change", async () => {
    const ctx = ctxOf();
    const l = await save(ctx, "С призраком", [lp("scripted", "consensus/p1.json"), lp("ghost", "m")]);
    const before = readFileSync(lineupsPath(ctx.dataDir));
    await rejectsTool(ctx, { topic: "Т", lineupId: l.id }, /недоступен:\n2\. ghost:m — .*не найден в реестре/);
    expect(readFileSync(lineupsPath(ctx.dataDir)).equals(before)).toBe(true);
  });

  it("L12. corrupted file: with lineupId refusal, without it the launch passes", async () => {
    const ctx = ctxOf();
    writeFileSync(lineupsPath(ctx.dataDir), "{ не json");
    await rejectsTool(ctx, { topic: "Т", lineupId: "x" }, /^lineups\.json:/);
    const v = await start(ctx, { topic: "Т", participants: two });
    expect(v.lineup).toBeNull();
    await finished(ctx, v.sessionId);
  });

  it("L13. regular launch without a lineup: lineup null", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "Т", participants: two });
    expect(v.lineup).toBeNull();
    await finished(ctx, v.sessionId);
  });

  it("L16. scripted positions without COUNCIL_DEV: refusal", async () => {
    const ctx = ctxOf({ scenariosDir: null });
    const l = await save(ctx, "Сценарии", [lp("scripted", "consensus/p1.json"), lp("scripted", "consensus/p2.json")]);
    await rejectsTool(ctx, { topic: "Т", lineupId: l.id }, /COUNCIL_DEV/);
  });
});

describe("council_start: independent drafts", () => {
  const dir = tmp();
  const scn = join(dir, "scn");
  mkdirSync(scn, { recursive: true });
  const body = (t: string) => JSON.stringify({ steps: [{ response: { stance: "amend", reasoning: "r", solution: t, answers: [], questions: [] } }, { response: { stance: "amend", reasoning: "r", solution: `${t} итог`, answers: [], questions: [] } }, { response: { stance: "agree", reasoning: "r", solution: null, answers: [], questions: [] } }] });
  for (const n of ["a", "b", "c"]) writeFileSync(join(scn, `${n}.json`), body(n));
  const three = ["a.json", "b.json", "c.json"].map(sc);
  const ctxD = () => ctxOf({ scenariosDir: scn });

  it("drafts and synthesizerId p2: 27 calls, the synthesizer in the response", async () => {
    const ctx = ctxD();
    const v = await start(ctx, { topic: "Т", participants: three, maxRounds: 2, drafts: true, synthesizerId: "p2" });
    expect(v.maxCalls).toBe(27);
    expect(v.drafts).toEqual({ synthesizerId: "p2", synthesizerName: v.participants[1]!.name, byDefault: false });
    expect(v.next).toContain("p2");
    expect(v.next).toContain("27");
    await finished(ctx, v.sessionId);
  });

  it("drafts without synthesizerId: p1 by default", async () => {
    const ctx = ctxD();
    const v = await start(ctx, { topic: "Т", participants: three, maxRounds: 2, drafts: true });
    expect(v.drafts).toMatchObject({ synthesizerId: "p1", byDefault: true });
    await finished(ctx, v.sessionId);
  });

  it("old client: 18 calls, drafts null, no draft_* events", async () => {
    const ctx = ctxD();
    const v = await start(ctx, { topic: "Т", participants: three, maxRounds: 2 });
    expect(v.maxCalls).toBe(18);
    expect(v.drafts).toBeNull();
    await finished(ctx, v.sessionId);
    expect(readEvents(ctx.dataDir, v.sessionId)!.events.filter((e) => e.type.startsWith("draft"))).toEqual([]);
  });

  it("synthesizerId without drafts and unknown synthesizerId — refusal before the session", async () => {
    const ctx = ctxD();
    await rejectsTool(ctx, { topic: "Т", participants: three, synthesizerId: "p2" }, /synthesizerId работает только вместе с drafts: true\./);
    await rejectsTool(ctx, { topic: "Т", participants: three, drafts: true, synthesizerId: "p9" }, /p9/);
  });
});

describe("council_start: detached executor", () => {
  const noLaunchFiles = (ctx: ToolContext, id?: string) => {
    const dir = join(ctx.dataDir, "launch");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  };
  const script = (body: string) => { const f = join(tmp(), "exec.mjs"); writeFileSync(f, body); return f; };
  const withScript = (body: string, over: Partial<ToolContext> = {}) => ctxOf({ councilLaunch: { command: process.execPath, args: [script(body)], env: {} }, ...over });

  it("a. the id comes after the first event; the executor is another process", async () => {
    const ctx = ctxOf();
    const v = await start(ctx, { topic: "т", participants: [sc("owner-wait/ask-p1.json"), sc("owner-wait/answer-p2.json")], waitForOwner: true });
    const s = readSession(ctx.dataDir, v.sessionId)!;
    expect(readEvents(ctx.dataDir, v.sessionId)!.events.length).toBeGreaterThan(0);
    const lock = join(ctx.dataDir, "sessions", v.sessionId, "resume.lock");
    const pid = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : s.state.pid!;
    expect(pid).not.toBe(process.pid);
    expect(s.state.pid).not.toBe(process.pid);
    expect(s.status).toBe("running");
    noLaunchFiles(ctx, v.sessionId);
    requestStop(ctx.dataDir, v.sessionId);
    await until("executor process exit", () => !alive(pid));
    expect(readSession(ctx.dataDir, v.sessionId)!.status).toBe("stopped");
  });

  it("e. the executor environment lacks keys that come only from the data folder .env", async () => {
    const key = `OSEN_T238_S_${Math.random().toString(36).slice(2, 10)}`;
    const dataDir = tmp();
    writeFileSync(join(dataDir, ".env"), `${key}=secret\n`);
    const out = join(tmp(), "env.json");
    const ctx = withScript(`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env))); process.exit(3);`, { dataDir, env: { COUNCIL_DEV: "1", [key]: "secret", KEEP_T238: "1" } });
    await rejectsTool(ctx, { topic: "т", participants: two }, /exit code 3/);
    const keys = JSON.parse(readFileSync(out, "utf8")) as string[];
    expect(keys).not.toContain(key);
    expect(keys).toContain("KEEP_T238");
    expect(keys).toContain("COUNCIL_HOME");
  });

  it("b. the executor cannot be started: the reason, no session, no launch files", async () => {
    const ctx = ctxOf({ councilLaunch: { command: join(tmp(), "no-such-node"), args: [], env: {} } });
    await rejectsTool(ctx, { topic: "т", participants: two }, /не запустился: .*ENOENT/);
    noLaunchFiles(ctx);
  });

  it("c. the executor exits before the first event: the text of stderr, no session, no launch files", async () => {
    const ctx = withScript('process.stderr.write("boom\\n"); process.exit(3);');
    await rejectsTool(ctx, { topic: "т", participants: two }, /boom/);
    noLaunchFiles(ctx);
  });

  it("d. the executor does not respond: timeout, no session appears later, no launch files", async () => {
    const ctx = withScript("setTimeout(() => {}, 1500);", { startTimeoutMs: 500, startPollMs: 20 });
    await rejectsTool(ctx, { topic: "т", participants: two }, /исполнитель не ответил за 1 с/);
    noLaunchFiles(ctx);
    await sleep(2000);
    expect(listSessions(ctx.dataDir)).toEqual([]);
    noLaunchFiles(ctx);
  });
});

describe("server closed during the launch wait", () => {
  it("cleanupActiveLaunches removes this launch's launch, err and accepted files", async () => {
    const ctx = ctxOf({ startTimeoutMs: 600, startPollMs: 20, spawnExecutor: () => new Promise<number>(() => {}) });
    const pending = start(ctx, { topic: "t", participants: two }).catch((e: unknown) => e);
    const launch = join(ctx.dataDir, "launch");
    const files = await until("launch files appear", () => { const f = existsSync(launch) ? readdirSync(launch).filter((n) => n.endsWith(".json")) : []; return f.length ? f : null; });
    const base = join(launch, files[0]!.replace(/\.json$/, ""));
    writeFileSync(`${base}.err`, "boom");
    writeFileSync(`${base}.accepted.json`, "{}");
    cleanupActiveLaunches();
    expect(readdirSync(launch)).toEqual([]);
    await pending;
  });
});
