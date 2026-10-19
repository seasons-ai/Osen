import { describe, expect, it } from "vitest";
import type { HttpProvider } from "./config.ts";
import { inspectProvider } from "./providers.ts";

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
const oracle = (raw: string) => raw.replace(/\/+$/, "");

const noModels = { listHttpModels: () => { throw new Error("model listing must not run"); } };
const provider = (baseUrl: string, extra: Partial<HttpProvider> = {}): HttpProvider => ({ id: "gw", kind: "openai-http", label: "GW", models: [], baseUrl, ...extra });
async function normalized(baseUrl: string, extra: Partial<HttpProvider> = {}, env: Record<string, string> = {}) {
  const r = await inspectProvider(provider(baseUrl, extra), { env, withModels: false, deps: noModels });
  if (r.http) expect(r.http.baseUrl, "status and runtime use the same string").toBe(r.status.baseUrl);
  return r;
}

const ALPHABET = "//ax.:?#=%-٣ ";
const CHUNKS = ["https://h.test", "http://127.0.0.1:8787", "/v1", "//", "?q=/", "#/", "/".repeat(64)];
function generate(rand: () => number, length: number): string {
  let s = "";
  while (s.length < length) {
    const r = rand();
    if (r < 0.1) s += CHUNKS[Math.floor(rand() * CHUNKS.length)];
    else s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return s.slice(0, length);
}

describe("Bounded provider base URL normalization", () => {
  it("compatibility examples", async () => {
    expect((await normalized("https://h.test/v1///")).status.baseUrl).toBe("https://h.test/v1");
    expect((await normalized("https://h.test/v1")).status.baseUrl).toBe("https://h.test/v1");
    expect((await normalized("https://h.test/a//b")).status.baseUrl).toBe("https://h.test/a//b");
    expect((await normalized("https://h.test/v1?a=/")).status.baseUrl).toBe("https://h.test/v1?a=");
    expect((await normalized("https://h.test/v1/#/")).status.baseUrl).toBe("https://h.test/v1/#");
    expect((await normalized("")).status.baseUrl).toBe("");
    expect((await normalized("///")).status.baseUrl).toBe("");
  });

  it("key missing: status keeps the normalized URL, no runtime", async () => {
    const r = await normalized("https://h.test/v1//", { apiKeyEnv: "STAND_KEY" });
    expect(r.status).toMatchObject({ available: false, baseUrl: "https://h.test/v1", keyEnv: "STAND_KEY", keySet: false });
    expect(r.http).toBeUndefined();
    const set = await normalized("https://h.test/v1//", { apiKeyEnv: "STAND_KEY" }, { STAND_KEY: "k" });
    expect(set.http).toMatchObject({ baseUrl: "https://h.test/v1", apiKeyEnv: "STAND_KEY", apiKey: "k" });
    expect(JSON.stringify(set.status)).not.toContain("\"k\"");
  });

  it("boundary corpus matches the reference", async () => {
    const corpus = [
      "/", "x/", "/x", "x//y/", "https://h.test", "https://h.test/", "https://h.test//", "https://h.test/v1/ ", "https://h.test/v1/\n",
      "https://h.test/v1\\", "https://h.test/v1/٣/", "/".repeat(64) + "x", "x" + "/".repeat(64), "/".repeat(64),
    ];
    for (const raw of corpus) expect((await normalized(raw)).status.baseUrl, JSON.stringify(raw)).toBe(oracle(raw));
  });

  it("generated inputs over 300 seeds and boundary lengths match the reference", async () => {
    for (let seed = 1; seed <= 320; seed++) {
      const rand = mulberry32(seed);
      for (const length of [0, 1, 2, 3, Math.floor(rand() * 40), 1_024, 4_096, 16_384]) {
        const raw = generate(rand, length);
        expect((await normalized(raw)).status.baseUrl, `seed ${seed}, length ${length}`).toBe(oracle(raw));
      }
    }
  });

  it("long slash runs: internal runs stay, a trailing run is removed", async () => {
    for (const n of [0, 1, 2, 3, 1_024, 4_096, 16_384]) {
      const run = "/".repeat(n);
      expect((await normalized(`https://h.test${run}x`)).status.baseUrl).toBe(`https://h.test${run}x`);
      expect((await normalized(`https://h.test/v1${run}`)).status.baseUrl).toBe("https://h.test/v1");
      expect((await normalized(run)).status.baseUrl).toBe("");
    }
  });
});
