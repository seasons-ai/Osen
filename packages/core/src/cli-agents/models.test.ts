import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  claudeInitialize, listModels, parseClaudeInitializeModels, parseCodexModelsCache, parseHelpAliases, readCodexModelsCache,
} from "./models.ts";

const fx = (name: string): Promise<string> => readFile(join(import.meta.dirname, "fixtures", name), "utf8");
const claudeAnswer = (): Promise<string> => fx("claude-2.1.288-initialize-models.json");
const codexCache = (): Promise<string> => fx("codex-0.159.2-models-cache.json");
const env = { PATH: "/usr/bin" };
const CLAUDE_MODELS = ["opus", "claude-fable-5-1[1m]", "sonnet", "haiku"];
const CODEX_MODELS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "council-models-test-"));
  roots.push(r);
  return r;
}
async function stub(body: string, interpreter = "/usr/bin/env node"): Promise<{ path: string; root: string }> {
  const root = await tmp();
  const path = join(root, "fake-claude");
  await writeFile(path, `#!${interpreter}\n${body}\n`, "utf8");
  await chmod(path, 0o755);
  return { path, root };
}
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

const claudeHelp = (): Promise<string> => fx("claude-2.1.288-help.txt");
const FLAGS_HELP = ["--print", "--input-format <f>", "--output-format <f>", "--verbose", "--no-session-persistence"].map((f) => `  ${f}   x`).join("\n");
const fail = (): Promise<string> => Promise.reject(new Error("claude не запустился: ENOENT"));

describe("listModels claude", () => {
  test("the list from the CLI itself is confirmed, default is not included", async () => {
    const r = await listModels("claude", { path: "claude", env, help: await claudeHelp(), deps: { claudeInitialize: claudeAnswer } });
    expect(r).toEqual({ models: CLAUDE_MODELS, confirmed: true });
  });

  test("request failed: aliases from help, reason named", async () => {
    const r = await listModels("claude", { path: "claude", env, help: await claudeHelp(), deps: { claudeInitialize: fail } });
    expect(r.models).toEqual(expect.arrayContaining(["fable", "opus", "sonnet"]));
    expect(r.confirmed).toBe(false);
    expect(r.reason).toBe("Перечень моделей claude взят из справки и не подтверждён: claude не запустился: ENOENT");
  });

  test("response without list and empty help: empty, reason present", async () => {
    const r = await listModels("claude", { path: "claude", env, help: FLAGS_HELP, deps: { claudeInitialize: async () => '{"type":"x"}' } });
    expect(r).toEqual({ models: [], confirmed: false, reason: "Перечень моделей claude недоступен: ответ на служебный запрос не содержит перечня моделей" });
  });

  test("request failed and help empty", async () => {
    const r = await listModels("claude", { path: "claude", env, help: FLAGS_HELP, deps: { claudeInitialize: fail } });
    expect(r.models).toEqual([]);
    expect(r.confirmed).toBe(false);
    expect(r.reason).toContain("ENOENT");
  });

  test("help without --input-format: request not run, list from help", async () => {
    let called = false;
    const help = (await claudeHelp()).replace(/^  --input-format.*$/m, "");
    const r = await listModels("claude", { path: "claude", env, help, deps: { claudeInitialize: async () => { called = true; return ""; } } });
    expect(called).toBe(false);
    expect(r.confirmed).toBe(false);
    expect(r.models).toEqual(expect.arrayContaining(["fable", "opus", "sonnet"]));
    expect(r.reason).toContain("--input-format");
  });

  test("duplicates collapse, default is not included", async () => {
    const answer = JSON.stringify({ response: { response: { models: [{ value: "default" }, { value: "a" }, { value: "a" }] } } });
    const r = await listModels("claude", { path: "claude", env, help: FLAGS_HELP, deps: { claudeInitialize: async () => answer } });
    expect(r.models).toEqual(["a"]);
  });
});

describe("listModels codex", () => {
  const help = "";
  test("cache: visible models, confirmed", async () => {
    const r = await listModels("codex", { path: "codex", env, help, deps: { readCodexModelsCache: codexCache } });
    expect(r).toEqual({ models: CODEX_MODELS, confirmed: true });
  });

  test.each([
    ["файла нет", () => Promise.reject(new Error("ENOENT: no such file")), "ENOENT"],
    ["битый JSON", async () => "{not json", "JSON"],
    ["пустой перечень", async () => '{"models":[]}', "нет доступных моделей"],
  ])("%s", async (_n, read, part) => {
    const r = await listModels("codex", { path: "codex", env, help, deps: { readCodexModelsCache: read } });
    expect(r.models).toEqual([]);
    expect(r.confirmed).toBe(false);
    expect(r.reason).toContain("Перечень моделей codex недоступен");
    expect(r.reason).toContain(part);
  });

  test("cache empty: aliases from help", async () => {
    const r = await listModels("codex", { path: "codex", env, help: "  --model <M>  e.g. 'gpt-x'\n", deps: { readCodexModelsCache: async () => "{}" } });
    expect(r.models).toEqual(["gpt-x"]);
    expect(r.confirmed).toBe(false);
  });

  test("real readCodexModelsCache respects CODEX_HOME", async () => {
    const home = await tmp();
    await writeFile(join(home, "models_cache.json"), await codexCache());
    const r = await listModels("codex", { path: "codex", env: { CODEX_HOME: home }, help });
    expect(r).toEqual({ models: CODEX_MODELS, confirmed: true });
    expect(await readCodexModelsCache({ CODEX_HOME: home })).toContain("gpt-6.1-sol");
  });
});

describe("claudeInitialize on a stub", () => {
  const ARGS = ["--print"];
  const readRequest = `
const fs = require('node:fs');
let buf = '';
function onLine(cb) { process.stdin.on('data', (c) => { buf += c; if (buf.includes('\\n')) cb(JSON.parse(buf.split('\\n')[0])); }); }
`;

  test("response received, variable passed, working folder empty and removed", async () => {
    const { path, root } = await stub(`${readRequest}
const out = require('node:path').join(__dirname, 'seen.json');
onLine((req) => {
  fs.writeFileSync(out, JSON.stringify({ marker: process.env.COUNCIL_PARTICIPANT, home: process.env.SECRET_HOME ?? null, cwd: process.cwd(), files: fs.readdirSync('.') }));
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { models: [{ value: 'm1' }] } } }) + '\\n');
});
setInterval(() => {}, 1000);`);
    process.env.SECRET_HOME = "leak";
    try {
      const line = await claudeInitialize(path, { PATH: process.env.PATH }, ARGS);
      expect(parseClaudeInitializeModels(JSON.parse(line))).toEqual(["m1"]);
    } finally {
      delete process.env.SECRET_HOME;
    }
    const seen = JSON.parse(await readFile(join(root, "seen.json"), "utf8")) as { marker: string; home: string | null; cwd: string; files: string[] };
    expect(seen.marker).toBe("1");
    expect(seen.home).toBeNull();
    expect(seen.files).toEqual([]);
    expect(await exists(seen.cwd)).toBe(false);
  });

  // The deadline runs from spawn: on a busy machine a silent stub can be killed before its first line;
  // such a run proves nothing and is repeated with a doubled deadline. Returns the file the stub wrote.
  async function silentRun(body: string, marker: string): Promise<string> {
    for (let ms = 1500; ms <= 12_000; ms *= 2) {
      const { path, root } = await stub(body, "/bin/sh");
      await expect(claudeInitialize(path, { PATH: process.env.PATH }, ARGS, ms)).rejects.toThrow("не ответил");
      if (await exists(join(root, marker))) return readFile(join(root, marker), "utf8");
    }
    throw new Error("the stub never started before the deadline");
  }

  test("silent stub: refused by timeout, process ended", async () => {
    const pid = Number(await silentRun(`echo $$ > "$(dirname "$0")/pid"\nexec sleep 300`, "pid"));
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await expect.poll(alive, { timeout: 10_000 }).toBe(false);
  }, 60_000);

  test("descendant processes end together with the group", async () => {
    const pids = (await silentRun(`sleep 300 &\necho "$$ $!" > "$(dirname "$0")/pids"\nwait`, "pids")).split(" ").map(Number);
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const pid of pids) await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  }, 60_000);

  test("arguments on real help 2.1.288", async () => {
    // the stub exits after writing its arguments, so the deadline only has to outlast a slow start
    const { path, root } = await stub("require('node:fs').writeFileSync(require('node:path').join(__dirname, 'argv.json'), JSON.stringify(process.argv.slice(2)));");
    await listModels("claude", { path, env: { PATH: process.env.PATH }, help: await claudeHelp(), deps: { claudeInitialize: (p, e, a) => claudeInitialize(p, e, a, 20_000) } });
    expect(JSON.parse(await readFile(join(root, "argv.json"), "utf8"))).toEqual([
      "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
      "--strict-mcp-config", "--setting-sources", "", "--tools", "", "--disable-slash-commands",
    ]);
  });

  test("nonexistent CLI: reason in error, listModels does not throw", async () => {
    const r = await listModels("claude", { path: "/no/such/claude", env, help: FLAGS_HELP });
    expect(r.models).toEqual([]);
    expect(r.reason).toContain("не запустился");
  });
});

describe("parsers (moved from Widget)", () => {
  const help = `
  --mcp-config <configs...>             Load MCP servers from JSON files
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  --permission-mode <mode>              Permission mode (choices: "acceptEdits")
`;
  test("aliases named by help", () => {
    expect(parseHelpAliases(help, "--model")).toEqual(["fable", "opus", "sonnet", "claude-fable-5"]);
  });
  test("help is silent: nothing is invented", () => {
    expect(parseHelpAliases("  --model <model>   Model for the session.\n", "--model")).toEqual([]);
  });
  test("neighbouring flag is not read", () => {
    expect(parseHelpAliases(help, "--permission-mode")).toEqual([]);
  });
  test("real help 2.1.288", async () => {
    expect(parseHelpAliases(await claudeHelp(), "--model")).toEqual(expect.arrayContaining(["fable", "opus", "sonnet"]));
  });
  test("codex: order kept, entries without slug dropped", () => {
    expect(parseCodexModelsCache({ models: [{ slug: "gpt-5.6", visibility: "private" }, { display_name: "ignored" }, { slug: "gpt-5.6-mini" }] }))
      .toEqual(["gpt-5.6", "gpt-5.6-mini"]);
  });
  test("codex: hidden ones dropped", () => {
    expect(parseCodexModelsCache({ models: [{ slug: "listed", visibility: "list" }, { slug: "codex-auto-review", visibility: "hide" }] })).toEqual(["listed"]);
  });
  test("codex: broken caches give an empty list", () => {
    expect(parseCodexModelsCache(null)).toEqual([]);
    expect(parseCodexModelsCache({ fetched_at: "now" })).toEqual([]);
  });
  test("claude: responses of another shape give an empty list", () => {
    expect(parseClaudeInitializeModels(null)).toEqual([]);
    expect(parseClaudeInitializeModels({ type: "control_response", response: { subtype: "error", error: "no" } })).toEqual([]);
    expect(parseClaudeInitializeModels({ response: { response: { models: "five" } } })).toEqual([]);
    expect(parseClaudeInitializeModels({ response: { response: { models: [{ displayName: "nameless" }] } } })).toEqual([]);
  });
  test("claude: real sample, default skipped", async () => {
    expect(parseClaudeInitializeModels(JSON.parse(await claudeAnswer()))).toEqual(CLAUDE_MODELS);
  });
});
