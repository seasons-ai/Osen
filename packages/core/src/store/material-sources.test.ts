import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createSession } from "../engine.ts";
import { createScriptedDriver, readScenario } from "../participants/scripted.ts";
import { createSessionJournal, eventsPath, sessionDir } from "./journal.ts";
import { MaterialSnapshotError, writeMaterialSnapshots } from "./journal.ts";
import {
  checkSources, decodeSources, encodeSources, formatSource, materialSourcesPath, readMaterialSources, safeSource, safeUrl, writeMaterialSources,
} from "./material-sources.ts";
import type { MaterialSource } from "./material-sources.ts";
import { runStoredSession } from "./run.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), "council-")); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const at = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
const src = (id = "m1", host = "example.com", pathname = "/a"): MaterialSource =>
  ({ id, scheme: "https", host, pathname, fetchedAt: at.toISOString() });

describe("safe source address", () => {
  it("1. query, fragment and credentials do not get into the snapshot", () => {
    const url = new URL("https://user:pw@Example.com:8443/docs/a%20b.html?token=SECRET#frag");
    const s = safeSource(url, "m1", at);
    expect(s).toMatchObject({ scheme: "https", host: "example.com:8443", pathname: "/docs/a%20b.html", fetchedAt: "2026-01-02T03:04:05.000Z" });
    for (const t of [JSON.stringify(s), safeUrl(url), formatSource(s)]) for (const bad of ["SECRET", "user", "pw", "frag"]) expect(t).not.toContain(bad);
    expect(formatSource(s)).toBe("m1 ← https://example.com:8443/docs/a%20b.html · получено 2026-01-02T03:04:05.000Z");
  });

  it("default port is not printed, IPv6 in brackets, root is /", () => {
    expect(safeSource(new URL("https://example.com:443/x"), "m1", at).host).toBe("example.com");
    expect(safeSource(new URL("http://[2606:4700::1]:8080/p"), "m1", at).host).toBe("[2606:4700::1]:8080");
    expect(safeSource(new URL("https://h?x=1"), "m1", at).pathname).toBe("/");
    expect(() => safeSource(new URL("ftp://h/x"), "m1", at)).toThrow();
  });
});

describe("source encoding", () => {
  it("2. encode/decode round trip and refusals", () => {
    const list = [src("m1"), src("m2", "h.org", "/b")];
    expect(decodeSources(encodeSources(list))).toEqual(list);
    expect(encodeSources(list).endsWith("\n")).toBe(true);
    const wrap = (o: object) => JSON.stringify({ version: 1, sources: [{ ...src(), ...o }] });
    const bad = [
      "не json", JSON.stringify({ version: 2, sources: [] }), wrap({ query: "x=1" }), wrap({ id: "x1" }), wrap({ id: "m0" }),
      wrap({ scheme: "ftp" }), wrap({ pathname: "a" }), wrap({ fetchedAt: "вчера" }), JSON.stringify({ version: 1, sources: [], extra: 1 }),
    ];
    for (const t of bad) expect(decodeSources(t)).toBeUndefined();
  });

  it("3. checkSources: foreign and repeated identifier", () => {
    expect(checkSources([src("m3")], ["m1", "m2"])).toMatch(/m3/);
    expect(checkSources([src("m1"), src("m1")], ["m1"])).toMatch(/m1/);
    expect(checkSources([src("m1"), src("m2")], ["m1", "m2"])).toBeUndefined();
  });
});

describe("session source file", () => {
  const start = (id: string) => {
    const dir = tmp();
    createSessionJournal(dir, id);
    writeMaterialSnapshots(dir, id, [{ id: "m1", text: "a" }]);
    return dir;
  };

  it("4. write and read; empty source list does not create a file", () => {
    const dir = start("a");
    expect(readMaterialSources(dir, "a")).toEqual([]);
    writeMaterialSources(dir, "a", []);
    expect(existsSync(materialSourcesPath(dir, "a"))).toBe(false);
    writeMaterialSources(dir, "a", [src()]);
    expect(readMaterialSources(dir, "a")).toEqual([src()]);
  });

  it("repeat write refuses and does not change the file", () => {
    const dir = start("a");
    writeMaterialSources(dir, "a", [src()]);
    const before = readFileSync(materialSourcesPath(dir, "a"), "utf8");
    expect(() => writeMaterialSources(dir, "a", [src("m1", "other.org")])).toThrow(MaterialSnapshotError);
    expect(readFileSync(materialSourcesPath(dir, "a"), "utf8")).toBe(before);
  });

  it("junk or large file — null, no session — []", () => {
    const dir = start("a");
    writeFileSync(materialSourcesPath(dir, "a"), "мусор");
    expect(readMaterialSources(dir, "a")).toBeNull();
    writeFileSync(materialSourcesPath(dir, "a"), " ".repeat(1024 * 1024 + 1));
    expect(readMaterialSources(dir, "a")).toBeNull();
    expect(readMaterialSources(dir, "net")).toEqual([]);
    mkdirSync(join(dir, "sessions", "b"), { recursive: true });
    expect(readMaterialSources(dir, "b")).toEqual([]);
  });
});

describe("runStoredSession with sources", () => {
  const scenarios = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scenarios");
  const mat = (id: string, text: string) => ({ id, name: `${id}.txt`, text, chars: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex") });
  const texts = [mat("m1", "первый"), mat("m2", "второй")];
  const mk = (id: string) => createSession(
    {
      topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 3, turnTimeoutSec: 30, contextChars: 20000, materialsChars: 1000 },
      participants: [1, 2].map((i) => ({ name: `N${i}`, providerId: "scripted", model: "m", role: null })), materials: texts,
    },
    { maxParticipants: 8, id },
  );
  const drivers = async () => ({
    p1: createScriptedDriver(await readScenario(join(scenarios, "consensus", "p1.json")), { COUNCIL_DEV: "1" }),
    p2: createScriptedDriver(await readScenario(join(scenarios, "consensus", "p2.json")), { COUNCIL_DEV: "1" }),
  });

  it("5. source file exists, journal is silent about it", async () => {
    const dir = tmp();
    const sources = [src("m1", "secret-host.example")];
    await runStoredSession({ session: mk("a"), drivers: await drivers(), dataDir: dir, materials: texts, sources });
    expect(readMaterialSources(dir, "a")).toEqual(sources);
    const journal = readFileSync(eventsPath(dir, "a"), "utf8");
    expect(journal).not.toContain("secret-host.example");
    expect(journal).not.toContain("sources");
    const first = JSON.parse(journal.split("\n")[0]!);
    for (const m of first.session.materials) expect(Object.keys(m).sort()).toEqual(["chars", "id", "name", "sha256"]);
  });

  it("source of a foreign material — refusal before writing to disk", async () => {
    const dir = tmp();
    await expect(runStoredSession({ session: mk("b"), drivers: await drivers(), dataDir: dir, materials: texts, sources: [src("m3")] })).rejects.toThrow(/m3/);
    expect(existsSync(sessionDir(dir, "b"))).toBe(false);
  });

  it("without a source file, there is none", async () => {
    const dir = tmp();
    await runStoredSession({ session: mk("c"), drivers: await drivers(), dataDir: dir, materials: texts });
    expect(existsSync(materialSourcesPath(dir, "c"))).toBe(false);
    expect(readdirSync(join(sessionDir(dir, "c"), "materials")).sort()).toEqual(["m1.txt", "m2.txt"]);
  });
});
