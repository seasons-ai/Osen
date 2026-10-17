import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLineups } from "@model-council/core";
import type { ProviderStatus, Registry } from "@model-council/core";
import { lineupsView, saveLineupInput } from "./lineups.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(realpathSync(tmpdir()), "council-lineups-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const file = () => join(dir, "lineups.json");
const registry = { providers: [{ id: "claude", kind: "cli", label: "Claude Code", models: [] }] } as unknown as Registry;
const statuses = [{ id: "claude", kind: "cli", label: "Claude Code", available: true, models: ["opus"], modelsConfirmed: true }] as unknown as ProviderStatus[];
const pos = (providerId: string, model: string, role: string | null = null) => ({ providerId, model, role });
const two = [pos("claude", "opus", "Скептик"), pos("scripted", "p1")];
const view = (scripted: ((m: string) => string | null) | null = () => null) => lineupsView(dir, registry, statuses, scripted);

describe("lineupsView", () => {
  it("no file", () => expect(view()).toEqual({ lineups: [], error: null }));

  it("corrupted file: error, bytes unchanged", () => {
    writeFileSync(file(), "{not json");
    const v = view();
    expect(v.lineups).toEqual([]);
    expect(v.error).toBeTruthy();
    expect(readFileSync(file(), "utf8")).toBe("{not json");
  });

  it("positions check", async () => {
    await saveLineupInput(dir, { name: "A", participants: [pos("nope", "m"), pos("claude", "opus")] });
    await saveLineupInput(dir, { name: "B", participants: [pos("scripted", "p1"), pos("claude", "opus")] });
    await saveLineupInput(dir, { name: "C", participants: [pos("claude", "sonnet"), pos("claude", "opus")] });
    const a = view().lineups.find((l) => l.name === "A")!;
    expect(a.available).toBe(false);
    expect(a.participants[0]).toMatchObject({ available: false, reason: expect.stringContaining("nope") });
    expect(a.participants[1]!.available).toBe(true);
    const b = view((m) => `нет ${m}`).lineups.find((l) => l.name === "B")!;
    expect(b.available).toBe(false);
    expect(b.participants[0]).toMatchObject({ available: false, reason: "нет p1" });
    expect(view(null).lineups.find((l) => l.name === "B")!.participants[0]!.reason).toContain("COUNCIL_DEV=1");
    const c = view().lineups.find((l) => l.name === "C")!;
    expect(c.available).toBe(true);
    expect(c.participants[0]!.modelNote).toBeTruthy();
  });

  it("DTO: exactly the contract fields", async () => {
    await saveLineupInput(dir, { name: "A", participants: two });
    const l = view().lineups[0]!;
    expect(Object.keys(l).sort()).toEqual(["available", "id", "name", "participants"]);
    expect(Object.keys(l.participants[0]!).sort()).toEqual(["available", "modelNote", "model", "providerId", "reason", "role"].sort());
  });
});

describe("saveLineupInput", () => {
  it("success: order, provider, model, role", async () => {
    const r = await saveLineupInput(dir, { name: "  Мой  ", participants: two });
    expect(r).toEqual({ ok: true, id: expect.any(String), name: "Мой" });
    expect(readLineups(dir)).toEqual([{ id: (r as { id: string }).id, name: "Мой", participants: two }]);
  });

  it.each([["", null], ["   ", null], [" критик ", "критик"]])("роль %j -> %j", async (role, want) => {
    await saveLineupInput(dir, { name: "A", participants: [pos("claude", "opus", role), pos("claude", "opus")] });
    expect(readLineups(dir)[0]!.participants[0]!.role).toBe(want);
  });

  it("extra fields do not get into the file", async () => {
    const r = await saveLineupInput(dir, { name: "A", id: "my-id", apiKey: "sk-secret", topic: "тема", participants: [{ ...two[0], secret: "x" }, { ...two[1], secret: "y" }] });
    const text = readFileSync(file(), "utf8");
    for (const w of ["sk-secret", "topic", "secret", "my-id"]) expect(text).not.toContain(w);
    expect((r as { id: string }).id).not.toBe("my-id");
  });

  it("name already taken: refusal, file unchanged", async () => {
    await saveLineupInput(dir, { name: "A", participants: two });
    const before = readFileSync(file());
    const r = await saveLineupInput(dir, { name: "A", participants: [pos("claude", "x"), pos("claude", "y")] });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("уже занято") });
    expect(readFileSync(file()).equals(before)).toBe(true);
    expect(readLineups(dir)).toHaveLength(1);
    expect(readLineups(dir)[0]!.participants).toEqual(two);
  });

  it.each([
    ["не объект", null],
    ["name не строка", { name: 1, participants: two }],
    ["participants не массив", { name: "A", participants: "x" }],
    ["без providerId", { name: "A", participants: [{ model: "m", role: null }, two[1]] }],
    ["role число", { name: "A", participants: [{ ...two[0], role: 1 }, two[1]] }],
  ])("неверная форма: %s", async (_n, input) => {
    const r = await saveLineupInput(dir, input);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Некорректный запрос сохранения состава") });
    expect(existsSync(file())).toBe(false);
  });

  it("corrupted file: refusal, bytes unchanged", async () => {
    writeFileSync(file(), "{not json");
    const r = await saveLineupInput(dir, { name: "A", participants: two });
    expect(r.ok).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe("{not json");
  });

  it("one participant", async () => {
    expect(await saveLineupInput(dir, { name: "A", participants: [two[0]] })).toMatchObject({ ok: false, error: expect.stringContaining("двух участников") });
  });
});

describe("lineups: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const cyr = /[А-Яа-яЁё]/;
  const cases: [unknown, string, string][] = [
    ["x", "the request must be an object", "запрос — объект"],
    [{ name: 1, participants: [] }, "the name must be a string", "название — строка"],
    [{ name: "A" }, "participants must be an array", "участники — массив"],
    [{ name: "A", participants: [pos("claude", "opus"), 5] }, "participant 2 must be an object", "участник 2 — объект"],
    [{ name: "A", participants: [{ providerId: "", model: "m", role: null }] }, "participant 1 has no provider", "у участника 1 нет провайдера"],
    [{ name: "A", participants: [{ providerId: "p", model: "", role: null }] }, "participant 1 has no model", "у участника 1 нет модели"],
    [{ name: "A", participants: [{ providerId: "p", model: "m", role: 3 }] }, "the role of participant 1 must be a string or null", "роль участника 1 — строка или null"],
  ];

  it("every request refusal: en with the same numbers, then ru with the previous wording, lineups.json not created", async () => {
    for (const [raw, en, ru] of cases) {
      setProcessLanguage("en");
      const e = await saveLineupInput(dir, raw);
      expect(e).toEqual({ ok: false, error: `Invalid lineup save request: ${en}.` });
      expect(JSON.stringify(e)).not.toMatch(cyr);
      setProcessLanguage("ru");
      expect(await saveLineupInput(dir, raw)).toEqual({ ok: false, error: `Некорректный запрос сохранения состава: ${ru}.` });
    }
    expect(existsSync(file())).toBe(false);
  });

  it("a language change does not touch the written file", async () => {
    await saveLineupInput(dir, { name: "A", participants: two });
    const before = readFileSync(file());
    setProcessLanguage("en");
    await saveLineupInput(dir, { name: 1 });
    setProcessLanguage("ru");
    await saveLineupInput(dir, { name: 1 });
    expect(readFileSync(file())).toEqual(before);
  });
});
