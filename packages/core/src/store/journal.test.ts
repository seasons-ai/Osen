import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MaterialSnapshotError, SessionExistsError, appendEvent, createSessionJournal, eventsPath, isValidSessionId, readEvents, sessionDir, materialPath, materialsDir, writeMaterialSnapshots,
} from "./journal.ts";
import type { SessionEvent } from "../protocol/schema.ts";

const TS = "2026-01-01T00:00:00Z";
const session = {
  id: "s1", createdAt: TS, origin: "cli" as const, topic: "Тема обсуждения: кириллица", templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
};
const ev = (seq: number): SessionEvent =>
  seq === 1
    ? { seq, ts: TS, type: "session_created", session, pid: 42 }
    : { seq, ts: TS, type: "turn_started", turn: seq - 1, round: 1, participantId: "p1" };

let dir: string;
const id = "s1";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "council-"));
  createSessionJournal(dir, id);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => eventsPath(dir, id);
const three = () => [1, 2, 3].forEach((n) => appendEvent(dir, id, ev(n)));

describe("journal", () => {
  it("isValidSessionId", () => {
    expect(isValidSessionId("3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e")).toBe(true);
    expect(isValidSessionId("abc_1-2")).toBe(true);
    for (const bad of ["", "..", "../x", "a/b", "a b", "a".repeat(129)]) expect(isValidSessionId(bad)).toBe(false);
  });

  it("createSessionJournal does not touch an existing session", () => {
    writeFileSync(join(sessionDir(dir, id), "keep.txt"), "x");
    expect(() => createSessionJournal(dir, id)).toThrow(SessionExistsError);
    expect(readdirSync(sessionDir(dir, id))).toEqual(["keep.txt"]);
    expect(readFileSync(join(sessionDir(dir, id), "keep.txt"), "utf8")).toBe("x");
  });

  it("appendEvent writes one line at a time straight to disk", () => {
    for (const n of [1, 2, 3]) {
      appendEvent(dir, id, ev(n));
      expect(readFileSync(file(), "utf8").split("\n")).toHaveLength(n + 1);
    }
    const text = readFileSync(file(), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(JSON.parse(l)).toMatchObject({ seq: expect.any(Number), ts: expect.any(String), type: expect.any(String) });
  });

  it("only appends", () => {
    appendEvent(dir, id, ev(1));
    appendEvent(dir, id, ev(2));
    const before = readFileSync(file());
    appendEvent(dir, id, ev(3));
    expect(readFileSync(file()).subarray(0, before.length).equals(before)).toBe(true);
  });

  it("readEvents: events and byte offset", () => {
    three();
    const r = readEvents(dir, id)!;
    expect(r.events).toEqual([ev(1), ev(2), ev(3)]);
    expect(r.offset).toBe(statSync(file()).size);
    expect(r.offset).toBeGreaterThan(readFileSync(file(), "utf8").length);
  });

  it("readEvents: size — bytes of the read snapshot; offset < size only with an incomplete tail", () => {
    three();
    const whole = readEvents(dir, id)!;
    expect(whole.size).toBe(statSync(file()).size);
    expect(whole.offset).toBe(whole.size);
    appendFileSync(file(), '{"seq":4');
    const torn = readEvents(dir, id)!;
    expect(torn.size).toBe(statSync(file()).size);
    expect(torn.offset).toBeLessThan(torn.size);
  });

  it("truncated last line is ignored", () => {
    three();
    const size = statSync(file()).size;
    appendFileSync(file(), '{"seq":4,"ts":"2026');
    expect(readEvents(dir, id)).toEqual({ events: [ev(1), ev(2), ev(3)], offset: size, size: statSync(file()).size, stopped: "corrupted" });
  });

  it("valid JSON without \\n is not counted", () => {
    three();
    const size = statSync(file()).size;
    appendFileSync(file(), JSON.stringify(ev(4)));
    expect(readEvents(dir, id)).toEqual({ events: [ev(1), ev(2), ev(3)], offset: size, size: statSync(file()).size, stopped: "corrupted" });
  });

  // Partial-read flag of the journal: reason for stopping
  const future = (seq: number, extra: object = {}) => JSON.stringify({ seq, ts: TS, type: "future_event", ...extra }) + "\n";
  const sha = () => createHash("sha256").update(readFileSync(file())).digest("hex");

  it("readEvents: unknown type — reason newer_version", () => {
    three();
    const at = statSync(file()).size;
    appendFileSync(file(), future(4));
    appendEvent(dir, id, ev(5));
    appendEvent(dir, id, ev(6));
    const r = readEvents(dir, id)!;
    expect(r.events).toEqual([ev(1), ev(2), ev(3)]);
    expect(r.stopped).toBe("newer_version");
    expect(r.offset).toBe(at);
  });

  it("known type with a new value — newer_version", () => {
    three();
    appendFileSync(file(), JSON.stringify({ ...ev(4), type: "turn_started", round: "новое значение" }) + "\n");
    appendEvent(dir, id, ev(5));
    const r = readEvents(dir, id)!;
    expect(r.events).toHaveLength(3);
    expect(r.stopped).toBe("newer_version");
    appendFileSync(file(), "");
    writeFileSync(file(), JSON.stringify({ seq: 1, ts: TS, type: "session_finished", status: "из будущего", version: 1, agreed: [], objectors: [] }) + "\n");
    expect(readEvents(dir, id)!.stopped).toBe("newer_version");
  });

  it("broken JSON and tail without newline — corrupted", () => {
    const bad = ["не json\n", "[1,2]\n", '{"ts":"t","type":"turn_started"}\n', '{"seq":"4","ts":"t","type":"turn_started"}\n', '{"seq":4,"type":"x"}\n', "null\n", "42\n", "\n"];
    for (const line of bad) {
      writeFileSync(file(), "");
      three();
      appendFileSync(file(), line);
      appendEvent(dir, id, ev(5));
      const r = readEvents(dir, id)!;
      expect([line, r.events.length, r.stopped]).toEqual([line, 3, "corrupted"]);
    }
    writeFileSync(file(), "");
    three();
    appendFileSync(file(), '{"seq":4,"ts":"2026');
    expect(readEvents(dir, id)!.stopped).toBe("corrupted");
    appendFileSync(file(), '","type":"future_event"}');
    expect(readEvents(dir, id)!.stopped).toBe("corrupted");
  });

  it("whole journal — no reason", () => {
    three();
    expect(readEvents(dir, id)!.stopped).toBeNull();
    writeFileSync(file(), "");
    expect(readEvents(dir, id)!.stopped).toBeNull();
    three();
    const { offset } = readEvents(dir, id)!;
    expect(readEvents(dir, id, offset)!.stopped).toBeNull();
  });

  it("readEvents with fromOffset: reason says why reading did not reach the end", () => {
    three();
    const { offset } = readEvents(dir, id)!;
    appendEvent(dir, id, ev(4));
    appendFileSync(file(), future(5));
    appendEvent(dir, id, ev(6));
    const r = readEvents(dir, id, offset)!;
    expect(r.events).toEqual([ev(4)]);
    expect(r.stopped).toBe("newer_version");
  });

  it("reading does not change journal bytes", () => {
    three();
    appendFileSync(file(), future(4));
    appendFileSync(file(), '{"seq":5');
    const before = sha();
    readEvents(dir, id);
    readEvents(dir, id, 10);
    expect(sha()).toBe(before);
  });

  it("incremental reading", () => {
    three();
    const { offset } = readEvents(dir, id)!;
    expect(readEvents(dir, id, offset)).toEqual({ events: [], offset, size: offset, stopped: null });
    appendEvent(dir, id, ev(4));
    const r = readEvents(dir, id, offset)!;
    expect(r.events).toEqual([ev(4)]);
    expect(r.offset).toBe(statSync(file()).size);
  });

  it("invalid line stops reading", () => {
    appendEvent(dir, id, ev(1));
    const at = statSync(file()).size;
    appendFileSync(file(), "не json\n");
    appendEvent(dir, id, ev(2));
    expect(readEvents(dir, id)).toEqual({ events: [ev(1)], offset: at, size: statSync(file()).size, stopped: "corrupted" });
  });

  it("empty line and line not matching the schema are invalid", () => {
    appendEvent(dir, id, ev(1));
    const at = statSync(file()).size;
    appendFileSync(file(), "\n");
    expect(readEvents(dir, id)!.offset).toBe(at);
    writeFileSync(file(), '{"seq":1}\n');
    expect(readEvents(dir, id)).toEqual({ events: [], offset: 0, size: statSync(file()).size, stopped: "corrupted" });
  });

  it("empty file gives offset 0", () => {
    writeFileSync(file(), "");
    expect(readEvents(dir, id)).toEqual({ events: [], offset: 0, size: statSync(file()).size, stopped: null });
  });

  it("no session or invalid id", () => {
    expect(readEvents(dir, "nope")).toBeNull();
    expect(readEvents(dir, id)).toBeNull();
    expect(readEvents(dir, "../x")).toBeNull();
    expect(() => appendEvent(dir, "../x", ev(1))).toThrow("Недопустимый идентификатор сессии: ../x");
    expect(() => eventsPath(dir, "../x")).toThrow();
  });

  it("materialPath: material identifier check", () => {
    expect(materialPath(dir, id, "m1")).toBe(join(sessionDir(dir, id), "materials", "m1.txt"));
    expect(materialPath(dir, id, "m12")).toMatch(/m12\.txt$/);
    for (const bad of ["m0", "M1", "../x", "m1/../../x", "m1.txt", ""]) expect(() => materialPath(dir, id, bad)).toThrow();
  });

  it("writeMaterialSnapshots writes files and does not overwrite", () => {
    writeMaterialSnapshots(dir, id, [{ id: "m1", text: "один" }, { id: "m2", text: "два" }]);
    expect(readFileSync(materialPath(dir, id, "m1"), "utf8")).toBe("один");
    expect(() => writeMaterialSnapshots(dir, id, [{ id: "m1", text: "ДРУГОЙ" }])).toThrow(MaterialSnapshotError);
    expect(readFileSync(materialPath(dir, id, "m1"), "utf8")).toBe("один");
    expect(readFileSync(materialPath(dir, id, "m2"), "utf8")).toBe("два");
  });

  it("writeMaterialSnapshots: empty list does not create a folder", () => {
    writeMaterialSnapshots(dir, id, []);
    expect(readdirSync(sessionDir(dir, id))).not.toContain("materials");
    expect(() => statSync(materialsDir(dir, id))).toThrow();
  });
});
