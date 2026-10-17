import { afterAll, beforeAll, describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchUrl, nodeTransport, UrlFetchError } from "./fetch.ts";
import type { UrlAddress, UrlResponse, UrlTransport } from "./fetch.ts";

const limits = { ms: 200, bytes: 1000 };
const PUB: UrlAddress = { address: "93.184.215.14", family: 4 };
const PRIV: UrlAddress = { address: "10.0.0.1", family: 4 };
type Reply = { status?: number; headers?: Record<string, string>; body?: Uint8Array[] | AsyncIterable<Uint8Array> };

function fake(hosts: Record<string, UrlAddress[] | (() => UrlAddress[]) | "hang">, handler: (url: URL, address: UrlAddress) => Reply | "hang") {
  const t = {
    resolves: [] as string[], requests: [] as { url: URL; address: UrlAddress; signal: AbortSignal }[], destroyed: 0, yielded: 0, iterated: 0,
    transport: undefined as unknown as UrlTransport,
  };
  t.transport = {
    async resolve(h) {
      t.resolves.push(h);
      const e = hosts[h];
      if (e === "hang") return new Promise(() => {});
      if (!e) throw new Error("ENOTFOUND secret");
      return typeof e === "function" ? e() : e;
    },
    async request(url, address, signal): Promise<UrlResponse> {
      t.requests.push({ url, address, signal });
      const r = handler(url, address);
      if (r === "hang") return new Promise(() => {});
      const src = r.body ?? [];
      const body: AsyncIterable<Uint8Array> = Symbol.asyncIterator in Object(src) ? (src as AsyncIterable<Uint8Array>) : (async function* () { t.iterated++; for (const c of src as Uint8Array[]) { t.yielded++; yield c; } })();
      return { status: r.status ?? 200, headers: { "content-type": "text/plain", ...r.headers }, body, destroy: () => { t.destroyed++; } };
    },
  };
  return t;
}
const ok = (): Reply => ({ body: [new TextEncoder().encode("hi")] });
const fails = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(UrlFetchError);
  expect((e as UrlFetchError).code).toBe(code);
  expect((e as UrlFetchError).message).toBe((e as UrlFetchError).reason);
  return e as UrlFetchError;
};
const never = async function* (): AsyncGenerator<Uint8Array> { for (;;) await new Promise((r) => setTimeout(r, 10)); };

describe("fetching one URL", () => {
  it("1. literal non-public address: private without resolve and request", async () => {
    for (const u of ["http://10.0.0.5/x", "http://127.0.0.1/x", "http://[::1]/x", "http://[fd00::1]/x"]) {
      const t = fake({}, ok);
      await fails(fetchUrl(u, { transport: t.transport, limits }), "private");
      expect(t.resolves.length + t.requests.length).toBe(0);
    }
  });

  it("2. name with a public and a private address: private, request not called", async () => {
    const t = fake({ "h.test": [PUB, PRIV] }, ok);
    await fails(fetchUrl("http://h.test/", { transport: t.transport, limits }), "private");
    expect(t.requests.length).toBe(0);
  });

  it("3. DNS change: the name is resolved once, the request goes to the checked address", async () => {
    let n = 0;
    const t = fake({ "h.test": () => (n++ === 0 ? [PUB] : [PRIV]) }, ok);
    const r = await fetchUrl("http://h.test/", { transport: t.transport, limits });
    expect(r.bytes.toString()).toBe("hi");
    expect(t.resolves.length).toBe(1);
    expect(t.requests[0]!.address).toEqual(PUB);
  });

  it("4. redirects", async () => {
    const chain = (n: number) => fake({ "h.test": [PUB] }, (url) => {
      const i = Number(url.pathname.slice(1) || 0);
      return i < n ? { status: 302, headers: { location: `/${i + 1}` } } : ok();
    });
    const a = chain(3);
    const r = await fetchUrl("http://h.test/", { transport: a.transport, limits });
    expect(r.url.href).toBe("http://h.test/");
    expect(a.requests.map((q) => q.url.pathname)).toEqual(["/", "/1", "/2", "/3"]);
    expect(a.resolves.length).toBe(4);
    const b = chain(4);
    await fails(fetchUrl("http://h.test/", { transport: b.transport, limits }), "redirects");
    const loc = (location?: string) => fake({ "h.test": [PUB], "p.test": [PRIV] }, (url) => (url.host === "h.test" && url.pathname === "/" ? { status: 301, headers: location ? { location } : {} } : ok()));
    for (const l of ["http://p.test/", "http://[fd00::1]/"]) {
      const t = loc(l);
      const e = await fails(fetchUrl("http://h.test/", { transport: t.transport, limits }), "private");
      expect(e.reason).toContain("перенаправление на непубличный адрес");
      expect(t.requests.length).toBe(1);
    }
    await fails(fetchUrl("http://h.test/", { transport: loc("ftp://h.test/x").transport, limits }), "scheme");
    await fails(fetchUrl("http://h.test/", { transport: loc().transport, limits }), "redirect");
  });

  it("5. stream without Content-Length over the limit: size, response closed, stream not read", async () => {
    const t = fake({ "h.test": [PUB] }, () => ({ body: Array.from({ length: 1000 }, () => new Uint8Array(100)) }));
    await fails(fetchUrl("http://h.test/", { transport: t.transport, limits }), "size");
    expect(t.destroyed).toBeGreaterThan(0);
    expect(t.yielded).toBeLessThan(20);
  });

  it("6. content-length over the limit: size, body not read", async () => {
    const t = fake({ "h.test": [PUB] }, () => ({ headers: { "content-length": "1001" }, body: [new Uint8Array(1)] }));
    await fails(fetchUrl("http://h.test/", { transport: t.transport, limits }), "size");
    expect(t.iterated).toBe(0);
  });

  it("7. endless body, hanging resolve and request: timeout", async () => {
    const t0 = Date.now();
    await fails(fetchUrl("http://h.test/", { transport: fake({ "h.test": [PUB] }, () => ({ body: never() })).transport, limits }), "timeout");
    expect(Date.now() - t0).toBeLessThan(1000);
    await fails(fetchUrl("http://h.test/", { transport: fake({ "h.test": "hang" }, ok).transport, limits }), "timeout");
    const t = fake({ "h.test": [PUB] }, () => "hang");
    await fails(fetchUrl("http://h.test/", { transport: t.transport, limits }), "timeout");
    expect(t.requests[0]!.signal.aborted).toBe(true);
  });

  it("8. status, encoding, type, charset", async () => {
    const run = (r: Reply) => fetchUrl("http://h.test/", { transport: fake({ "h.test": [PUB] }, () => r).transport, limits });
    await fails(run({ status: 404 }), "status");
    await fails(run({ headers: { "content-encoding": "gzip" } }), "encoding");
    await fails(run({ headers: { "content-type": "application/pdf" } }), "type");
    const noType = fake({ "h.test": [PUB] }, () => ({ body: [] }));
    const orig = noType.transport.request;
    noType.transport.request = async (...a) => { const r = await orig(...a); delete r.headers["content-type"]; return r; };
    await fails(fetchUrl("http://h.test/", { transport: noType.transport, limits }), "type");
    const r = await run({ headers: { "content-type": "text/html; charset=UTF-8" }, body: [new Uint8Array(1)] });
    expect(r.contentType).toBe("text/html");
    expect(r.charset).toBe("utf-8");
  });

  it("9. login, scheme and junk are rejected before resolve", async () => {
    for (const [u, code] of [["https://user:pass@example.com/doc", "credentials"], ["ftp://example.com/doc", "scheme"], ["not a url", "invalid"]] as const) {
      const t = fake({}, ok);
      await fails(fetchUrl(u, { transport: t.transport, limits }), code);
      expect(t.resolves.length).toBe(0);
    }
  });

  it("10. reasons contain neither the request nor the address fragment", async () => {
    const U = "https://h.test/p?token=SECRETMARK#fragSECRETMARK";
    const cases: [Record<string, UrlAddress[] | "hang">, (u: URL) => Reply | "hang"][] = [
      [{}, ok],
      [{ "h.test": [PRIV] }, ok],
      [{ "h.test": [PUB] }, () => ({ status: 302, headers: { location: "ftp://h.test/?q=SECRETMARK" } })],
      [{ "h.test": [PUB] }, () => ({ status: 302 })],
      [{ "h.test": [PUB] }, () => ({ status: 302, headers: { location: "/?q=SECRETMARK" } })],
      [{ "h.test": [PUB] }, () => ({ status: 500 })],
      [{ "h.test": [PUB] }, () => ({ headers: { "content-encoding": "gzip?a=b" } })],
      [{ "h.test": [PUB] }, () => ({ headers: { "content-type": "x/y?a=b" } })],
      [{ "h.test": [PUB] }, () => ({ headers: { "content-length": "5000" } })],
      [{ "h.test": "hang" }, ok],
      [{ "h.test": [PUB] }, () => "hang"],
    ];
    for (const [hosts, h] of cases) {
      const e = await fetchUrl(U, { transport: fake(hosts, h).transport, limits }).then(() => null, (x: UrlFetchError) => x);
      expect(e).toBeInstanceOf(UrlFetchError);
      expect(e!.message).not.toContain("SECRETMARK");
      expect(e!.reason).not.toContain("SECRETMARK");
    }
    const tr = fake({ "h.test": [PUB] }, ok);
    tr.transport.request = async () => { throw Object.assign(new Error("boom SECRETMARK"), { code: "ECONNRESET" }); };
    const e = await fails(fetchUrl(U, { transport: tr.transport, limits }), "network");
    expect(e.reason).toBe("сетевая ошибка — ECONNRESET");
  });
});

describe("real sockets", () => {
  let server: http.Server;
  let port = 0;
  let hits = 0;
  let seen: http.IncomingHttpHeaders = {};
  beforeAll(async () => {
    server = http.createServer((req, res) => { hits++; seen = req.headers; res.setHeader("content-type", "text/plain"); res.end("pinned body"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("11. nodeTransport connects to the pinned address, Host and headers are correct", async () => {
    const res = await nodeTransport.request(new URL(`http://pinned.example.test:${port}/doc?x=1`), { address: "127.0.0.1", family: 4 }, new AbortController().signal);
    let text = "";
    for await (const c of res.body) text += Buffer.from(c).toString();
    res.destroy();
    expect(res.status).toBe(200);
    expect(text).toBe("pinned body");
    expect(seen.host).toBe(`pinned.example.test:${port}`);
    expect(seen["accept-encoding"]).toBe("identity");
    expect(seen.cookie).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
  });

  it("12. fetchUrl with the default transport does not go to loopback", async () => {
    const before = hits;
    await fails(fetchUrl(`http://127.0.0.1:${port}/doc`), "private");
    expect(hits).toBe(before);
  });
});
