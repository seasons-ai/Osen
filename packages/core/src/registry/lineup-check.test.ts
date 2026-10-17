import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL } from "../cli-agents/types.ts";
import type { Registry } from "./config.ts";
import { checkLineup } from "./lineup-check.ts";
import type { LineupCheckContext } from "./lineup-check.ts";
import type { Lineup } from "./lineups.ts";
import type { ProviderStatus } from "./providers.ts";

const registry = {
  providers: [
    { id: "claude", kind: "cli", label: "Claude Code", agent: "claude", models: [] },
    { id: "codex", kind: "cli", label: "Codex", agent: "codex", models: [] },
    { id: "gpt", kind: "openai-http", label: "GPT", baseUrl: "http://x", models: [] },
  ],
  defaults: {},
} as unknown as Registry;
const st = (id: string, o: Partial<ProviderStatus> = {}): ProviderStatus =>
  ({ id, kind: "cli", label: id, available: true, models: ["m1"], modelsConfirmed: true, ...o }) as ProviderStatus;
const mk = (statuses: ProviderStatus[] = [st("claude"), st("codex"), st("gpt", { kind: "openai-http" })], scripted: LineupCheckContext["scripted"] = null): LineupCheckContext =>
  ({ registry, statuses, scripted });
const lineup = (...ps: [string, string, string | null][]): Lineup =>
  ({ id: "l1", name: "Состав", participants: ps.map(([providerId, model, role]) => ({ providerId, model, role })) });

describe("checkLineup", () => {
  it("everything available, no marks", () => {
    const r = checkLineup(lineup(["claude", DEFAULT_MODEL, null], ["codex", "m1", "критик"]), mk());
    expect(r.available).toBe(true);
    expect(r.id).toBe("l1");
    expect(r.name).toBe("Состав");
    expect(r.participants.every((p) => p.available && p.reason === null && p.modelNote === null)).toBe(true);
  });
  it("provider removed from registry", () => {
    const l = lineup(["claude", "m1", null], ["gone", "m1", "x"]);
    const r = checkLineup(l, mk());
    expect(r.available).toBe(false);
    expect(r.participants[1]!).toMatchObject({ providerId: "gone", available: false, modelNote: null });
    expect(r.participants[1]!.reason).toContain("не найден в реестре");
    expect(r.participants[0]!).toEqual({ ...l.participants[0], available: true, reason: null, modelNote: null });
  });
  it("provider unavailable: with and without reason", () => {
    const r = checkLineup(lineup(["claude", "m1", null], ["codex", "m1", null]), mk([st("claude", { available: false, reason: "нет команды" }), st("codex", { available: false })]));
    expect(r.participants[0]!.reason).toBe("нет команды");
    expect(r.participants[1]!.reason).toBe("Провайдер недоступен");
    expect(r.available).toBe(false);
  });
  it("no status", () => {
    const r = checkLineup(lineup(["claude", "m1", null]), mk([]));
    expect(r.participants[0]!).toMatchObject({ available: false, reason: "Провайдер не осмотрен" });
  });
  it("openai-http with default model", () => {
    const r = checkLineup(lineup(["gpt", DEFAULT_MODEL, null]), mk());
    expect(r.participants[0]!).toMatchObject({ available: false, reason: "Для провайдера «gpt» нужна модель." });
  });
  it("model not in confirmed list", () => {
    const r = checkLineup(lineup(["claude", "zzz", null]), mk());
    expect(r.participants[0]!).toMatchObject({ available: true, reason: null, modelNote: "Модели «zzz» нет в перечне провайдера «claude»." });
    expect(r.available).toBe(true);
  });
  it("list not received", () => {
    const r = checkLineup(lineup(["claude", "zzz", null]), mk([st("claude", { models: [], modelsConfirmed: false, modelsReason: "сеть недоступна" })]));
    expect(r.participants[0]!.available).toBe(true);
    expect(r.participants[0]!.modelNote).toBe("Модели «zzz» нет в перечне провайдера «claude» (перечень не подтверждён: сеть недоступна).");
  });
  it("model is in the owner's unconfirmed list", () => {
    const r = checkLineup(lineup(["claude", "m1", null]), mk([st("claude", { modelsConfirmed: false, modelsReason: "r" })]));
    expect(r.participants[0]!).toMatchObject({ available: true, modelNote: null });
  });
  it("scripted: disabled, with reason, available", () => {
    const l = lineup(["scripted", "a.json", null]);
    const off = checkLineup(l, mk());
    expect(off.participants[0]!).toMatchObject({ available: false, reason: "Сценарные участники доступны только при COUNCIL_DEV=1.", modelNote: null });
    const bad = checkLineup(l, mk(undefined, (m) => `нет сценария ${m}`));
    expect(bad.participants[0]!).toMatchObject({ available: false, reason: "нет сценария a.json" });
    const ok = checkLineup(l, mk(undefined, () => null));
    expect(ok.participants[0]!).toMatchObject({ available: true, reason: null, modelNote: null });
  });
  it("two participants of one provider: order and roles", () => {
    const r = checkLineup(lineup(["claude", "m1", null], ["claude", DEFAULT_MODEL, "критик"]), mk());
    expect(r.participants.map((p) => [p.model, p.role])).toEqual([["m1", null], [DEFAULT_MODEL, "критик"]]);
  });
  it("no substitution on a mixed lineup", () => {
    const l = lineup(["claude", "m1", "a"], ["gone", "q", null], ["gpt", DEFAULT_MODEL, "b"], ["codex", "zzz", null], ["scripted", "s", "c"]);
    const r = checkLineup(l, mk([st("claude"), st("codex")]));
    expect(r.participants).toHaveLength(l.participants.length);
    r.participants.forEach((p, i) => {
      expect([p.providerId, p.model, p.role]).toEqual([l.participants[i]!.providerId, l.participants[i]!.model, l.participants[i]!.role]);
    });
    expect(r.participants.map((p) => p.available)).toEqual([true, false, false, true, false]);
  });
  it("input is not mutated", () => {
    const l = lineup(["claude", "zzz", null], ["gone", "q", "r"]);
    const ctx = mk([st("claude", { modelsConfirmed: false, modelsReason: "r" })], () => null);
    const copy = structuredClone({ l, registry: ctx.registry, statuses: ctx.statuses });
    checkLineup(l, ctx);
    expect({ l, registry: ctx.registry, statuses: ctx.statuses }).toEqual(copy);
  });
});
