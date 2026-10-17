import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTariffs, tariffsPath } from "./tariffs.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-tariffs-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const good = { tariffs: [{ providerId: "a", model: "m", source: "s", asOf: "2026-10-09", currency: "USD", inputPerMillion: 1, outputPerMillion: 2 }] };

describe("readTariffs", () => {
  it("file missing", () => {
    expect(readTariffs(dir)).toEqual({ state: "absent", tariffs: [], warnings: [] });
  });

  it("tariffs.json is a folder", () => {
    mkdirSync(tariffsPath(dir));
    const r = readTariffs(dir);
    expect(r).toEqual({ state: "unreadable", tariffs: [], warnings: ["tariffs.json: не удалось прочитать (EISDIR)"] });
    expect(JSON.stringify(r)).not.toContain(dir);
  });

  it("correct file: read, unchanged, nothing created", () => {
    writeFileSync(tariffsPath(dir), JSON.stringify(good));
    const before = readFileSync(tariffsPath(dir));
    const r = readTariffs(dir);
    expect(r.state).toBe("loaded");
    expect(r.tariffs).toHaveLength(1);
    expect(readFileSync(tariffsPath(dir)).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(["tariffs.json"]);
  });

  it("invalid file not rewritten", () => {
    writeFileSync(tariffsPath(dir), "{ не json");
    const before = readFileSync(tariffsPath(dir));
    expect(readTariffs(dir).state).toBe("unreadable");
    expect(readFileSync(tariffsPath(dir)).equals(before)).toBe(true);
  });
});
