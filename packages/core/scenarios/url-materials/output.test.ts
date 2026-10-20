import "../language-ru.ts";
import { describe, expect, it } from "vitest";
import { formatSource } from "../../src/store/material-sources.ts";
import { assertResumedSource, sourceRows } from "./output.ts";
import type { SourceRow } from "./output.ts";

// Independent expected fields: the stand's saved sidecar record, written out literally.
const SAVED: SourceRow = { id: "m1", url: "http://docs.stand.test/doc", fetchedAt: "2026-10-19T07:14:35.127Z" };
// The real row as cli.ts prints it on resume.
const row = (s: { id: string; scheme: "http" | "https"; host: string; pathname: string; fetchedAt: string }) => `  ${formatSource(s)}`;
const REAL = row({ id: "m1", scheme: "http", host: "docs.stand.test", pathname: "/doc", fetchedAt: SAVED.fetchedAt });
const out = (...lines: string[]) => ["Сессия s1: продолжение на 2 круга", "Источники ссылок: 1", ...lines, "Итог: согласие"].join("\n");

// The stand's oracle before this change.
const substring = (o: string, s: SourceRow) => o.includes("Источники ссылок: 1") && o.includes(s.url);
// The oracle check.ts calls.
const exact = (o: string, s: SourceRow) => { try { assertResumedSource(o, s); return true; } catch { return false; } };

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
const PATHS = ["/doc", "/a/b", "/doc.html", "/"];
const QUERIES = ["?x=1", "?token=SECRET", "#frag", "?u=1#f"];
const FOREIGN = ["https://evil.test", "http://203.0.113.9:8080", "https://cdn.test/r"];
const STAMPS = ["2026-10-19T07:14:35.127Z", "2026-01-02T03:04:05.000Z"];

// Each negative class shows the expected URL somewhere other than as the whole address field of the one row with the saved id and stamp.
type Gen = { id: string; url: string; fetchedAt: string; f: string; q: string };
const line = (id: string, url: string, at: string) => `  ${id} ← ${url} · получено ${at}`;
const NEGATIVES = {
  "unrelated prose": (g: Gen) => [`Ранее читали ${g.url} вручную.`],
  "foreign path": (g: Gen) => [line(g.id, `${g.f}/${g.url}`, g.fetchedAt)],
  "foreign query": (g: Gen) => [line(g.id, `${g.f}/?next=${g.url}`, g.fetchedAt)],
  "wrong id": (g: Gen) => [line(g.id === "m1" ? "m2" : "m1", g.url, g.fetchedAt)],
  "wrong source": (g: Gen) => [line(g.id, g.f, g.fetchedAt), `  (${g.url})`],
  "lookalike host": (g: Gen) => [line(g.id, g.url.replace(/^(\w+:\/\/[^/]+)/, "$1.evil.test"), g.fetchedAt)],
  "wrong scheme": (g: Gen) => [line(g.id, g.url.startsWith("https:") ? g.url.replace("https:", "http:") : g.url.replace("http:", "https:"), g.fetchedAt)],
  "leaked query": (g: Gen) => [line(g.id, `${g.url}${g.q}`, g.fetchedAt)],
  "wrong stamp": (g: Gen) => [line(g.id, g.url, "2020-01-01T00:00:00.000Z")],
  "trailing text": (g: Gen) => [`${line(g.id, g.url, g.fetchedAt)} и ещё`],
  "extra row": (g: Gen) => [line(g.id, g.url, g.fetchedAt), line("m2", g.f, g.fetchedAt)],
};
type Negative = keyof typeof NEGATIVES;
const CLASSES = Object.keys(NEGATIVES) as Negative[];

function generate(seed: number) {
  const rnd = mulberry32(seed);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
  const g: Gen = {
    id: pick(["m1", "m2", "m7"]), url: `${pick(["http", "https"])}://${pick(HOSTS)}${pick(PATHS)}`,
    fetchedAt: pick(STAMPS), f: pick(FOREIGN), q: pick(QUERIES),
  };
  const kind: Negative | "correct" = CLASSES[seed % (CLASSES.length + 2)] ?? "correct";
  const saved: SourceRow = { id: g.id, url: g.url, fetchedAt: g.fetchedAt };
  const lines = kind === "correct" ? [line(g.id, g.url, g.fetchedAt)] : NEGATIVES[kind](g);
  return { kind, saved, o: out(...lines) };
}

describe("Resumed source row matches saved snapshot", () => {
  it("the real resume row is parsed into the saved id, safe address and stamp", () => {
    expect(sourceRows(out(REAL))).toEqual([SAVED]);
    expect(exact(out(REAL), SAVED)).toBe(true);
    expect(exact(out(REAL), { ...SAVED, url: "http://docs.stand.test/do" })).toBe(false);
    expect(exact(out(REAL), { ...SAVED, fetchedAt: "2026-10-19T07:14:35.128Z" })).toBe(false);
  });

  it("fixed negatives: the substring oracle accepts them, the row check rejects them", () => {
    const u = SAVED.url, at = SAVED.fetchedAt;
    const fixed = [
      out(`Адрес ${u} упомянут в тексте.`),
      out(line("m1", `https://evil.test/${u}`, at)),
      out(line("m1", `https://evil.test/?next=${u}`, at)),
      out(line("m2", u, at)),
      out(line("m1", "https://evil.test/a", at), `  см. ${u}`),
      out(line("m1", `${u}?token=SECRET`, at)),
      out(line("m1", `${u}#frag`, at)),
      out(line("m1", `${u}.evil.test/`, at)),
      out(line("m1", u, "2020-01-01T00:00:00.000Z")),
      out(`${REAL} и ещё`),
      out(REAL, line("m2", "https://evil.test/a", at)),
      out(`m1 ← ${u} · получено ${at}`),
    ];
    for (const o of fixed) {
      expect(substring(o, SAVED), o).toBe(true);
      expect(exact(o, SAVED), o).toBe(false);
    }
    // Rejected by both oracles: wrong scheme and a lookalike host.
    for (const o of [out(line("m1", "https://docs.stand.test/doc", at)), out(line("m1", "http://docs.stand.test.evil.test/doc", at))]) {
      expect(substring(o, SAVED), o).toBe(false);
      expect(exact(o, SAVED), o).toBe(false);
    }
  });

  it("seeded rows: only the saved row is accepted; the substring oracle fails the same property", () => {
    const seen = new Set<string>();
    const fooled = new Set<string>();
    for (let seed = 0; seed < 650; seed++) {
      const { kind, saved, o } = generate(seed);
      seen.add(kind);
      expect(exact(o, saved), `${kind}: ${o}`).toBe(kind === "correct");
      if (kind !== "correct" && substring(o, saved)) fooled.add(kind);
    }
    expect([...seen].sort()).toEqual([...CLASSES, "correct"].sort());
    // Mutation proof: swapping the row check back to the substring oracle breaks the property above.
    expect([...fooled].sort()).toEqual(CLASSES.filter((k) => k !== "lookalike host" && k !== "wrong scheme").sort());
  });
});
