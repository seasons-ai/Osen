import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createSessionJournal, eventsPath, materialPath, sessionDir, writeMaterialSnapshots } from "./journal.ts";
import { materialFromText, readMaterialSnapshots } from "./material-snapshots.ts";
import * as core from "../index.ts";
import { collectMaterials, verifyMaterials } from "../materials.ts";
import type { Session } from "../protocol/schema.ts";

const ts = new Date(Date.UTC(2026, 0, 1)).toISOString();
const TEXTS = ["Привет, мир 😀 конец", "без перевода строки в конце", "третий\nс переводом\n"];
const LIMIT = 10_000;

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "council-ms-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function start(id: string, texts: string[] | null) {
  const mats = texts?.map((t, i) => materialFromText(`m${i + 1}`, `f${i + 1}.txt`, t));
  const session: Session = {
    id, createdAt: ts, origin: "cli", topic: "Тема", templateId: null, framing: "",
    participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    ...(mats ? { materials: mats.map(({ id, name, chars, sha256 }) => ({ id, name, chars, sha256 })) } : {}),
  };
  createSessionJournal(dir, id);
  appendEvent(dir, id, { seq: 1, ts, type: "session_created", session, pid: 1 });
  if (mats) writeMaterialSnapshots(dir, id, mats);
  return mats;
}

function fingerprint(id: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) { files.push(`${p}/ ${st.mtimeMs}`); walk(p); } else files.push(`${p} ${st.mtimeMs} ${readFileSync(p).toString("base64")}`);
    }
  };
  walk(sessionDir(dir, id));
  return files.join("\n");
}

describe("readMaterialSnapshots", () => {
  it("whole snapshots: texts byte-equal, set passes verifyMaterials", () => {
    const mats = start("a", TEXTS)!;
    const r = readMaterialSnapshots(dir, "a")!;
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.ok)).toBe(true);
    const got = r.map((x) => (x as { ok: true; material: typeof mats[0] }).material);
    expect(got).toEqual(mats);
    expect(verifyMaterials(got, LIMIT)).toEqual([]);
  });

  it("second snapshot file missing: others are read", () => {
    start("a", TEXTS);
    rmSync(materialPath(dir, "a", "m2"));
    const r = readMaterialSnapshots(dir, "a")!;
    expect(r.map((x) => x.ok)).toEqual([true, false, true]);
    expect(r[1]!).toEqual({ ok: false, id: "m2", name: "f2.txt", problem: "missing", reason: "нет снимка" });
  });

  it("changed text: mismatch, including with the same length", () => {
    start("a", TEXTS);
    writeFileSync(materialPath(dir, "a", "m1"), TEXTS[0]! + "!", "utf8");
    writeFileSync(materialPath(dir, "a", "m3"), TEXTS[2]!.replace("третий", "Третий"), "utf8");
    const r = readMaterialSnapshots(dir, "a")!;
    expect(TEXTS[2]!.replace("третий", "Третий")).toHaveLength(TEXTS[2]!.length);
    expect(r[0]!).toMatchObject({ ok: false, problem: "mismatch", reason: "хеш не совпал" });
    expect(r[1]!.ok).toBe(true);
    expect(r[2]!).toMatchObject({ ok: false, problem: "mismatch", reason: "хеш не совпал" });
  });

  it("other read error: missing without absolute path", () => {
    start("a", TEXTS);
    const p = materialPath(dir, "a", "m1");
    rmSync(p);
    mkdirSync(p);
    const r = readMaterialSnapshots(dir, "a")!;
    expect(r[0]!).toMatchObject({ ok: false, problem: "missing", reason: "не удалось прочитать снимок: EISDIR" });
  });

  it("old session without materials: []; no session and invalid id: null", () => {
    start("old", null);
    expect(readMaterialSnapshots(dir, "old")).toEqual([]);
    expect(readMaterialSnapshots(dir, "nope")).toBeNull();
    expect(readMaterialSnapshots(dir, "../x")).toBeNull();
    expect(readMaterialSnapshots(dir, "")).toBeNull();
  });

  it("changes nothing: neither with whole nor with damaged snapshots", () => {
    start("a", TEXTS);
    const before = fingerprint("a");
    readMaterialSnapshots(dir, "a");
    expect(fingerprint("a")).toBe(before);
    rmSync(materialPath(dir, "a", "m2"));
    writeFileSync(materialPath(dir, "a", "m1"), "испорчен", "utf8");
    const broken = fingerprint("a");
    readMaterialSnapshots(dir, "a");
    expect(fingerprint("a")).toBe(broken);
    expect(readFileSync(eventsPath(dir, "a")).length).toBeGreaterThan(0);
  });

  it("refusals contain no absolute path and no material text", () => {
    start("a", TEXTS);
    rmSync(materialPath(dir, "a", "m2"));
    writeFileSync(materialPath(dir, "a", "m1"), TEXTS[0]! + "!", "utf8");
    const bad = readMaterialSnapshots(dir, "a")!.filter((x) => !x.ok);
    expect(bad).toHaveLength(2);
    const s = JSON.stringify(bad);
    expect(s).not.toContain(dir);
    for (const t of TEXTS) expect(s).not.toContain(t.slice(0, 8));
  });
});

describe("materialFromText", () => {
  it("chars in UTF-16 units, sha256 as in the collector, set passes verifyMaterials", () => {
    const text = "а😀б";
    const f = join(dir, "a.txt");
    writeFileSync(f, text, "utf8");
    const set = collectMaterials([f], { materialsChars: LIMIT, materialsIgnore: [] });
    const m = materialFromText("m1", "a.txt", text);
    expect(m.chars).toBe(4);
    expect(m.chars).toBeGreaterThan([...text].length);
    expect(m.sha256).toBe(set.materials[0]!.sha256);
    expect(verifyMaterials([m, materialFromText("m2", "b.txt", "второй")], LIMIT)).toEqual([]);
  });

  it("empty name and empty text are not forbidden: verifyMaterials catches it", () => {
    const m = materialFromText("m1", "", "");
    expect(m).toMatchObject({ name: "", text: "", chars: 0 });
    expect(verifyMaterials([m], LIMIT)).not.toEqual([]);
  });
});

it("both functions are exported from index.ts", () => {
  expect(core.readMaterialSnapshots).toBe(readMaterialSnapshots);
  expect(core.materialFromText).toBe(materialFromText);
});
