import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInsideRepo, isInsideRepoBeforeCreate } from "./inside-repo.ts";

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
    expect(isInsideRepo(nfd(REPO), nfc(`${REPO}/../x`))).toBe(false);
  });

  it("treats names that merely start with two dots as inside", () => {
    for (const r of [nfc, nfd]) for (const f of [nfc, nfd]) {
      expect(isInsideRepo(r(REPO), f(`${REPO}/..foo`))).toBe(true);
      expect(isInsideRepo(r(REPO), f(`${REPO}/.council-data/..x`))).toBe(true);
      expect(isInsideRepo(r(REPO), f(`${REPO}/..`))).toBe(false);
      expect(isInsideRepo(r(REPO), f(`${REPO}/../x`))).toBe(false);
    }
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
  const DOTTED = ["...", "..foo", "..x", "..й"]; // never a bare ".."

  it("gives the same answer for every NFC/NFD pairing of project and folder", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed);
      const pick = () => PARTS[Math.floor(rnd() * PARTS.length)]!;
      const base = Array.from({ length: 1 + Math.floor(rnd() * 3) }, pick);
      const repo = "/" + base.join("/");
      const kind = Math.floor(rnd() * 5); // 0 — the project itself, 1 — nested, 2 — sibling, 3 — parent, 4 — parent's child
      const depth = 1 + Math.floor(rnd() * 5);
      const pickN = () => (rnd() < 0.3 ? DOTTED[Math.floor(rnd() * DOTTED.length)]! : pick());
      const nested = Array.from({ length: depth }, pickN);
      const folder =
        kind === 0 ? repo
        : kind === 1 ? `${repo}/${nested.join("/")}`
        : kind === 2 ? `${repo}-${pick()}/${nested.join("/")}`
        : kind === 3 ? `${repo}/..`
        : `${repo}/../other-${pick()}`;
      const expected = kind <= 1;
      for (const r of [nfc, nfd]) for (const f of [nfc, nfd]) {
        expect(isInsideRepo(r(repo), f(folder)), `seed ${seed}: ${folder}`).toBe(expected);
      }
    }
  });
});

describe("isInsideRepoBeforeCreate", () => {
  it("Папка вне проекта не создаётся: decides without creating anything", () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "inside-repo-")));
    try {
      const repo = join(tmp, "repo-й");
      mkdirSync(repo);
      const other = (s: string) => (s === s.normalize("NFC") ? s.normalize("NFD") : s.normalize("NFC"));
      expect(isInsideRepoBeforeCreate(repo, join(tmp, "outside/a/b"))).toBe(false);
      expect(existsSync(join(tmp, "outside"))).toBe(false);
      expect(isInsideRepoBeforeCreate(repo, join(repo, "../x"))).toBe(false);
      expect(isInsideRepoBeforeCreate(repo, join(repo, "new/a/b"))).toBe(true);
      expect(isInsideRepoBeforeCreate(repo, join(repo, "..foo/x"))).toBe(true);
      expect(isInsideRepoBeforeCreate(repo, other(join(repo, "new/x")))).toBe(true);
      expect(isInsideRepoBeforeCreate(other(repo), join(repo, "new/x"))).toBe(true);
      expect(existsSync(join(repo, "new"))).toBe(false);
      mkdirSync(join(tmp, "elsewhere"));
      symlinkSync(join(tmp, "elsewhere"), join(repo, "link"));
      expect(isInsideRepoBeforeCreate(repo, join(repo, "link/new/x"))).toBe(false);
      expect(existsSync(join(tmp, "elsewhere/new"))).toBe(false);
      symlinkSync(join(tmp, "nowhere"), join(repo, "dangling"));
      expect(isInsideRepoBeforeCreate(repo, join(repo, "dangling/new/x"))).toBe(false);
      expect(existsSync(join(tmp, "nowhere"))).toBe(false);
      writeFileSync(join(tmp, "file"), "");
      expect(isInsideRepoBeforeCreate(repo, join(tmp, "file/x"))).toBe(false);
      writeFileSync(join(repo, "file"), "");
      expect(isInsideRepoBeforeCreate(repo, join(repo, "file/x"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
