import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DraftSnapshotError, draftPath, readAcceptedDrafts, readDraftSnapshot, storedDraftStore, writeDraftSnapshot } from "./draft-snapshots.ts";
import type { SessionState } from "../protocol/state.ts";
import { sha256Of } from "../materials.ts";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "council-ds-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const meta = (draftId: string, r: { chars: number; sha256: string }) => ({ draftId, ...r });

describe("draft-snapshots", () => {
  it("write and read: metadata correct, text the same", () => {
    for (const t of ["Привет, мир 😀", "a\n\nb\n", "строка\r\nещё", "с переводом в конце\n"]) {
      const r = writeDraftSnapshot(dir, "s1", "d1", t);
      expect(r).toEqual({ chars: t.length, sha256: sha256Of(t) });
      expect(readDraftSnapshot(dir, "s1", meta("d1", r))).toBe(t);
    }
  });

  it("path and absence of temporary files", () => {
    writeDraftSnapshot(dir, "s1", "d1", "текст");
    expect(draftPath(dir, "s1", "d1")).toBe(join(dir, "sessions", "s1", "drafts", "d1.txt"));
    expect(readdirSync(join(dir, "sessions", "s1", "drafts"))).toEqual(["d1.txt"]);
  });

  it("repeat write replaces the file; old metadata does not pass", () => {
    const old = writeDraftSnapshot(dir, "s1", "d1", "старый");
    const fresh = writeDraftSnapshot(dir, "s1", "d1", "новый длиннее");
    expect(readDraftSnapshot(dir, "s1", meta("d1", fresh))).toBe("новый длиннее");
    expect(() => readDraftSnapshot(dir, "s1", meta("d1", old))).toThrow(DraftSnapshotError);
  });

  it("changed and deleted file, symbolic link", () => {
    const r = writeDraftSnapshot(dir, "s1", "d2", "текст");
    const p = draftPath(dir, "s1", "d2");
    writeFileSync(p, "текст!");
    let err: unknown;
    try { readDraftSnapshot(dir, "s1", meta("d2", r)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DraftSnapshotError);
    expect((err as DraftSnapshotError).draftId).toBe("d2");
    expect((err as Error).message).toBe("снимок черновика d2 изменён");
    unlinkSync(p);
    expect(() => readDraftSnapshot(dir, "s1", meta("d2", r))).toThrow("снимок черновика d2 отсутствует");
    writeFileSync(join(dir, "real.txt"), "текст");
    symlinkSync(join(dir, "real.txt"), p);
    expect(() => readDraftSnapshot(dir, "s1", meta("d2", r))).toThrow(DraftSnapshotError);
  });

  it("bad draftId: refused and nothing created", () => {
    for (const bad of ["../x", "d0", "p1", ""]) {
      expect(() => writeDraftSnapshot(dir, "s1", bad, "т")).toThrow(DraftSnapshotError);
      expect(() => readDraftSnapshot(dir, "s1", { draftId: bad, chars: 1, sha256: sha256Of("т") })).toThrow(DraftSnapshotError);
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  // Requirement: Saving and restoring drafts
  it("property: 200 random texts are restored; any byte change is caught", () => {
    let seed = 20260101;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
    const parts = ["a", "Я", " ", "\n", "\r\n", "😀", "𝒳", "ё", "\t", "слово ", "x".repeat(300), " "];
    for (let i = 0; i < 200; i++) {
      let t = "";
      const n = 1 + Math.floor(rnd() * (i % 10 === 0 ? 400 : 15));
      for (let k = 0; k < n; k++) t += pick(parts);
      if (t.trim() === "") t += "б";
      const id = `s${i}`;
      const r = writeDraftSnapshot(dir, id, "d1", t);
      expect(readDraftSnapshot(dir, id, meta("d1", r))).toBe(t);
      const p = draftPath(dir, id, "d1");
      const bytes = readFileSync(p);
      bytes[Math.floor(rnd() * bytes.length)]! ^= 1 << Math.floor(rnd() * 8);
      writeFileSync(p, bytes);
      expect(() => readDraftSnapshot(dir, id, meta("d1", r))).toThrow(DraftSnapshotError);
      expect(existsSync(p)).toBe(true);
    }
  });
});

describe("storedDraftStore and readAcceptedDrafts", () => {
  it("save then load by metadata; changed file — DraftSnapshotError", () => {
    const st = storedDraftStore(dir, "s1");
    const r = st.save("d1", "текст черновика");
    expect(r).toEqual({ chars: 15, sha256: sha256Of("текст черновика") });
    expect(st.load({ draftId: "d1", ...r })).toBe("текст черновика");
    writeFileSync(draftPath(dir, "s1", "d1"), "другой текст!!!");
    expect(() => st.load({ draftId: "d1", ...r })).toThrow(DraftSnapshotError);
  });

  const slot = (draftId: string, participantId: string, text: string | null, saved = true) => {
    const r = text === null ? { chars: 0, sha256: "0".repeat(64) } : saved ? writeDraftSnapshot(dir, "s1", draftId, text) : { chars: text.length, sha256: sha256Of(text) };
    return { draftId, participantId, started: 1, failures: [], done: text === null ? null : { participantId, attempts: 1, durationMs: 1, usage: {}, reasoning: `о-${draftId}`, ...r } };
  };
  const state = (drafts: unknown[]) => ({
    session: { participants: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] }, drafts,
  }) as unknown as SessionState;

  it("order of session.participants; broken and deleted — text: null and error", () => {
    const d3 = slot("d3", "p3", "третий");
    const d1 = slot("d1", "p1", "первый");
    const d2 = slot("d2", "p2", "второй");
    expect(readAcceptedDrafts(dir, "s1", state([d3, d1, d2])).map((d) => [d.draftId, d.text])).toEqual([["d1", "первый"], ["d2", "второй"], ["d3", "третий"]]);
    writeFileSync(draftPath(dir, "s1", "d1"), "испорчен");
    unlinkSync(draftPath(dir, "s1", "d3"));
    const got = readAcceptedDrafts(dir, "s1", state([d3, d1, d2]));
    expect(got.map((d) => d.text)).toEqual([null, "второй", null]);
    expect(got[0]!.error).toBeTruthy();
    expect(got[2]!.error).toBeTruthy();
    expect(got[1]).toMatchObject({ participantId: "p2", attempts: 1, reasoning: "о-d2" });
    expect(got[1]!.error).toBeUndefined();
  });

  it("no accepted drafts — []", () => {
    expect(readAcceptedDrafts(dir, "s1", state([]))).toEqual([]);
    expect(readAcceptedDrafts(dir, "s1", state([slot("d1", "p1", null)]))).toEqual([]);
  });
});
