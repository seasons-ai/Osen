import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { planLaunch } from "./cli-agents/args.ts";
import { locateCli, resetDiscoveryCache } from "./cli-agents/discovery.ts";
import { classifyFailure } from "./cli-agents/errors.ts";
import { listModels } from "./cli-agents/models.ts";
import { setProcessLanguage } from "./i18n/process-language.ts";
import { createHttpDriver } from "./http/driver.ts";
import { startFakeServer } from "./http/fake-server.ts";
import type { FakeServer } from "./http/fake-server.ts";
import { listHttpModels } from "./http/models.ts";
import { redact } from "./http/types.ts";
import type { HttpRuntime } from "./http/types.ts";
import { ParticipantCallError } from "./participants/driver.ts";
import type { TurnRequest } from "./participants/driver.ts";
import { createScriptedDriver, readScenario } from "./participants/scripted.ts";

afterEach(() => { setProcessLanguage("ru"); resetDiscoveryCache(); });

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });
const KEY = "sk-secret-123";
const rt = (baseUrl: string, over: Partial<HttpRuntime> = {}): HttpRuntime => ({ baseUrl, keyFile: "/data/.env", ...over });
const req = (model: string, signal = new AbortController().signal): TurnRequest => ({
  participant: { id: "p1", name: "A", providerId: "h", model, role: null } as TurnRequest["participant"],
  prompt: "x", language: "ru", timeoutSec: 30, signal, onChunk: () => {},
});
const failure = async (p: Promise<unknown>): Promise<ParticipantCallError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ParticipantCallError);
  return e as ParticipantCallError;
};
const fake = async (opts: Parameters<typeof startFakeServer>[0] = {}): Promise<FakeServer> => {
  const s = await startFakeServer(opts);
  closers.push(() => s.close());
  return s;
};
const raw = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
  const srv: Server = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
};

describe("Core messages in the selected language: reason a provider is unavailable", () => {
  it("command not found: the path in the text is the same, the language differs", async () => {
    const at = async () => (await locateCli("claude", { explicitPath: "/no/such/claude", env: { PATH: "" }, deps: { isExecutable: () => false } })).reason;
    const ru = await at();
    setProcessLanguage("en");
    const en = await at();
    expect(ru).toBe("Команда claude не найдена по заданному пути /no/such/claude");
    expect(en).toBe("Command claude not found at the given path /no/such/claude");
  });

  it("version does not declare a flag: version, flags and command name are the same", () => {
    const plan = () => planLaunch({ agent: "claude", flags: new Set<string>(), version: "9.9.9", model: "default", language: "ru" });
    const ru = plan();
    setProcessLanguage("en");
    const en = plan();
    for (const p of [ru, en]) {
      expect(p.ok).toBe(false);
      if (!p.ok) for (const part of ["claude", "9.9.9", "--print"]) expect(p.reason).toContain(part);
    }
    if (!ru.ok && !en.ok) {
      expect(ru.reason).toContain("не объявляет флаг");
      expect(en.reason).toContain("does not declare the flag");
    }
  });

  it("codex isolation not confirmed: list not read and no capability — version and names are the same", () => {
    const plans = () => [
      planLaunch({ agent: "codex", flags: new Set(["--sandbox", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json", "--disable"]), version: "0.159.2", model: "default", language: "ru" }),
      planLaunch({ agent: "codex", flags: new Set(["--sandbox", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json", "--disable"]), version: "0.159.2", model: "default", language: "ru", features: new Set(["hooks"]) }),
    ];
    const ru = plans();
    setProcessLanguage("en");
    const en = plans();
    const reasons = [...ru, ...en].map((p) => (p.ok ? "" : p.reason));
    for (const r of reasons) expect(r).toContain("0.159.2");
    expect(reasons[0]).toMatch(/не прочитан.*codex features list|codex features list.*не прочитан/);
    expect(reasons[2]).toMatch(/codex features list/);
    expect(reasons[2]).not.toMatch(/[А-Яа-яЁё]/);
    expect(reasons[1]).toContain("shell_tool");
    expect(reasons[1]).not.toMatch(/(^|[\s,])hooks([\s,]|$)/);
    expect(reasons[3]).toContain("shell_tool");
    expect(reasons[3]).not.toMatch(/[А-Яа-яЁё]/);
  });

  it("CLI failure: kind and retryable do not depend on the language, stderr tail verbatim", () => {
    const input = { command: "codex", exitCode: 3, signal: null, text: "boom: странная ошибка" };
    const ru = classifyFailure("codex", input);
    setProcessLanguage("en");
    const en = classifyFailure("codex", input);
    expect(en.kind).toBe(ru.kind);
    expect(en.retryable).toBe(ru.retryable);
    expect(ru.message).toBe("codex завершился с кодом 3: boom: странная ошибка");
    expect(en.message).toBe("codex exited with code 3: boom: странная ошибка");
  });

  it("model catalog reason: name and reason are the same", async () => {
    const list = async () => (await listModels("codex", { path: "codex", env: {}, help: "", deps: { readCodexModelsCache: async () => "{}" } })).reason;
    const ru = await list();
    setProcessLanguage("en");
    const en = await list();
    expect(ru).toContain("Перечень моделей codex недоступен");
    expect(en).toContain("The model list of codex is unavailable");
    expect(en).toContain("the codex model cache has no available models");
  });
});

describe("Core messages in the selected language: provider server text", () => {
  it.each([["fake-rate", "Rate limit exceeded", true], ["fake-error", "Internal server error", true]] as const)("%s: текст сервера дословно, вид сбоя одинаков", async (model, text, retryable) => {
    const s = await fake();
    const ru = await failure(createHttpDriver(rt(s.url)).call(req(model)));
    setProcessLanguage("en");
    const en = await failure(createHttpDriver(rt(s.url)).call(req(model)));
    expect(ru.message).toContain(text);
    expect(en.message).toContain(text);
    expect(ru.message).toMatch(/^(Превышен|Эндпоинт ответил)/);
    expect(en.message).toMatch(/^(Request limit exceeded|The endpoint answered)/);
    expect(en.kind).toBe(ru.kind);
    expect(en.retryable).toBe(retryable);
    expect(ru.retryable).toBe(retryable);
  });

  it("key value does not reach messages, a language label is in its place", async () => {
    const url = await raw((_q, res) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: `bad key ${KEY}` } })); });
    const runtime = rt(url, { apiKeyEnv: "MY_KEY", apiKey: KEY });
    const ru = await failure(createHttpDriver(runtime).call(req("m")));
    setProcessLanguage("en");
    const en = await failure(createHttpDriver(runtime).call(req("m")));
    expect(ru.message).not.toContain(KEY);
    expect(en.message).not.toContain(KEY);
    expect(ru.message).toContain("[скрыто]");
    expect(en.message).toContain("[hidden]");
    expect(redact(`a ${KEY}`, runtime)).toBe("a [hidden]");
  });

  it("authorization refusal and model list: variable and file names are the same", async () => {
    const s = await fake({ apiKey: "right" });
    const runtime = rt(s.url, { apiKeyEnv: "MY_KEY", apiKey: KEY });
    const ru = await listHttpModels(runtime);
    setProcessLanguage("en");
    const en = await listHttpModels(runtime);
    expect(ru.reason).toContain("Отказ авторизации (HTTP 401)");
    expect(en.reason).toContain("Authorization denied (HTTP 401)");
    for (const r of [ru.reason, en.reason]) { expect(r).toContain("MY_KEY"); expect(r).toContain("/data/.env"); expect(r).not.toContain(KEY); }
  });
});

describe("Core messages in the selected language: scripted participants", () => {
  it("exhausted script and unavailability without COUNCIL_DEV", async () => {
    const run = async () => {
      const d = createScriptedDriver({ steps: [] }, { COUNCIL_DEV: "1" });
      return (await failure(d.call(req("m")))).message;
    };
    const ru = await run();
    setProcessLanguage("en");
    const en = await run();
    expect(ru).toBe("Сценарий исчерпан: в сценарии шагов 0, это вызов №1.");
    expect(en).toBe("Script exhausted: the script has 0 steps, this is call #1.");
    expect(() => createScriptedDriver({ steps: [] }, {})).toThrow("Scripted participants are available only with COUNCIL_DEV=1.");
  });

  it("unreadable script: the path is the same", async () => {
    const read = async () => ((await readScenario("/no/such/scenario.json").then(() => undefined, (e: unknown) => e)) as Error).message;
    const ru = await read();
    setProcessLanguage("en");
    const en = await read();
    expect(ru).toContain("Не удалось прочитать сценарий /no/such/scenario.json");
    expect(en).toContain("Could not read the script /no/such/scenario.json");
  });
});
