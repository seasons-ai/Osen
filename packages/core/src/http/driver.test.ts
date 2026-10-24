import { afterEach, describe, expect, it, vi } from "vitest";
import { ParticipantCallError } from "../participants/driver.ts";
import type { TurnRequest } from "../participants/driver.ts";
import { classifyHttpFailure, createHttpDriver, createSseParser } from "./driver.ts";
import { FAKE_AMEND, startFakeServer } from "./fake-server.ts";
import type { FakeServer } from "./fake-server.ts";
import type { HttpRuntime } from "./types.ts";

const KEY = "sk-secret-123";
const servers: FakeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });
const start = async (opts: Parameters<typeof startFakeServer>[0] = {}) => { const s = await startFakeServer(opts); servers.push(s); return s; };

const rt = (url: string, over: Partial<HttpRuntime> = {}): HttpRuntime => ({ baseUrl: url, keyFile: "/data/.env", ...over });
const withKey = { apiKeyEnv: "MY_KEY", apiKey: KEY };
const req = (model: string, over: Partial<TurnRequest> = {}, chunks: string[] = []): TurnRequest => ({
  participant: { id: "p1", name: "A", providerId: "h", model, role: null } as TurnRequest["participant"],
  prompt: "Привет", language: "ru", timeoutSec: 30, signal: new AbortController().signal, onChunk: (t) => chunks.push(t), ...over,
});
const fails = async (p: Promise<unknown>) => { const e = await p.then(() => undefined, (x: unknown) => x); expect(e).toBeInstanceOf(ParticipantCallError); return e as ParticipantCallError; };

describe("HTTP driver: successful turn", () => {
  it("fake-amend: chunks, joining, usage without costUsd", async () => {
    const s = await start();
    const chunks: string[] = [];
    const r = await createHttpDriver(rt(s.url)).call(req("fake-amend", {}, chunks));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(r.text);
    expect(r.text).toBe(FAKE_AMEND);
    expect(r.usage).toStrictEqual({ inputTokens: 11, outputTokens: 7 });
  });
  it("fake-cost: costUsd", async () => {
    const s = await start();
    expect((await createHttpDriver(rt(s.url)).call(req("fake-cost"))).usage.costUsd).toBe(0.00012);
  });
  it("fake-plain: plain JSON, one chunk", async () => {
    const s = await start();
    const chunks: string[] = [];
    const r = await createHttpDriver(rt(s.url)).call(req("fake-plain", {}, chunks));
    expect(r.text).toBe(FAKE_AMEND);
    expect(r.usage).toStrictEqual({ inputTokens: 11, outputTokens: 7 });
    expect(chunks).toHaveLength(1);
  });
  it("request body and headers", async () => {
    const s = await start();
    await createHttpDriver(rt(s.url)).call(req("fake-agree"));
    expect(s.requests[0]!.body).toStrictEqual({ model: "fake-agree", messages: [{ role: "user", content: "Привет" }], stream: true, stream_options: { include_usage: true } });
    expect(s.requests[0]!.authorization).toBeUndefined();
    await createHttpDriver(rt(s.url, withKey)).call(req("fake-agree"));
    expect(s.requests[1]!.authorization).toBe(`Bearer ${KEY}`);
  });
  it("server with a key and the correct key", async () => {
    const s = await start({ apiKey: KEY });
    expect((await createHttpDriver(rt(s.url, withKey)).call(req("fake-agree"))).text).toContain("agree");
  });
});

describe("HTTP driver: errors", () => {
  it("fake-auth with a key", async () => {
    const s = await start();
    const e = await fails(createHttpDriver(rt(s.url, withKey)).call(req("fake-auth")));
    expect(e.message.startsWith("Отказ авторизации (HTTP 401)")).toBe(true);
    expect(e.message).toContain("MY_KEY");
    expect(e.message).toContain("/data/.env");
    expect(e.message).not.toContain(KEY);
    expect(e.retryable).toBe(false);
  });
  it("fake-auth without apiKeyEnv", async () => {
    const s = await start();
    const e = await fails(createHttpDriver(rt(s.url)).call(req("fake-auth")));
    expect(e.message).toContain("не задано apiKeyEnv");
    expect(e.retryable).toBe(false);
  });
  it("key not set: request is not sent", async () => {
    const s = await start();
    const e = await fails(createHttpDriver(rt(s.url, { apiKeyEnv: "MY_KEY" })).call(req("fake-agree")));
    expect(e.message).toBe("Ключ не задан: впишите значение переменной MY_KEY в файл /data/.env");
    expect(e.retryable).toBe(false);
    expect(s.requests).toHaveLength(0);
  });
  it("fake-rate", async () => {
    const s = await start();
    const e = await fails(createHttpDriver(rt(s.url)).call(req("fake-rate")));
    expect(e.message.startsWith("Превышен лимит запросов (HTTP 429)")).toBe(true);
    expect(e.retryable).toBe(true);
  });
  it("unknown model", async () => {
    const s = await start();
    const e = await fails(createHttpDriver(rt(s.url)).call(req("nope")));
    expect(e.message.startsWith("Модель не найдена: nope")).toBe(true);
    expect(e.retryable).toBe(false);
  });
  it("fake-error", async () => {
    const s = await start();
    const e = await fails(createHttpDriver(rt(s.url)).call(req("fake-error")));
    expect(e.message.startsWith("Эндпоинт ответил HTTP 500")).toBe(true);
    expect(e.retryable).toBe(true);
  });
  it("endpoint unavailable", async () => {
    const s = await start();
    const url = s.url;
    await s.close();
    const e = await fails(createHttpDriver(rt(url)).call(req("fake-agree")));
    expect(e.kind).toBe("call_error");
    expect(e.message.startsWith(`Эндпоинт недоступен: ${url}`)).toBe(true);
    expect(e.retryable).toBe(true);
  });
  it("fake-hang and abort", async () => {
    const s = await start();
    const ctl = new AbortController();
    const call = fails(createHttpDriver(rt(s.url)).call(req("fake-hang", { signal: ctl.signal })));
    // abort only once the server has the request, otherwise there is nothing to count
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    ctl.abort();
    const e = await call;
    expect(e.kind).toBe("timeout");
    expect(e.message).toBe("Запрос к эндпоинту прерван");
    await vi.waitFor(() => expect(s.closedEarly).toBe(1));
  });
  it("fake-slow: abort after the first chunk", async () => {
    const s = await start();
    const ctl = new AbortController();
    const chunks: string[] = [];
    const e = await fails(createHttpDriver(rt(s.url)).call(req("fake-slow", { signal: ctl.signal, onChunk: (t) => { chunks.push(t); ctl.abort(); } })));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(e.kind).toBe("timeout");
    await vi.waitFor(() => expect(s.closedEarly).toBe(1));
  });
  it("fake-midstream-error", async () => {
    const s = await start();
    const e = await fails(createHttpDriver(rt(s.url)).call(req("fake-midstream-error")));
    expect(e.kind).toBe("call_error");
    expect(e.message).toBe("Эндпоинт ответил HTTP 502: Provider returned error");
    expect(e.retryable).toBe(true);
  });
  it("Строковый код лимита в потоке: fake-midstream-rate is a rate limit, not HTTP 502", async () => {
    const s = await start();
    const e = await fails(createHttpDriver(rt(s.url)).call(req("fake-midstream-rate")));
    expect(e.kind).toBe("call_error");
    expect(e.message).toBe("Превышен лимит запросов (rate_limit_exceeded): Rate limit exceeded");
    expect(e.message).not.toContain("HTTP 502");
    expect(e.retryable).toBe(true);
  });
  for (const code of ["rate_limit_exceeded", "insufficient_quota"]) {
    it(`Строковый код лимита в потоке: SSE error event with ${code}`, async () => {
      const sse = `data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: {"error":{"code":"${code}"}}\n\n`;
      vi.stubGlobal("fetch", async () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
      try {
        const e = await fails(createHttpDriver(rt("http://x/v1")).call(req("m")));
        expect(e.message.startsWith(`Превышен лимит запросов (${code})`)).toBe(true);
        expect(e.message).not.toContain("HTTP 502");
        expect(e.retryable).toBe(true);
      } finally { vi.unstubAllGlobals(); }
    });
  }
});

describe("classifyHttpFailure", () => {
  const c = (status: number, body: string, runtime = rt("http://x/v1")) => classifyHttpFailure({ status, body, model: "m1", runtime });
  it("400 about an invalid model", () => {
    const r = c(400, '{"error":{"message":"xyz is not a valid model ID","code":400}}');
    expect(r.message.startsWith("Модель не найдена: m1")).toBe(true);
    expect(r.retryable).toBe(false);
  });
  it("404 without body", () => { expect(c(404, "").message.startsWith("Модель не найдена: m1")).toBe(true); });
  it("400 about something else", () => {
    const r = c(400, "bad request");
    expect(r.message).toBe("Эндпоинт ответил HTTP 400: bad request");
    expect(r.retryable).toBe(false);
  });
  for (const code of ["rate_limit_exceeded", "insufficient_quota"]) {
    it(`Строковый код лимита в потоке: ${code} with the SSE fallback status 502`, () => {
      const r = c(502, JSON.stringify({ error: { message: "slow down", code } }));
      expect(r.message).toBe(`Превышен лимит запросов (${code}): slow down`);
      expect(r.message).not.toContain("HTTP 502");
      expect(r.retryable).toBe(true);
    });
  }
  it("408 and 503 are retried", () => { expect(c(408, "").retryable).toBe(true); expect(c(503, "").retryable).toBe(true); });
  it("key in the body is hidden", () => {
    const m = c(500, `{"error":{"message":"bad key ${KEY}"}}`, rt("http://x/v1", withKey)).message;
    expect(m).not.toContain(KEY);
  });
  it("long text is truncated", () => {
    const m = c(500, "a".repeat(1000)).message;
    expect(m).toBe(`Эндпоинт ответил HTTP 500: ${"a".repeat(300)}`);
  });
});

describe("SSE parser", () => {
  const ev = (t: string) => `data: ${JSON.stringify({ t })}\n\n`;
  const run = (chunks: (string | Uint8Array)[]) => {
    const out: string[] = [];
    const p = createSseParser((d) => out.push(d));
    for (const c of chunks) p.write(c);
    p.end();
    return out;
  };
  const input = `: комментарий\r\n${ev("один")}${ev("привет, мир")}data: [DONE]\n\n${ev("после")}`.replace(/\n/g, "\r\n");
  const expected = [JSON.stringify({ t: "один" }), JSON.stringify({ t: "привет, мир" })];
  it("char by char", () => { expect(run(Array.from(input))).toEqual(expected); });
  it("byte by byte with Cyrillic", () => {
    const bytes = new TextEncoder().encode(input);
    expect(run(Array.from(bytes, (b) => Uint8Array.of(b)))).toEqual(expected);
  });
  it("two events in one chunk, \\n", () => { expect(run([ev("a") + ev("b")])).toEqual([JSON.stringify({ t: "a" }), JSON.stringify({ t: "b" })]); });
  it("without a trailing empty line", () => { expect(run(['data: {"t":"x"}'])).toEqual(['{"t":"x"}']); });
});
