import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_MODELS, startFakeServer } from "./fake-server.ts";
import type { FakeServer } from "./fake-server.ts";
import { listHttpModels } from "./models.ts";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });
const fake = async (apiKey?: string): Promise<FakeServer> => {
  const s = await startFakeServer(apiKey ? { apiKey } : {});
  closers.push(() => s.close());
  return s;
};
const raw = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
  const srv: Server = createServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
};
const KEY_FILE = "/data/.env";

describe("listHttpModels", () => {
  it("model list from the fake server", async () => {
    const s = await fake();
    expect(await listHttpModels({ baseUrl: s.url, keyFile: KEY_FILE })).toEqual({ models: [...FAKE_MODELS], confirmed: true });
  });

  it("the correct key is sent in Authorization", async () => {
    const s = await fake("sk-good");
    const r = await listHttpModels({ baseUrl: s.url, apiKeyEnv: "K", apiKey: "sk-good", keyFile: KEY_FILE });
    expect(r.confirmed).toBe(true);
    expect(s.requests[0]?.authorization).toBe("Bearer sk-good");
  });

  it("wrong key: unavailable, variable name and file, no value", async () => {
    const s = await fake("sk-good");
    const r = await listHttpModels({ baseUrl: s.url, apiKeyEnv: "MY_KEY", apiKey: "sk-bad", keyFile: KEY_FILE });
    expect(r).toMatchObject({ models: [], confirmed: false, unavailable: true });
    expect(r.reason).toContain("MY_KEY");
    expect(r.reason).toContain(KEY_FILE);
    expect(r.reason).not.toContain("sk-bad");
  });

  it("key required, but apiKeyEnv is not set", async () => {
    const s = await fake("sk-good");
    const r = await listHttpModels({ baseUrl: s.url, keyFile: KEY_FILE });
    expect(r.unavailable).toBe(true);
    expect(r.reason).toContain("не задано apiKeyEnv");
  });

  it("server closed", async () => {
    const s = await startFakeServer();
    await s.close();
    const r = await listHttpModels({ baseUrl: s.url, keyFile: KEY_FILE });
    expect(r.unavailable).toBe(true);
    expect(r.reason?.startsWith(`Эндпоинт недоступен: ${s.url}`)).toBe(true);
  });

  it("404: endpoint responds, provider is available", async () => {
    const s = await fake();
    const r = await listHttpModels({ baseUrl: `${s.url}/nope`, keyFile: KEY_FILE });
    expect(r.unavailable).toBeUndefined();
    expect(r.confirmed).toBe(false);
    expect(r.reason).toContain("HTTP 404");
  });

  it("200 in the wrong format", async () => {
    const url = await raw((_q, res) => { res.setHeader("Content-Type", "application/json"); res.end('{"foo":1}'); });
    const r = await listHttpModels({ baseUrl: url, keyFile: KEY_FILE });
    expect(r).toMatchObject({ models: [], confirmed: false });
    expect(r.unavailable).toBeUndefined();
    expect(r.reason).toContain("не в формате");
  });

  it("timeout", async () => {
    const url = await raw(() => {});
    const r = await listHttpModels({ baseUrl: url, keyFile: KEY_FILE }, 100);
    expect(r.unavailable).toBe(true);
    expect(r.reason?.startsWith(`Эндпоинт недоступен: ${url}`)).toBe(true);
  });
});
