import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MaterialsError, collectSessionMaterials, sha256Of, verifyMaterials } from "../materials.ts";
import type { CollectOptions } from "../materials.ts";
import { collectSessionMaterialsWithUrls, collectUrlMaterials, urlMaterialName } from "./collect.ts";
import type { UrlMaterial } from "./collect.ts";
import type { UrlAddress, UrlResponse, UrlTransport } from "./fetch.ts";

const PUB: UrlAddress = { address: "93.184.215.14", family: 4 };
const PRIV: UrlAddress = { address: "10.0.0.1", family: 4 };
type Reply = { status?: number; type?: string; body?: string | AsyncIterable<Uint8Array>; delay?: number };

// fake transport: the handler answers by path; the name private.test resolves to a private address
function fake(handler: (url: URL) => Reply) {
  const t = { requests: [] as URL[], transport: undefined as unknown as UrlTransport };
  t.transport = {
    async resolve(h) { return [h === "private.test" ? PRIV : PUB]; },
    async request(url): Promise<UrlResponse> {
      t.requests.push(url);
      const r = handler(url);
      if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
      const text = r.body;
      const body = typeof text === "object" ? text : (async function* () { yield new TextEncoder().encode(text ?? ""); })();
      return { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/plain" }, body, destroy() {} };
    },
  };
  return t;
}
const never = async function* (): AsyncGenerator<Uint8Array> { for (;;) await new Promise((r) => setTimeout(r, 10)); };
const now = () => new Date("2026-01-02T03:04:05.000Z");
const errOf = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as MaterialsError;

describe("collectUrlMaterials", () => {
  it("1. HTML becomes text, name and time", async () => {
    const t = fake(() => ({ type: "text/html; charset=utf-8", body: "<h1>Заголовок</h1><p>Абзац.</p><script>x()</script>" }));
    const r = await collectUrlMaterials(["https://example.com/docs/page.html?x=1#f"], { transport: t.transport, now });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: "example.com_docs_page.html", text: "Заголовок\n\nАбзац.", fetchedAt: now() });
  });

  it("2. input order and duplicates", async () => {
    const t = fake((u) => (u.pathname === "/b" ? { type: "text/markdown", body: "# B" } : { body: "a" }));
    const r = await collectUrlMaterials(["https://h.test/a", "https://h.test/b"], { transport: t.transport });
    expect(r.map((m) => m.text)).toEqual(["a", "# B"]);
    const d = fake(() => ({ body: "x" }));
    expect(await collectUrlMaterials(["https://h.test/a", "https://h.test/a"], { transport: d.transport })).toHaveLength(2);
    expect(d.requests).toHaveLength(2);
  });

  it("3. one failure does not stop the others: one error per address, in order", async () => {
    const t = fake((u) => (u.pathname === "/a" ? { status: 404 } : u.pathname === "/b" ? { type: "application/pdf" } : { body: "ok" }));
    const e = await errOf(collectUrlMaterials(["https://host/ok", "https://host/a?q=1", "https://host/b#f"], { transport: t.transport }));
    expect(e).toBeInstanceOf(MaterialsError);
    expect(e.reasons).toHaveLength(2);
    expect(e.reasons[0]).toMatch(/^«https:\/\/host\/a»: /);
    expect(e.reasons[1]).toMatch(/^«https:\/\/host\/b»: /);
    expect(t.requests).toHaveLength(3);
  });

  it("4. a secret from the query and fragment goes nowhere", async () => {
    const q = "?token=SECRETMARK#SECRETMARK";
    const t = fake((u) => {
      if (u.pathname === "/ok") return { body: "text" };
      if (u.pathname === "/404") return { status: 404 };
      if (u.pathname === "/pdf") return { type: "application/pdf" };
      if (u.pathname === "/js") return { type: "text/html", body: "<script>x()</script>" };
      return { body: never() };
    });
    const ok = await collectUrlMaterials([`https://h.test/ok${q}`], { transport: t.transport, now });
    expect(JSON.stringify(ok.map((m) => [m.name, m.text]))).not.toContain("SECRETMARK");
    const urls = ["404", "pdf", "js", "hang"].map((p) => `https://h.test/${p}${q}`).concat(`https://private.test/x${q}`);
    const e = await errOf(collectUrlMaterials(urls, { transport: t.transport, limits: { ms: 200 } }));
    expect(e.reasons).toHaveLength(5);
    expect(e.message + e.reasons.join("")).not.toContain("SECRETMARK");
  });

  it("5. not an address: number by position", async () => {
    const t = fake(() => ({ body: "x" }));
    const e = await errOf(collectUrlMaterials(["", "https://h.test/a", "  ", "не адрес"], { transport: t.transport }));
    expect(e.reasons).toEqual(["«URL №1»: не удалось разобрать адрес", "«URL №3»: не удалось разобрать адрес", "«URL №4»: не удалось разобрать адрес"]);
  });

  it("6. one deadline for fetch and extraction", async () => {
    const t = fake(() => ({ type: "text/html", body: "<p>x</p>", delay: 200 }));
    const worker = join(import.meta.dirname, "fixtures", "spin-worker.ts");
    const from = Date.now();
    const e = await errOf(collectUrlMaterials(["https://h.test/a"], { transport: t.transport, limits: { ms: 300 }, worker }));
    expect(e).toBeInstanceOf(MaterialsError);
    expect(Date.now() - from).toBeLessThan(1000);
  });

  it("7. link material name", () => {
    const n = (s: string) => urlMaterialName(new URL(s));
    expect(n("https://example.com/docs/page.html?x=1#f")).toBe("example.com_docs_page.html");
    expect(n("https://example.com/")).toBe("example.com");
    expect(n("http://example.com:8443/a/")).toBe("example.com:8443_a");
    expect(n("http://[2001:db8::1]/a/b")).toBe("[2001:db8::1]_a_b");
    expect(n("https://h.test/%D0%B0/b")).toBe("h.test_%D0%B0_b");
  });
});

describe("collectSessionMaterialsWithUrls", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "council-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const opts = (n: number): CollectOptions => ({ materialsChars: n, materialsIgnore: [] });
  const um = (path: string, text: string, host = "h.test"): UrlMaterial => {
    const url = new URL(`https://${host}${path}?k=SECRETMARK`);
    return { name: urlMaterialName(url), text, url, fetchedAt: now() };
  };
  const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p; };

  it("a. file and link: ids and source", () => {
    const set = collectSessionMaterialsWithUrls([file("a.md", "aaa")], opts(1000), [um("/p", "url text")]);
    expect(set.materials.map((m) => [m.id, m.name])).toEqual([["m1", "a.md"], ["m2", "h.test_p"]]);
    expect(set.sources).toEqual([{ id: "m2", scheme: "https", host: "h.test", pathname: "/p", fetchedAt: "2026-01-02T03:04:05.000Z" }]);
    expect(verifyMaterials(set.materials, 1000)).toEqual([]);
  });

  it("b. folder is picked into the remaining limit, the link whole and last", () => {
    const d = join(dir, "big");
    mkdirSync(d);
    writeFileSync(join(d, "a.md"), "a".repeat(60));
    writeFileSync(join(d, "b.md"), "b".repeat(60));
    const set = collectSessionMaterialsWithUrls([d], opts(100), [um("/p", "u".repeat(40))]);
    expect(set.materials.map((m) => m.name)).toEqual(["big/a.md", "h.test_p"]);
    expect(set.left.map((l) => l.name)).toEqual(["big/b.md"]);
    expect(set.sources[0]!.id).toBe("m2");
  });

  it("c. one link above the limit", () => {
    const e = (() => { try { collectSessionMaterialsWithUrls([], opts(50), [um("/p", "u".repeat(80))]); } catch (x) { return x; } })() as MaterialsError;
    expect(e).toBeInstanceOf(MaterialsError);
    expect(e.reasons[0]).toMatch(/лимит 50.*h\.test_p — 80/);
  });

  it("d. file and link together above the limit", () => {
    expect(() => collectSessionMaterialsWithUrls([file("d.md", "d".repeat(60))], opts(100), [um("/p", "u".repeat(60))])).toThrow(/лимит 100/);
  });

  it("e. identical names get a suffix", () => {
    const set = collectSessionMaterialsWithUrls([file("h.test_p", "local")], opts(1000), [um("/p", "1"), um("/p", "2"), um("/q", "3")]);
    expect(set.materials.map((m) => m.name)).toEqual(["h.test_p", "h.test_p (2)", "h.test_p (3)", "h.test_q"]);
    expect(set.sources.map((s) => s.id)).toEqual(["m2", "m3", "m4"]);
    expect(set.materials.map((m) => m.text)).toEqual(["local", "1", "2", "3"]);
  });

  it("f. only links; without links, the usual set", () => {
    const only = collectSessionMaterialsWithUrls([], opts(1000), [um("/p", "t")]);
    expect(only.materials[0]).toMatchObject({ id: "m1", sha256: sha256Of("t") });
    const p = [file("f.md", "f")];
    expect(collectSessionMaterialsWithUrls(p, opts(1000), [])).toEqual({ ...collectSessionMaterials(p, opts(1000)), sources: [] });
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

// Independent reference: the previous expression, used only on inputs whose slash runs stay short.
const oracle = (url: URL) => (url.host + url.pathname).replace(/\/+$/, "").replaceAll("/", "_");

const HOSTS = ["https://h.test", "http://example.com:8443", "http://[2001:db8::1]", "https://xn--80ak6aa92e.test", "http://127.0.0.1:8787"];
const ALPHABET = "//ax.%-_~٣ я";
const CHUNKS = ["/", "//", "%D0%B0", "?q=/", "#/", "/".repeat(64), "/a/"];
function generate(rand: () => number, length: number): string {
  let s = "";
  while (s.length < length) {
    const r = rand();
    if (r < 0.1) s += CHUNKS[Math.floor(rand() * CHUNKS.length)];
    else s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return s.slice(0, length);
}

describe("Bounded URL material name construction", () => {
  // The attack runs only in a child with a finite watchdog: a vitest timeout cannot interrupt synchronous regex work.
  it("child probe: 1,048,576 slashes before 'x' have median <= 1,000 ms and finish before the 5,000 ms watchdog", async () => {
    const probe = fileURLToPath(new URL("../../scenarios/security-url-material-name/probe.ts", import.meta.url));
    const collect = fileURLToPath(new URL("./collect.ts", import.meta.url));
    const pending = promisify(execFile)(process.execPath, [probe, collect, String(1 << 20)], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    pending.child.stdin?.end();
    const result = JSON.parse((await pending).stdout) as { n: number; samples: number[]; median: number };
    expect(result.n).toBe(1_048_576);
    expect(result.samples).toHaveLength(3);
    expect(result.median).toBeLessThanOrEqual(1_000);
  }, 10_000);

  it("boundary corpus matches the reference", () => {
    const corpus = [
      "https://h.test", "https://h.test/", "https://h.test//", "https://h.test/a//b", "https://h.test/a//b//", "https://h.test/a/?x=/#/",
      "http://example.com:8443/a/", "http://[2001:db8::1]/a/b/", "https://h.test/%D0%B0/b/", "https://h.test/я/", "https://h.test/a%2F/",
      `https://h.test${"/".repeat(64)}x`, `https://h.test/x${"/".repeat(64)}`, `https://h.test${"/".repeat(64)}`,
    ];
    for (const raw of corpus) expect(urlMaterialName(new URL(raw)), raw).toBe(oracle(new URL(raw)));
  });

  it("generated inputs over 300 seeds and boundary lengths match the reference", () => {
    for (let seed = 1; seed <= 320; seed++) {
      const rand = mulberry32(seed);
      for (const length of [0, 1, 2, 3, Math.floor(rand() * 40), 1_024, 4_096, 16_384]) {
        const url = new URL(HOSTS[Math.floor(rand() * HOSTS.length)]! + "/" + generate(rand, length));
        expect(urlMaterialName(url), `seed ${seed}, length ${length}`).toBe(oracle(url));
      }
    }
  });

  it("long slash runs: internal runs become underscores, a trailing run is removed", () => {
    for (const n of [0, 1, 2, 3, 1_024, 4_096, 16_384]) {
      const run = "/".repeat(n);
      expect(urlMaterialName(new URL(`https://h.test/${run}x`))).toBe(`h.test_${"_".repeat(n)}x`);
      expect(urlMaterialName(new URL(`https://h.test/a${run}`))).toBe("h.test_a");
      expect(urlMaterialName(new URL(`https://h.test/${run}`))).toBe("h.test");
    }
  });
});
