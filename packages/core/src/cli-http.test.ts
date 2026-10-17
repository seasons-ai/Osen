import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { help, main } from "./cli.ts";
import { loadEnv } from "./store/env.ts";
import { FAKE_AGREE, FAKE_AMEND, FAKE_MODELS, startFakeServer } from "./http/fake-server.ts";
import type { FakeServer } from "./http/fake-server.ts";

const tmps: string[] = [];
const servers: FakeServer[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-http-")); tmps.push(d); return d; };
const serve = async (o: Parameters<typeof startFakeServer>[0] = {}) => { const s = await startFakeServer(o); servers.push(s); return s; };
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const config = (baseUrl: string, apiKeyEnv?: string, participants: unknown[] = []) => ({
  providers: [{ id: "fake", kind: "openai-http", label: "Fake", models: [], baseUrl, ...(apiKeyEnv ? { apiKeyEnv } : {}) }],
  defaults: { maxRounds: 2, turnTimeoutSec: 30, contextChars: 24000, maxParticipants: 8, participants },
});
const parts = (...ps: string[]) => ps.flatMap((p) => ["--participant", p]);
const two = parts("fake:fake-amend", "fake:fake-agree");

async function run(argv: string[], cfg: unknown, o: { env?: (home: string) => Record<string, string | undefined>; chunk?: boolean | ((t: string) => void); signal?: AbortSignal; pre?: (home: string) => void } = {}) {
  const home = tmp();
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
  o.pre?.(home);
  const out: string[] = [], err: string[] = [], chunks: string[] = [];
  const env = o.env?.(home) ?? { COUNCIL_HOME: home };
  const code = await main(argv, {
    stdout: (t) => out.push(t), stderr: (t) => err.push(t), env, signal: o.signal,
    ...(o.chunk === false ? {} : { chunk: (t: string) => { chunks.push(t); if (typeof o.chunk === "function") o.chunk(t); } }),
  });
  const sessions = join(home, "sessions");
  const ids = (() => { try { return readdirSync(sessions); } catch { return []; } })();
  return { code, home, out: out.join("\n"), outLines: out, err: err.join("\n"), chunks: chunks.join(""), chunkCalls: chunks.length, ids };
}

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : [p];
});

describe("council: HTTP providers", () => {
  it("1. providers without a key", async () => {
    const s = await serve();
    const r = await run(["providers"], config(s.url));
    expect(r.code).toBe(0);
    expect(r.outLines).toContain(`fake  openai-http  доступен  ${s.url}`);
    expect(r.outLines).toContain("  ключ: не требуется");
    expect(r.outLines).toContain(`  модели: ${FAKE_MODELS.join(", ")}`);
  });

  it("2. providers with a key: the value is not printed", async () => {
    const s = await serve({ apiKey: "sekret-value-1" });
    const r = await run(["providers"], config(s.url, "TEST_KEY"), { env: (h) => ({ COUNCIL_HOME: h, TEST_KEY: "sekret-value-1" }) });
    expect(r.outLines).toContain("  ключ: TEST_KEY — задан");
    expect(r.out + r.err).not.toContain("sekret-value-1");
  });

  it("3. providers without a key value", async () => {
    const s = await serve({ apiKey: "x" });
    const r = await run(["providers"], config(s.url, "TEST_KEY"));
    expect(r.code).toBe(0);
    const first = r.outLines[0]!;
    expect(first).toContain("недоступен: Ключ не задан");
    expect(first).toContain("TEST_KEY");
    expect(first).toContain(join(r.home, ".env"));
    expect(r.outLines).toContain("  ключ: TEST_KEY — не задан");
    expect(s.requests).toHaveLength(0);
  });

  it("4. providers, server closed", async () => {
    const s = await serve();
    await s.close();
    const r = await run(["providers"], config(s.url));
    expect(r.outLines[0]).toContain(`недоступен: Эндпоинт недоступен: ${s.url}`);
  });

  it("5. launch: consensus, usage, text chunks", async () => {
    const s = await serve();
    const r = await run(["--topic", "Имя коту", ...two], config(s.url));
    expect(r.code).toBe(0);
    expect(r.out).toContain("══ Итог: consensus");
    expect(r.out).toContain("«Fake (fake-amend)»");
    const ev = readFileSync(join(r.home, "sessions", r.ids[0]!, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const done = ev.filter((e) => e.type === "turn_completed");
    expect(done.length).toBeGreaterThan(0);
    for (const e of done) expect(e.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(r.chunkCalls).toBeGreaterThan(2);
    expect(r.chunks).toContain(FAKE_AMEND);
    expect(r.chunks).toContain(FAKE_AGREE);
  });

  it("6. launch without io.chunk", async () => {
    const s = await serve();
    const r = await run(["--topic", "Имя коту", ...two], config(s.url), { chunk: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain("══ Итог: consensus");
  });

  it("7. model with a colon", async () => {
    const s = await serve();
    const r = await run(["--topic", "Имя коту", ...parts("fake:vendor/x:free", "fake:fake-amend", "fake:fake-agree")], config(s.url));
    expect(r.out).toContain("Модель не найдена: vendor/x:free");
    const lines = r.outLines.filter((l) => l.startsWith("✗ Ход") && l.includes("«Fake (vendor/x:free)»"));
    expect(lines.some((l) => l.includes("попытка 1"))).toBe(true);
    expect(lines.some((l) => l.includes("попытка 2"))).toBe(false);
    expect(r.out).toContain("══ Итог:");
  });

  it("8. entry without a model", async () => {
    const s = await serve();
    const r = await run(["--topic", "Имя коту", ...parts("fake", "fake:fake-agree")], config(s.url));
    expect(r.code).toBe(2);
    expect(r.err).toContain("нужна модель");
    expect(r.err).toContain("fake:<модель>");
    expect(r.ids).toEqual([]);
  });

  it("9. default participants with model default", async () => {
    const s = await serve();
    const d = [{ providerId: "fake", model: "default" }, { providerId: "fake", model: "default" }];
    const r = await run(["--topic", "Имя коту"], config(s.url, undefined, d));
    expect(r.code).toBe(2);
    expect(r.err).toContain("нужна модель");
    expect(r.ids).toEqual([]);
  });

  it("10. launch without a key", async () => {
    const s = await serve({ apiKey: "x" });
    const r = await run(["--topic", "Имя коту", ...two], config(s.url, "TEST_KEY"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("TEST_KEY");
    expect(r.err).toContain(join(r.home, ".env"));
    expect(r.ids).toEqual([]);
    expect(s.requests).toHaveLength(0);
  });

  it("11. key from the data folder .env", async () => {
    const s = await serve({ apiKey: "from-file-9" });
    const r = await run(["--topic", "Имя коту", ...two], config(s.url, "TEST_KEY"), {
      pre: (h) => writeFileSync(join(h, ".env"), "TEST_KEY=from-file-9\n"),
      env: (h) => loadEnv({ COUNCIL_HOME: h }, tmp()),
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("══ Итог: consensus");
    expect(s.requests.length).toBeGreaterThan(0);
    for (const q of s.requests) expect(q.authorization).toBe("Bearer from-file-9");
  });

  it("12. environment overrides the file", async () => {
    const s = await serve({ apiKey: "good-env-1" });
    const r = await run(["--topic", "Имя коту", ...two], config(s.url, "TEST_KEY"), {
      pre: (h) => writeFileSync(join(h, ".env"), "TEST_KEY=wrong-file\n"),
      env: (h) => loadEnv({ COUNCIL_HOME: h, TEST_KEY: "good-env-1" }, tmp()),
    });
    expect(r.code).toBe(0);
  });

  it("13. key preservation", async () => {
    const key = "cred-Zq8-very-unique-value";
    const s = await serve({ apiKey: key });
    const r = await run(["--topic", "Имя коту", ...parts("fake:fake-auth", "fake:fake-rate", "fake:fake-amend", "fake:fake-agree")], config(s.url, "FAKE_CRED"), {
      pre: (h) => writeFileSync(join(h, ".env"), `FAKE_CRED=${key}\n`),
      env: (h) => loadEnv({ COUNCIL_HOME: h }, tmp()),
    });
    const all = files(r.home).filter((f) => f !== join(r.home, ".env"));
    for (const f of all) expect(readFileSync(f, "utf8"), f).not.toContain(key);
    const ev = join(r.home, "sessions", r.ids[0]!, "events.jsonl");
    expect(statSync(ev).size).toBeGreaterThan(0);
    expect(statSync(join(r.home, "logs", "app.log")).size).toBeGreaterThan(0);
    expect(r.out + r.err + r.chunks).not.toContain(key);
    expect(readFileSync(ev, "utf8")).toContain("FAKE_CRED");
    const mine = (n: string) => r.outLines.filter((l) => l.startsWith("✗ Ход") && l.includes(`(${n})`));
    const rate = mine("fake-rate");
    expect(rate.some((l) => l.includes("попытка 1") && l.includes("Превышен лимит запросов"))).toBe(true);
    expect(rate.some((l) => l.includes("попытка 2") && l.includes("Превышен лимит запросов"))).toBe(true);
    const auth = mine("fake-auth");
    expect(auth).toHaveLength(1);
    expect(auth[0]).toContain("Отказ авторизации");
  });

  it("14. turn timeout", async () => {
    const s = await serve();
    const r = await run(["--topic", "Имя коту", "--turn-timeout", "1", ...parts("fake:fake-hang", "fake:fake-amend", "fake:fake-agree")], config(s.url));
    const lines = r.outLines.filter((l) => l.startsWith("✗ Ход") && l.includes("(fake-hang)") && l.includes("timeout"));
    expect(lines).toHaveLength(2);
    expect(r.out).toContain("══ Итог:");
  }, 20_000);

  it("15. stop during the stream", async () => {
    const s = await serve();
    const ac = new AbortController();
    const r = await run(["--topic", "Имя коту", ...parts("fake:fake-slow", "fake:fake-agree")], config(s.url), { signal: ac.signal, chunk: () => ac.abort() });
    expect(r.code).toBe(4);
    await vi.waitFor(() => expect(s.closedEarly).toBe(1));
  });

  it("16. help", () => {
    expect(help()).toContain("провайдеры из config.json: доступность, версия, путь или адрес, ключ, модели");
    expect(help()).toContain("  Для провайдера вида openai-http модель обязательна, двоеточия в её имени допустимы: openrouter:vendor/model:free");
    expect(help()).toContain("Ключи HTTP-провайдеров берутся из переменных окружения; окружение дополняется из .env папки данных и .env текущей папки (переменная окружения главнее файла).");
  });
});
