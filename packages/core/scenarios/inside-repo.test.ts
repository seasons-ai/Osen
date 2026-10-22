import { describe, it, expect } from "vitest";
import { isInsideRepo } from "./inside-repo.ts";

const nfc = (s: string) => s.normalize("NFC");
const nfd = (s: string) => s.normalize("NFD");
const REPO = "/Users/k/Desktop/Мозговой штурм";

describe("isInsideRepo", () => {
  it("accepts a folder in NFC under a project path in NFD, and the reverse", () => {
    expect(nfd(REPO)).not.toBe(nfc(REPO));
    expect(isInsideRepo(nfd(REPO), nfc(`${REPO}/.council-data/x`))).toBe(true);
    expect(isInsideRepo(nfc(REPO), nfd(`${REPO}/.council-data/x`))).toBe(true);
  });

  it("accepts the project itself and rejects folders outside it", () => {
    expect(isInsideRepo(nfd(REPO), nfc(REPO))).toBe(true);
    expect(isInsideRepo(nfd(REPO), "/tmp/x")).toBe(false);
    expect(isInsideRepo(nfd(REPO), nfc(`${REPO}/..`))).toBe(false);
    expect(isInsideRepo(nfd(REPO), nfc(`${REPO} 2/x`))).toBe(false);
  });

  // Own seeded generator: fast-check is not wired in.
  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const PARTS = ["Мозговой штурм", "ёлка", "й", "data", "a b", "Новый ёж", "x"];

  it("gives the same answer for every NFC/NFD pairing of project and folder", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed);
      const pick = () => PARTS[Math.floor(rnd() * PARTS.length)]!;
      const base = Array.from({ length: 1 + Math.floor(rnd() * 3) }, pick);
      const repo = "/" + base.join("/");
      const kind = Math.floor(rnd() * 4); // 0 — the project itself, 1 — nested, 2 — sibling, 3 — parent
      const depth = 1 + Math.floor(rnd() * 5);
      const nested = Array.from({ length: depth }, pick);
      const folder =
        kind === 0 ? repo
        : kind === 1 ? `${repo}/${nested.join("/")}`
        : kind === 2 ? `${repo}-${pick()}/${nested.join("/")}`
        : `${repo}/..`;
      const expected = kind <= 1;
      for (const r of [nfc, nfd]) for (const f of [nfc, nfd]) {
        expect(isInsideRepo(r(repo), f(folder)), `seed ${seed}: ${folder}`).toBe(expected);
      }
    }
  });
});
