import { describe, expect, it } from "vitest";
import { APP_URL, isAllowedRequest, rendererFile } from "./window.ts";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOT = "/app/out/renderer";

// Reference: the raw path as written by the generator, before WHATWG normalization.
// Dots collapse by raw segments (".", "%2e" in any case);
// among the remaining segments an encoded separator or a broken encoding is always "outside".
// Returns the remaining decoded segments or null ("outside"); the host is only osen, case-insensitive.
const DOT = /^(?:\.|%2e)$/i;
const DOTDOT = /^(?:\.|%2e)(?:\.|%2e)$/i;
function kept(scheme: string, host: string, rawPath: string): string[] | null {
  if (scheme !== "app" || host.toLowerCase() !== "osen") return null;
  // An empty segment ("//") is removed by ".." like an ordinary one and does not take part in the comparison.
  const stack: string[] = [];
  for (const s of rawPath.split("/").slice(1)) {
    if (DOT.test(s)) continue;
    if (DOTDOT.test(s)) { stack.pop(); continue; }
    stack.push(s);
  }
  const k = stack.filter((s) => s !== "");
  if (k.some((s) => /%2f|%5c/i.test(s))) return null;
  try { return k.map((s) => decodeURIComponent(s)); } catch { return null; }
}

const POOL = ["assets", "index.html", "a.js", "x.woff2", "..", ".", "%2e", "%2E", "%2e%2e", ".%2e", "%2E.", "%2f", "%5c", "", "etc", "hosts", ".env", encodeURIComponent("Мозговой штурм"), "%zz"];
const HOSTS = ["osen", "OSEN", "evil", ""];

type Case = { url: string; scheme: string; host: string; path: string };
const mk = (host: string, path: string, scheme = "app"): Case => ({ url: `${scheme}://${host}${path}`, scheme, host, path });

function cases(seed: number, n: number): Case[] {
  const r = mulberry32(seed);
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!;
  return Array.from({ length: n }, () => {
    const segs = Array.from({ length: Math.floor(r() * 8) }, () => pick(POOL));
    const path = "/" + segs.join("/");
    return r() < 0.1 ? mk(pick(["", "localhost", "osen"]), path, "file") : mk(r() < 0.6 ? "osen" : pick(HOSTS), path);
  });
}

// Fixed boundaries go before random ones.
const BOUNDARY: Case[] = [
  mk("osen", "/index.html"),
  mk("osen", "/"),
  mk("osen", "/assets/../a.js"),
  mk("osen", "/../a.js"),
  mk("osen", "/etc/passwd"),
  mk("osen", "/%2e%2e/%2e%2e/etc/hosts"),
  mk("OSEN", "/assets/a.js"),
  mk("evil", "/index.html"),
  mk("", "/index.html"),
  mk("osen", "/%2e%2e%2fsecret"),
  mk("osen", "/%2f/%2e%2e/a.js"),
  mk("osen", "//../a.js"),
  mk("osen", "/a%5cb"),
  mk("osen", "/%zz"),
  mk("", "/app/out/renderer/index.html", "file"),
  mk("", "/etc/hosts", "file"),
  mk("", "/Users/x/Library/Application%20Support/osen/.env", "file"),
  mk("osen", "/index.html", "file"),
];

const within = (p: string) => p.startsWith(ROOT + "/");

describe("Requirement \"Ban on external content\"", () => {
  it("an app address is allowed and served by the handler if and only if the reference says \"inside\"; any file: — \"outside\"", () => {
    const all = [...BOUNDARY, ...[1, 2, 3, 4, 5].flatMap((seed) => cases(seed, 600))];
    for (const c of all) {
      const k = kept(c.scheme, c.host, c.path);
      expect(isAllowedRequest(c.url, APP_URL), c.url).toBe(k !== null);
      const f = rendererFile(c.url, ROOT);
      expect(f !== null, c.url).toBe(k !== null && k.length > 0);
      if (f !== null) expect(within(f), `${c.url} → ${f}`).toBe(true);
    }
    expect(all.length).toBeGreaterThanOrEqual(2000);
  });
  it("the reference agrees with WHATWG: \"inside\" by the reference — the same segments after normalization", () => {
    for (const c of [...BOUNDARY, ...cases(6, 600)]) {
      const k = kept(c.scheme, c.host, c.path);
      if (k === null) continue;
      const segs = new URL(c.url).pathname.split("/").filter((s) => s !== "").map(decodeURIComponent);
      expect(segs, `${c.url} → ${new URL(c.url).pathname}`).toEqual(k);
    }
  });
  it("boundary URLs: foreign schemes", () => {
    expect(isAllowedRequest("http://evil/", APP_URL)).toBe(false);
    for (const u of ["devtools://x", "data:,x", "blob:file:///x"]) expect(isAllowedRequest(u, APP_URL), u).toBe(true);
  });
});
