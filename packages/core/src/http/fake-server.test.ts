import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, expect, vi } from "vitest";
import { FAKE_AMEND, FAKE_MODELS, FAKE_USAGE, startFakeServer } from "./fake-server.ts";
import type { FakeServer, FakeServerOptions } from "./fake-server.ts";

const servers: FakeServer[] = [];
const start = async (o?: FakeServerOptions) => {
  const s = await startFakeServer(o);
  servers.push(s);
  return s;
};
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const post = (s: FakeServer, model: string, init: RequestInit = {}) =>
  fetch(`${s.url}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, stream: true, messages: [] }), ...init });
const events = async (res: Response) =>
  (await res.text()).split("\n\n").filter((e) => e.startsWith("data: ")).map((e) => e.slice(6));

describe("fake server", () => {
  it("GET /models returns FAKE_MODELS", async () => {
    const s = await start();
    const body = (await (await fetch(`${s.url}/models`)).json()) as { object: string; data: { id: string; object: string }[] };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual([...FAKE_MODELS]);
  });

  it("fake-amend: SSE stream with chunks, usage and [DONE]", async () => {
    const s = await start();
    const res = await post(s, "fake-amend");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const ev = await events(res);
    expect(ev.at(-1)).toBe("[DONE]");
    const parsed = ev.slice(0, -1).map((e) => JSON.parse(e) as { choices: { delta: { content?: string } }[]; usage?: unknown });
    const chunks = parsed.map((p) => p.choices[0]?.delta.content).filter((c): c is string => typeof c === "string" && c !== "");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(FAKE_AMEND);
    expect(parsed.find((p) => p.usage)?.usage).toEqual(FAKE_USAGE);
  });

  it("fake-plain: plain JSON even with stream: true", async () => {
    const s = await start();
    const res = await post(s, "fake-plain");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const b = (await res.json()) as { choices: { message: { content: string } }[]; usage: unknown };
    expect(b.choices[0]?.message.content).toBe(FAKE_AMEND);
    expect(b.usage).toEqual(FAKE_USAGE);
  });

  it("fake-cost: usage includes cost", async () => {
    const s = await start();
    const ev = await events(await post(s, "fake-cost"));
    const usage = ev.slice(0, -1).map((e) => JSON.parse(e) as { usage?: { cost?: number } }).find((p) => p.usage)?.usage;
    expect(usage?.cost).toBe(0.00012);
  });

  it("error codes: auth, rate, error, unknown model, bad body", async () => {
    const s = await start();
    const auth = await post(s, "fake-auth", { headers: { "Content-Type": "application/json", Authorization: "Bearer sk-secret" } });
    expect(auth.status).toBe(401);
    expect(await auth.text()).toContain("Bearer sk-secret");
    const rate = await post(s, "fake-rate");
    expect(rate.status).toBe(429);
    expect(rate.headers.get("retry-after")).toBe("1");
    expect((await post(s, "fake-error")).status).toBe(500);
    const nf = await post(s, "nope");
    expect(nf.status).toBe(404);
    const nb = (await nf.json()) as { error: { code: string; message: string } };
    expect(nb.error.code).toBe("model_not_found");
    expect(nb.error.message).toContain("nope");
    expect((await post(s, "x", { body: "не json" })).status).toBe(400);
    expect((await fetch(`${s.url}/other`)).status).toBe(404);
  });

  it("apiKey: no key, a foreign key gets 401, the correct key gets 200", async () => {
    const s = await start({ apiKey: "k1" });
    expect((await fetch(`${s.url}/models`)).status).toBe(401);
    expect((await post(s, "fake-agree", { headers: { "Content-Type": "application/json", Authorization: "Bearer bad" } })).status).toBe(401);
    const h = { "Content-Type": "application/json", Authorization: "Bearer k1" };
    expect((await fetch(`${s.url}/models`, { headers: h })).status).toBe(200);
    expect((await post(s, "fake-agree", { headers: h })).status).toBe(200);
  });

  it("fake-hang: client disconnect counts as closedEarly", async () => {
    const s = await start();
    const ac = new AbortController();
    const res = post(s, "fake-hang", { signal: ac.signal });
    // abort only once the server has the request, otherwise there is nothing to count
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    ac.abort();
    await expect(res).rejects.toThrow();
    await vi.waitFor(() => expect(s.closedEarly).toBe(1));
  });

  it("fake-slow: first chunk received, disconnect counts", async () => {
    const s = await start();
    const ac = new AbortController();
    const res = await post(s, "fake-slow", { signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let got = "";
    while (!got.includes("data: ")) got += dec.decode((await reader.read()).value);
    ac.abort();
    await reader.read().catch(() => undefined);
    await vi.waitFor(() => expect(s.closedEarly).toBe(1));
  });

  it("fake-midstream-error: the stream has an error event", async () => {
    const s = await start();
    const ev = await events(await post(s, "fake-midstream-error"));
    expect(ev.at(-1)).toBe("[DONE]");
    expect(ev.some((e) => e !== "[DONE]" && "error" in (JSON.parse(e) as object))).toBe(true);
  });

  it("requests stores method, path, authorization and body", async () => {
    const s = await start();
    await post(s, "fake-error", { headers: { "Content-Type": "application/json", Authorization: "Bearer a" } });
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]).toMatchObject({ method: "POST", path: "/v1/chat/completions", authorization: "Bearer a", body: { model: "fake-error" } });
  });

  it("close() finishes with a hanging request", async () => {
    const s = await start();
    const p = post(s, "fake-hang").catch(() => "оборван");
    await vi.waitFor(() => expect(s.requests).toHaveLength(1));
    await s.close();
    expect(await p).toBe("оборван");
  });

  it("runs as a program and prints the real address", async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./fake-server.ts", import.meta.url)), "--port", "0"]);
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (c: Buffer) => {
          out += c.toString();
          const m = /Fake server: (http:\/\/127\.0\.0\.1:\d+\/v1)/.exec(out);
          if (m?.[1]) resolve(m[1]);
        });
        child.on("error", reject);
        child.on("exit", () => reject(new Error(`процесс завершился: ${out}`)));
      });
      expect(url).not.toMatch(/:0\//);
      expect((await fetch(`${url}/models`)).status).toBe(200);
    } finally {
      child.kill();
    }
  });
});
