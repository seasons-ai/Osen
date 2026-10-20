import "../../../../packages/core/scenarios/language-ru.ts";
import { describe, expect, it } from "vitest";
import { collectUrlMaterials } from "../../../../packages/core/src/index.ts";
import type { MaterialsError, UrlTransport } from "../../../../packages/core/src/index.ts";
import { assertNamesSource, refusalSources } from "./diagnostic.ts";

const SOURCE = "https://docs.stand.test/missing";
// The stand's oracle before this change.
const substring = (d: string, expected: string) => d.includes(expected) && !d.includes("x=1");
// The oracle check.ts calls.
const exact = (d: string, expected: string) => { try { assertNamesSource(d, expected); return true; } catch { return false; } };

// The real refusal from the core message path: a public name answering 404, as the stand's transport does.
async function refusal(url: string): Promise<string> {
  const transport: UrlTransport = {
    async resolve() { return [{ address: "93.184.215.14", family: 4 }]; },
    async request() { return { status: 404, headers: {}, body: (async function* () {})(), destroy() {} }; },
  };
  const e = await collectUrlMaterials([url], { transport }).then(() => null, (err: unknown) => err as MaterialsError);
  if (!e) throw new Error("a refusal was expected");
  return e.reasons.join("\n");
}

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTS = ["docs.stand.test", "h.test", "example.com:8443"];
const PATHS = ["/missing", "/a/b", "/doc.html", "/"];
const QUERIES = ["?x=1", "?token=SECRET", "?y=2&z", "#frag", "?u=1#f"];
const FOREIGN = ["https://evil.test", "http://203.0.113.9:8080", "https://cdn.test/r"];

// Each negative class names the expected source somewhere other than as the whole address field.
const NEGATIVES = {
  "foreign path": (src: string, f: string) => `«${f}/${src}»`,
  "foreign query": (src: string, f: string) => `«${f}/?next=${src}»`,
  "lookalike host": (src: string) => `«${src.replace(/^(\w+:\/\/[^/]+)/, "$1.evil.test")}»`,
  "userinfo lookalike": (src: string, f: string) => `«${src}@${f.replace(/^\w+:\/\//, "")}/»`,
  "wrong scheme": (src: string) => `«s${src}»`,
  "longer path": (src: string) => `«${src}-old»`,
  "source only in the reason": (src: string, f: string) => `«${f}»`,
};
type Negative = keyof typeof NEGATIVES;
const CLASSES = Object.keys(NEGATIVES) as Negative[];

function generate(seed: number, reason: string) {
  const rnd = mulberry32(seed);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
  const scheme = pick(["https", "http"]);
  const src = `${scheme}://${pick(HOSTS)}${pick(PATHS)}`;
  const f = pick(FOREIGN);
  const kind = CLASSES[seed % (CLASSES.length + 3)] ?? (seed % 2 ? "leaked query" : "correct");
  const tail = kind === "source only in the reason" ? `${reason} (${src})` : reason;
  const line = (field: string) => `${field}: ${tail}`;
  if (kind === "correct") return { kind, src, d: line(`«${src}»`) };
  if (kind === "leaked query") return { kind, src, d: line(`«${src}${pick(QUERIES)}»`) };
  return { kind, src, d: line(NEGATIVES[kind](src, f)) };
}

describe("404 diagnostic identifies its safe source", () => {
  it("the real 404 refusal names exactly its query-free source", async () => {
    const d = await refusal(`${SOURCE}?x=1`);
    expect(d).toMatch(/404/);
    expect(refusalSources(d)).toEqual([SOURCE]);
    expect(exact(d, SOURCE)).toBe(true);
    expect(exact(d, "https://docs.stand.test/missin")).toBe(false);
  });

  it("fixed negatives: the substring oracle accepts them, the field check rejects them", async () => {
    const reason = (await refusal(`${SOURCE}?x=1`)).split("»: ")[1]!;
    const fixed = [
      `«https://evil.test/${SOURCE}»: ${reason}`,
      `«https://evil.test/?next=${SOURCE}»: ${reason}`,
      `«${SOURCE}@evil.test/»: ${reason}`,
      `«${SOURCE}-old»: ${reason}`,
      `«${SOURCE}?token=SECRET»: ${reason}`,
      `«${SOURCE}#frag»: ${reason}`,
      `«https://evil.test/a»: ${reason} (${SOURCE})`,
      `«${SOURCE}»: ${reason}\n«https://evil.test/a»: ${reason}`,
      `${SOURCE}: ${reason}`,
    ];
    for (const d of fixed) {
      expect(substring(d, SOURCE), d).toBe(true);
      expect(exact(d, SOURCE), d).toBe(false);
    }
    // Rejected by both oracles: wrong scheme and a lookalike host.
    for (const d of [`«http://docs.stand.test/missing»: ${reason}`, `«https://docs.stand.test.evil.test/missing»: ${reason}`]) {
      expect(substring(d, SOURCE), d).toBe(false);
      expect(exact(d, SOURCE), d).toBe(false);
    }
  });

  it("seeded lookalikes: only the whole safe source is accepted; the substring oracle fails the same property", async () => {
    const reason = (await refusal(`${SOURCE}?x=1`)).split("»: ")[1]!;
    const seen = new Set<string>();
    const fooled = new Set<string>();
    for (let seed = 0; seed < 600; seed++) {
      const { kind, src, d } = generate(seed, reason);
      seen.add(kind);
      expect(exact(d, src), `${kind}: ${d}`).toBe(kind === "correct");
      if (kind !== "correct" && substring(d, src)) fooled.add(kind);
    }
    expect([...seen].sort()).toEqual([...CLASSES, "correct", "leaked query"].sort());
    // Mutation proof: swapping the field check back to the substring oracle breaks the property above.
    expect([...fooled].sort()).toEqual(CLASSES.filter((k) => k !== "lookalike host").concat("leaked query").sort());
  });
});
