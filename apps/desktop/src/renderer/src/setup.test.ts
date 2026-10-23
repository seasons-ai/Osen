import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materialsMessages } from "@model-council/core";
import { sessionSetup } from "../../shared/messages/session-setup.ts";
import { afterEach } from "vitest";
import { previewTime } from "./setup.ts";
import { formatDate, setProcessLanguage } from "@model-council/core/i18n";
import type { LineupPositionView, MaterialsView, ProviderOption, RerunView, RegistryView, TemplateCard, TemplateEditorData } from "../../shared/setup.ts";
import { maxCallsBound } from "@model-council/core/protocol";
import { billingNote, billingOf, callsBound, checkSetup, estimate, formFromRerun, initialForm, lineupLabel, lineupSaveInput, materialsFolderLine, materialsLeftHint, materialsOverText, materialsTotal, parseTokenCap, parseWaitSec, previewIsCurrent, previewStatus, reduceSetup, setupTemplateData, synthesizerOf, toStartInput } from "./setup.ts";
import { checkEditor, initialEditor } from "./template-editor.ts";
import { setup as setupMessages } from "../../shared/messages/setup.ts";
import type { SetupAction, SetupContext, SetupForm } from "./setup.ts";

const prov = (id: string, label: string, billing: ProviderOption["billing"], models: string[], available = true, reason: string | null = null): ProviderOption =>
  ({ id, kind: "cli", label, available, reason, models, defaultModel: models[0] ?? null, billing });
const claude = prov("claude", "Claude Code", "subscription", ["default", "opus"]);
const codex = prov("codex", "Codex", "subscription", ["default"]);
const router = prov("openrouter", "OpenRouter", "paid", ["a/b:free", "a/c"]);
const scripted = prov("scripted", "Сценарный", "free", ["s"]);
const broken = prov("broken", "Сломан", "paid", ["m"], false, "нет ключа");
const registry: RegistryView = {
  providers: [claude, codex, router, scripted, broken],
  ownerWait: { minSec: 1, maxSec: 86400, defaultSec: 300 },
  defaults: { maxRounds: 6, maxParticipants: 4, materialsChars: 60000, maxTotalTokens: null, participants: [{ providerId: "claude", model: "default" }, { providerId: "codex", model: "default" }] },
};
const tpl: TemplateCard = { id: "t", title: "T", category: "c", description: "d", exampleTopic: "Пример темы", roles: ["Критик", "Автор", "Лишняя"], maxRounds: 4, source: "builtin", modified: false };
const own: SetupContext = { registry, template: null };
const withTpl: SetupContext = { registry, template: tpl };
const run = (f: SetupForm, ctx: SetupContext, ...a: SetupAction[]) => a.reduce((s, x) => reduceSetup(s, x, ctx), f);
const ready = (ctx = own) => run(initialForm(ctx, null), ctx, { type: "topic", value: "Тема" });

describe("initialForm", () => {
  it("template: roles by positions, topic and the template limit", () => {
    const f = initialForm(withTpl, null);
    expect(f.participants.map((p) => p.role)).toEqual(["Критик", "Автор"]);
    expect(f).toMatchObject({ templateId: "t", topic: "Пример темы", maxRounds: 4 });
  });
  it("custom topic: empty topic and roles, registry limit", () => {
    const f = initialForm(own, null);
    expect(f).toMatchObject({ templateId: null, topic: "", maxRounds: 6 });
    expect(f.participants.map((p) => p.role)).toEqual(["", ""]);
  });
  it("last of three is offered instead of the defaults", () => {
    const last = [{ providerId: "claude", model: "opus" }, { providerId: "codex", model: "default" }, { providerId: "scripted", model: "s" }];
    expect(initialForm(own, last).participants.map((p) => p.providerId)).toEqual(["claude", "codex", "scripted"]);
  });
  it("a vanished provider is dropped, all vanished — defaults", () => {
    const f = initialForm(own, [{ providerId: "gone", model: "x" }, { providerId: "claude", model: "opus" }]);
    expect(f.participants.map((p) => p.providerId)).toEqual(["claude"]);
    const g = initialForm(own, [{ providerId: "gone", model: "x" }]);
    expect(g.participants.map((p) => p.providerId)).toEqual(["claude", "codex"]);
  });
  it("the template limit is clamped to the bounds", () => {
    expect(initialForm({ registry, template: { ...tpl, maxRounds: 99 } }, null).maxRounds).toBe(20);
  });
});

describe("reduceSetup", () => {
  it("adding a third participant with the template role; unavailable at the maximum", () => {
    const f = run(initialForm(withTpl, null), withTpl, { type: "add" });
    expect(f.participants).toHaveLength(3);
    expect(f.participants[2]).toMatchObject({ providerId: "claude", model: "default", role: "Лишняя" });
    const full = run(f, withTpl, { type: "add" });
    expect(full.participants).toHaveLength(4);
    expect(reduceSetup(full, { type: "add" }, withTpl)).toBe(full);
    expect(checkSetup(full, registry).canAdd).toBe(false);
  });
  it("one provider twice with different models", () => {
    const f = run(initialForm(own, null), own, { type: "add" }, { type: "model", key: 2, model: "opus" });
    expect(f.participants.filter((p) => p.providerId === "claude").map((p) => p.model)).toEqual(["default", "opus"]);
  });
  it("rounds: 0, 21, 2.5 are not accepted; 1 and 20 are accepted", () => {
    const f = initialForm(own, null);
    for (const v of [0, 21, 2.5]) expect(reduceSetup(f, { type: "rounds", value: v }, own)).toBe(f);
    expect(run(f, own, { type: "rounds", value: 1 }).maxRounds).toBe(1);
    expect(run(f, own, { type: "rounds", value: 20 }).maxRounds).toBe(20);
  });
  it("changing the provider resets the model and keeps the role", () => {
    const f = run(initialForm(withTpl, null), withTpl, { type: "provider", key: 0, providerId: "openrouter" });
    expect(f.participants[0]).toMatchObject({ providerId: "openrouter", model: "a/b:free", role: "Критик" });
    expect(reduceSetup(f, { type: "provider", key: 0, providerId: "nope" }, withTpl)).toBe(f);
  });
  it("moving carries the whole row and does not go past the edge", () => {
    const f = initialForm(withTpl, null);
    const m = run(f, withTpl, { type: "move", key: 0, delta: 1 });
    expect(m.participants.map((p) => [p.providerId, p.role])).toEqual([["codex", "Автор"], ["claude", "Критик"]]);
    expect(reduceSetup(f, { type: "move", key: 0, delta: -1 }, withTpl)).toBe(f);
    expect(reduceSetup(f, { type: "move", key: 1, delta: 1 }, withTpl)).toBe(f);
  });
  it("remove deletes the row without mutating the input", () => {
    const f = initialForm(own, null);
    expect(run(f, own, { type: "remove", key: 0 }).participants.map((p) => p.key)).toEqual([1]);
    expect(f.participants).toHaveLength(2);
  });
});

describe("checkSetup", () => {
  it("a ready form passes", () => {
    expect(checkSetup(ready(), registry)).toMatchObject({ canStart: true, startHint: null, topicError: null, countError: null });
  });
  it("one participant remains", () => {
    const c = checkSetup(run(ready(), own, { type: "remove", key: 0 }), registry);
    expect(c.canStart).toBe(false);
    expect(c.countError).toBe("Нужно не меньше двух участников");
  });
  it("topic of spaces", () => {
    const c = checkSetup(run(ready(), own, { type: "topic", value: "   " }), registry);
    expect(c.topicError).toBe("Тема обязательна");
    expect(c.canStart).toBe(false);
  });
  it("unavailable provider: hint names the number, the provider and the reason", () => {
    const c = checkSetup(run(ready(), own, { type: "provider", key: 1, providerId: "broken" }), registry);
    expect(c.canStart).toBe(false);
    expect(c.participantErrors).toEqual([null, "Сломан недоступен: нет ключа"]);
    expect(c.startHint).toBe("Участник 2: Сломан недоступен: нет ключа");
  });
  it("empty topic and one participant — verbatim", () => {
    const f = run(initialForm(own, null), own, { type: "remove", key: 0 });
    expect(checkSetup(f, registry).startHint).toBe("Заполните тему и добавьте второго участника");
  });
  it("three parts are joined with a comma and «and»", () => {
    const f = run(initialForm(own, [{ providerId: "claude", model: "" }]), own);
    expect(checkSetup(f, registry).startHint).toBe("Заполните тему, добавьте второго участника и участник 1: Модель не выбрана");
  });
  it("no participants", () => {
    const f = { ...ready(), participants: [] };
    expect(checkSetup(f, registry).startHint).toBe("Добавьте двух участников");
  });
});

describe("billingOf", () => {
  it("rules", () => {
    expect(billingOf(undefined, "x")).toBe("free");
    expect(billingOf(router, "a/b:free")).toBe("free");
    expect(billingOf(router, "a/c")).toBe("paid");
    expect(billingOf(claude, "x:free")).toBe("subscription");
  });
});

describe("estimate", () => {
  const pick = (...rows: [string, string][]): SetupForm => ({
    ...ready(), participants: rows.map(([providerId, model], key) => ({ key, providerId, model, role: "" })), nextKey: rows.length,
  });
  it("2 participants × 6 rounds", () => {
    const e = estimate(pick(["claude", "default"], ["codex", "default"]), registry);
    expect(e).toMatchObject({ calls: 36, callsText: "не более 36 вызовов", free: false, note: "Claude Code и Codex расходуют подписку" });
  });
  it("subscription plus a free model of a paid provider", () => {
    const e = estimate(pick(["claude", "default"], ["codex", "default"], ["openrouter", "a/b:free"]), registry);
    expect(e?.note).toBe("Claude Code и Codex расходуют подписку; OpenRouter — бесплатная модель");
  });
  it("paid and three subscription names", () => {
    expect(estimate(pick(["claude", "default"], ["openrouter", "a/c"]), registry)?.note).toBe("Claude Code расходует подписку; OpenRouter оплачивается по тарифу провайдера");
  });
  it("scripted — free", () => {
    const e = estimate(pick(["scripted", "s"], ["scripted", "s"]), registry);
    expect(e).toMatchObject({ free: true, note: "Сессия бесплатна: участники не расходуют подписку и не оплачиваются" });
  });
  it("fewer than two participants — null", () => {
    expect(estimate(pick(["claude", "default"]), registry)).toBeNull();
  });
  it("form «21 calls»", () => {
    const f = { ...pick(["scripted", "s"], ["scripted", "s"], ["scripted", "s"], ["scripted", "s"], ["scripted", "s"], ["scripted", "s"], ["scripted", "s"]), maxRounds: 1 };
    expect(estimate(f, registry)?.callsText).toBe("не более 21 вызова");
  });
});

describe("billingNote", () => {
  const row = (label: string, billing: "subscription" | "paid" | "free", providerBilling = billing) => ({ label, billing, providerBilling });
  it("the same lines as in estimate()", () => {
    expect(billingNote([row("Claude Code", "subscription"), row("Codex", "subscription"), row("OpenRouter", "free", "paid")]))
      .toEqual({ free: false, note: "Claude Code и Codex расходуют подписку; OpenRouter — бесплатная модель" });
    expect(billingNote([row("Claude Code", "subscription"), row("OpenRouter", "paid")]).note).toBe("Claude Code расходует подписку; OpenRouter оплачивается по тарифу провайдера");
    expect(billingNote([row("A", "free"), row("B", "free")])).toEqual({ free: true, note: "Сессия бесплатна: участники не расходуют подписку и не оплачиваются" });
  });
  it("callsBound: forms", () => {
    expect(callsBound(21)).toBe("не более 21 вызова");
    expect(callsBound(9)).toBe("не более 9 вызовов");
  });
});

describe("toStartInput", () => {
  it("trims spaces, empty role — null, order kept", () => {
    const f: SetupForm = {
      ...ready(), templateId: "t", topic: "  Тема  ", maxRounds: 3, tokenCap: "", nextKey: 2,
      participants: [{ key: 1, providerId: "codex", model: "m", role: "  " }, { key: 0, providerId: "claude", model: "n", role: " Критик " }],
    };
    expect(toStartInput(f, registry)).toEqual({
      templateId: "t", topic: "Тема", maxRounds: 3, maxTotalTokens: null,
      participants: [{ providerId: "codex", model: "m", role: null }, { providerId: "claude", model: "n", role: "Критик" }],
    });
  });
});

it("materialsLeftHint: limit and «Settings»", () => {
  const h = materialsLeftHint(mv(1, 100, 60000));
  expect(h).toContain("60000");
  expect(h).toContain("по запросу");
  expect(h).toContain("«Настройках»");
});

it("materialsFolderLine: declension", () => {
  expect(materialsFolderLine({ files: 562, chars: 4861571 })).toBe("Папка: 562 файла, 4861571 знак — участники читают файлы по запросу, если тема этого требует");
  expect(materialsFolderLine({ files: 1, chars: 5 })).toContain("1 файл,");
  expect(materialsFolderLine({ files: 5, chars: 5 })).toContain("5 файлов,");
});

const mv = (n: number, chars: number, limit = 60000): MaterialsView => ({
  items: Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, name: `f${i + 1}.txt`, chars: n ? Math.floor(chars / n) : 0, source: null })),
  skipped: [], left: [], folder: null, ignored: [], error: null, chars, limit, over: Math.max(0, chars - limit), stamp: "s",
});

describe("materials", () => {
  it("total: declension and numbers without separators", () => {
    expect(materialsTotal(mv(0, 0))).toBe("0 материалов · 0 из 60000 знаков");
    expect(materialsTotal(mv(1, 100))).toBe("1 материал · 100 из 60000 знаков");
    expect(materialsTotal(mv(2, 18420))).toBe("2 материала · 18420 из 60000 знаков");
    expect(materialsTotal(mv(5, 18420))).toBe("5 материалов · 18420 из 60000 знаков");
    expect(materialsTotal(mv(21, 18420))).toBe("21 материал · 18420 из 60000 знаков");
  });
  it("exceeding text", () => {
    expect(materialsOverText(mv(3, 72000))).toBe("Материалы: 72000 знаков при лимите 60000 — превышение 12000. Уберите часть материалов.");
  });
  it("checkSetup: exceeding blocks the start (the line with numbers explains it, the hint does not duplicate); without it — the previous result", () => {
    const f = ready();
    const over = checkSetup(f, registry, mv(3, 72000));
    expect(over.canStart).toBe(false);
    expect(over.startHint).toBeNull();
    expect(checkSetup({ ...f, topic: "" }, registry, mv(3, 72000)).startHint).toBe("Заполните тему");
    expect(checkSetup(f, registry, mv(3, 60000))).toEqual(checkSetup(f, registry));
    expect(checkSetup(f, registry, null).canStart).toBe(true);
  });
  it("estimate: a line about materials; without materials the previous result", () => {
    const f = run(ready(), own, { type: "rounds", value: 6 });
    const e = estimate(f, registry, mv(2, 12400))!;
    expect(e.callsText).toBe("не более 36 вызовов");
    expect(e.materialsNote).toBe("Материалы: 12400 знаков уходят в каждый вызов");
    expect(estimate(f, registry, mv(0, 0))).toEqual(estimate(f, registry));
    expect(estimate(f, registry, null)).not.toHaveProperty("materialsNote");
  });
  it("toStartInput: useMaterials only with a non-empty list", () => {
    const f = ready();
    expect(toStartInput(f, registry, mv(1, 10)).useMaterials).toBe(true);
    expect(toStartInput(f, registry, mv(0, 0))).not.toHaveProperty("useMaterials");
    expect(toStartInput(f, registry)).not.toHaveProperty("useMaterials");
  });
  it.each([
    [1, true, true],
    [1, false, true],
    [0, true, true], // lines removed or did not fit, the folder stayed: the folder snapshot must go to the session
    [0, false, false],
  ])("toStartInput: папка без начальных материалов — строк %s, папка %s → useMaterials %s", (n, folder, want) => {
    const view = { ...mv(n, n * 10), folder: folder ? { files: 1, chars: 2398 } : null };
    expect(toStartInput(ready(), registry, view).useMaterials === true).toBe(want);
  });
});

describe("formFromRerun", () => {
  const view = (participants: RerunView["participants"]): RerunView => ({
    sessionId: "s1", date: "2026-10-07", topic: "Тема прошлой", templateId: "t", framingFromSession: true, participants, maxRounds: 3, ownerWait: null, materials: mv(0, 0),
  });
  const three = view([
    { providerId: "claude", model: "opus", role: "Критик" },
    { providerId: "codex", model: "default", role: null },
    { providerId: "scripted", model: "s", role: "Автор" },
  ]);
  it("topic, template, participants in order, roles, rounds limit", () => {
    const f = formFromRerun(three, registry);
    expect(f).toMatchObject({ topic: "Тема прошлой", templateId: "t", maxRounds: 3 });
    expect(f.participants.map((p) => [p.providerId, p.model, p.role])).toEqual([["claude", "opus", "Критик"], ["codex", "default", ""], ["scripted", "s", "Автор"]]);
    expect(checkSetup(f, registry).canStart).toBe(true);
  });
  it("an unknown provider is kept and marked; after removal the start is available", () => {
    const f = formFromRerun(view([...three.participants, { providerId: "gone", model: "x", role: null }]), registry);
    expect(f.participants).toHaveLength(4);
    const c = checkSetup(f, registry);
    expect(c.participantErrors[3]).toBe("Провайдер не найден в реестре");
    expect(c.canStart).toBe(false);
    const g = reduceSetup(f, { type: "remove", key: f.participants[3]!.key }, own);
    expect(checkSetup(g, registry).canStart).toBe(true);
  });
  it("an unavailable provider is marked", () => {
    const f = formFromRerun(view([...three.participants, { providerId: "broken", model: "m", role: null }]), registry);
    expect(checkSetup(f, registry).participantErrors[3]).toBe("Сломан недоступен: нет ключа");
  });
  it("toStartInput: framingFrom is present only when passed", () => {
    const f = formFromRerun(three, registry);
    expect(toStartInput(f, registry, null, "s1").framingFrom).toBe("s1");
    expect("framingFrom" in toStartInput(f, registry)).toBe(false);
  });
});

describe("token ceiling", () => {
  const capped: RegistryView = { ...registry, defaults: { ...registry.defaults, maxTotalTokens: 50000 } };
  const cappedCtx: SetupContext = { registry: capped, template: null };
  const withCap = (v: string) => run(ready(), own, { type: "cap", value: v });
  it("parseTokenCap: empty — null, integer from 1 — number, other — undefined", () => {
    expect(parseTokenCap("")).toBeNull();
    expect(parseTokenCap("   ")).toBeNull();
    expect([parseTokenCap("1"), parseTokenCap("50000"), parseTokenCap(" 1200 ")]).toEqual([1, 50000, 1200]);
    for (const bad of ["0", "-5", "1,5", "1.5", "много", "1e3", "99999999999999999999"]) expect(parseTokenCap(bad)).toBeUndefined();
  });
  it("initialForm: the settings value as a string, null — empty", () => {
    expect(initialForm(cappedCtx, null).tokenCap).toBe("50000");
    expect(initialForm(own, null).tokenCap).toBe("");
  });
  it("formFromRerun takes the settings value", () => {
    const v: RerunView = { sessionId: "s1", date: "2026-10-07", topic: "Т", templateId: null, framingFromSession: false, participants: [{ providerId: "claude", model: "default", role: null }, { providerId: "codex", model: "default", role: null }], maxRounds: 3, ownerWait: null, materials: mv(0, 0) };
    expect(formFromRerun(v, capped).tokenCap).toBe("50000");
    expect(formFromRerun(v, registry).tokenCap).toBe("");
  });
  it("reduceSetup stores the cap value as is", () => {
    expect(withCap("много").tokenCap).toBe("много");
  });
  it("checkSetup: an error blocks the start, one hint together with the topic", () => {
    const c = checkSetup(withCap("много"), registry);
    expect(c).toMatchObject({ capError: "Нужно целое число от 1", canStart: false, startHint: "Исправьте потолок токенов" });
    expect(checkSetup({ ...withCap("0"), topic: "" }, registry).startHint).toBe("Заполните тему и исправьте потолок токенов");
    expect(checkSetup(withCap(""), registry)).toMatchObject({ capError: null, canStart: true });
    expect(checkSetup(withCap("1200"), registry).canStart).toBe(true);
  });
  it("estimate: capNote of three kinds; a free session stays free", () => {
    expect(estimate(withCap("1200"), registry)!.capNote).toBe("потолок 1200 токенов");
    expect(estimate(withCap(""), registry)!.capNote).toBe("потолка нет");
    expect(estimate(withCap("много"), registry)).not.toHaveProperty("capNote");
    const free = run(ready(), own, { type: "provider", key: 0, providerId: "scripted" }, { type: "provider", key: 1, providerId: "scripted" }, { type: "cap", value: "500" });
    expect(estimate(free, registry)).toMatchObject({ free: true, capNote: "потолок 500 токенов" });
  });
  it("toStartInput: number, null for an empty field, no field when not accepted", () => {
    expect(toStartInput(withCap("1200"), registry).maxTotalTokens).toBe(1200);
    expect(toStartInput(withCap(""), registry)).toHaveProperty("maxTotalTokens", null);
    expect(toStartInput(withCap("много"), registry)).not.toHaveProperty("maxTotalTokens");
  });
});

describe("setupTemplateData", () => {
  const snap = (category: string): TemplateEditorData => ({
    id: null, origin: "new", categories: ["c", "d"], takenIds: ["t"],
    draft: { title: "", category, description: "", exampleTopic: "", framing: "Рамка снимка", roles: [], limits: {} }
  });
  const ids = (f: SetupForm): number[] => f.participants.map((p) => p.key);
  it("template: topic, roles, rounds from the form; frame and category from the snapshot", () => {
    const f = run(initialForm(withTpl, null), withTpl, { type: "topic", value: "Моя тема" }, { type: "role", key: ids(initialForm(withTpl, null))[0]!, role: "Новая" }, { type: "rounds", value: 5 });
    const d = setupTemplateData(f, snap("c")).draft;
    expect(d).toEqual({ title: "", category: "c", description: "Моя тема", exampleTopic: "Моя тема", framing: "Рамка снимка", roles: ["Новая", "Автор"], limits: { maxRounds: 5 } });
  });
  it("custom topic: roles empty, category empty", () => {
    const d = setupTemplateData(ready(), snap("")).draft;
    expect(d).toMatchObject({ roles: [], category: "", framing: "Рамка снимка", exampleTopic: "Тема" });
  });
  it("empty topic gives empty fields", () => {
    const d = setupTemplateData(initialForm(own, null), snap("")).draft;
    expect(d).toMatchObject({ exampleTopic: "", description: "" });
  });
  it("an empty role between filled ones stays in place", () => {
    const f0 = ready();
    const [a, b] = ids(f0) as [number, number];
    const f = run(f0, own, { type: "add" }, { type: "role", key: a, role: "А" }, { type: "role", key: b, role: "  " });
    const k = ids(f)[2]!;
    expect(setupTemplateData(run(f, own, { type: "role", key: k, role: "В" }), snap("")).draft.roles).toEqual(["А", "", "В"]);
  });
  it("all roles empty or of spaces give []", () => {
    const f0 = ready();
    const f = run(f0, own, { type: "role", key: ids(f0)[0]!, role: "   " });
    expect(setupTemplateData(f, snap("")).draft.roles).toEqual([]);
  });
  it("no providers and models", () => {
    const d = setupTemplateData(ready(withTpl), snap("c"));
    expect(Object.keys(d.draft).sort()).toEqual(["category", "description", "exampleTopic", "framing", "limits", "roles", "title"]);
    expect(Object.keys(d.draft.limits)).toEqual(["maxRounds"]);
    const j = JSON.stringify(d);
    expect(j).not.toContain("claude");
    expect(j).not.toContain("codex");
    expect(j).not.toContain("providerId");
  });
  it("form and snapshot are not changed", () => {
    const f = ready(withTpl);
    const s = snap("c");
    const f0 = structuredClone(f);
    const s0 = structuredClone(s);
    setupTemplateData(f, s);
    expect(f).toEqual(f0);
    expect(s).toEqual(s0);
  });
  it("with the editor: an incomplete setup is not saved, a complete one — only without a name", () => {
    const s = snap("c");
    const empty = initialForm(own, null);
    const c1 = checkEditor(initialEditor(setupTemplateData(empty, s)), setupTemplateData(empty, s));
    expect(c1.canSave).toBe(false);
    expect(c1.errors.exampleTopic).toBeDefined();
    expect(c1.errors.description).toBeDefined();
    const f0 = ready();
    const f = run(f0, own, { type: "role", key: ids(f0)[1]!, role: "Р" });
    const d = setupTemplateData(f, s);
    const c2 = checkEditor(initialEditor(d), d);
    expect(c2.canSave).toBe(false);
    expect(Object.values(c2.roleErrors)).toHaveLength(1);
    const ok = setupTemplateData(ready(withTpl), s);
    const c3 = checkEditor(initialEditor(ok), ok);
    expect(Object.keys(c3.errors)).toEqual(["title"]);
    expect(c3.roleErrors).toEqual({});
  });
});

describe("owner wait", () => {
  const waiting = (waitSec = "60"): SetupForm => run(ready(), own,
    { type: "pause-after-round", value: true }, { type: "wait-for-owner", value: true }, { type: "wait-sec", value: waitSec });
  it("off by default, deadline from the registry, no fields in the launch", () => {
    const r = { ...registry, ownerWait: { minSec: 10, maxSec: 90, defaultSec: 45 } };
    const f = initialForm({ registry: r, template: null }, null);
    expect(f).toMatchObject({ pauseAfterRound: false, waitForOwner: false, waitSec: "45" });
    expect(toStartInput(f, r)).not.toHaveProperty("ownerWait");
  });
  it("both modes go into the launch together with the deadline", () => {
    expect(toStartInput(waiting(), registry).ownerWait).toEqual({ pauseAfterRound: true, waitForOwner: true, timeoutSec: 60 });
  });
  it.each(["pause-after-round", "wait-for-owner"] as const)("one mode %s leaves the second one off", (type) => {
    const f = run(ready(), own, { type, value: true }, { type: "wait-sec", value: "60" });
    expect(toStartInput(f, registry).ownerWait).toEqual({ pauseAfterRound: type === "pause-after-round", waitForOwner: type === "wait-for-owner", timeoutSec: 60 });
  });
  it("the parser accepts only digits and the bounds from the registry", () => {
    const bounds = { minSec: 10, maxSec: 90 };
    expect(["10", "90", " 60 "].map((t) => parseWaitSec(t, bounds))).toEqual([10, 90, 60]);
    for (const t of ["9", "91", "-10", "+10", "1e1", "1,5", "99999999999999999999"]) expect(parseWaitSec(t, bounds)).toBeUndefined();
  });
  it.each(["0", "86401", "1.5", "abc", ""])("invalid deadline «%s» blocks only the enabled wait", (text) => {
    const f = waiting(text);
    expect(checkSetup(f, registry)).toMatchObject({ waitError: "Нужно целое число от 1 до 86400", canStart: false });
    expect(checkSetup({ ...f, topic: "" }, registry).startHint).toContain("исправьте время ожидания");
    expect(toStartInput(f, registry)).not.toHaveProperty("ownerWait");
    const off = run(f, own, { type: "pause-after-round", value: false }, { type: "wait-for-owner", value: false });
    expect(off.waitSec).toBe(text);
    expect(checkSetup(off, registry)).toMatchObject({ waitError: null, canStart: true });
    expect(toStartInput(off, registry)).not.toHaveProperty("ownerWait");
  });
  it("the error names the bounds of the received registry", () => {
    const r = { ...registry, ownerWait: { minSec: 10, maxSec: 90, defaultSec: 45 } };
    expect(checkSetup(waiting("9"), r).waitError).toBe("Нужно целое число от 10 до 90");
    expect(toStartInput(waiting("9"), r)).not.toHaveProperty("ownerWait");
  });
  it("rerun keeps the modes and deadline; null turns both modes off", () => {
    const view: RerunView = { sessionId: "s", date: "2026-10-09", topic: "Тема", templateId: null, framingFromSession: false, participants: [], maxRounds: 3, materials: mv(0, 0), ownerWait: { pauseAfterRound: true, waitForOwner: true, timeoutSec: 60 } };
    expect(formFromRerun(view, registry)).toMatchObject({ pauseAfterRound: true, waitForOwner: true, waitSec: "60" });
    expect(formFromRerun({ ...view, ownerWait: null }, registry)).toMatchObject({ pauseAfterRound: false, waitForOwner: false, waitSec: "300" });
  });
});

describe("materials preview", () => {
  const mv = (stamp: string): MaterialsView => ({ items: [{ id: "m1", name: "a", chars: 1, source: null }], skipped: [], left: [], folder: null, ignored: [], error: null, chars: 1, limit: 60000, over: 0, stamp });
  const acc = { handle: "h1", stamp: "s1", createdAt: "2026-10-09T11:05:00.000Z" };
  it("previewStatus", () => {
    expect(previewStatus(mv("s1"), null)).toBe("none");
    expect(previewStatus(mv("s1"), acc)).toBe("accepted");
    expect(previewStatus(mv("s2"), acc)).toBe("stale");
    expect(previewStatus(null, acc)).toBe("stale");
    expect(previewStatus(null, null)).toBe("none");
  });
  it("previewIsCurrent", () => {
    expect(previewIsCurrent(mv("s1"), { stamp: "s1" })).toBe(true);
    expect(previewIsCurrent(mv("s2"), { stamp: "s1" })).toBe(false);
    expect(previewIsCurrent(null, { stamp: "s1" })).toBe(false);
    expect(previewIsCurrent(mv("s1"), null)).toBe(false);
  });
  it("toStartInput: preparedHandle only for an accepted current set", () => {
    const f = ready();
    const base = toStartInput(f, registry, mv("s1"));
    expect(base).not.toHaveProperty("preparedHandle");
    expect(toStartInput(f, registry, mv("s1"), undefined, acc)).toEqual({ ...base, preparedHandle: "h1" });
    expect(toStartInput(f, registry, mv("s2"), undefined, acc)).toEqual({ ...toStartInput(f, registry, mv("s2")) });
    expect(toStartInput(f, registry, mv("s2"), undefined, acc)).not.toHaveProperty("preparedHandle");
  });
});

const pos = (o: Partial<LineupPositionView> & Pick<LineupPositionView, "providerId" | "model">): LineupPositionView => ({ role: null, available: true, reason: null, modelNote: null, ...o });

describe("lineup action", () => {
  const base = { ...ready(), maxRounds: 9, tokenCap: "500", pauseAfterRound: true, waitForOwner: true, waitSec: "77" };
  const positions = [pos({ providerId: "claude", model: "opus", role: "Критик" }), pos({ providerId: "scripted", model: "x.json", available: false, reason: "Сценарий «x.json» недоступен." }), pos({ providerId: "codex", model: "m", modelNote: "Модели «m» нет в перечне." })];
  const applied = run(base, own, { type: "lineup", participants: positions });
  it("replaces participants in order, leaves the rest untouched", () => {
    expect(applied.participants.map((p) => [p.providerId, p.model, p.role])).toEqual([["claude", "opus", "Критик"], ["scripted", "x.json", ""], ["codex", "m", ""]]);
    expect(new Set(applied.participants.map((p) => p.key)).size).toBe(3);
    expect(applied.nextKey).toBe(base.nextKey + 3);
    const { participants: _a, nextKey: _b, ...rest } = applied;
    const { participants: _c, nextKey: _d, ...was } = base;
    expect(rest).toEqual(was);
    expect(applied.participants.map((p) => [p.issue, p.note])).toEqual([[null, null], ["Сценарий «x.json» недоступен.", null], [null, "Модели «m» нет в перечне."]]);
  });
  it("an unavailable position without a reason gets the general one", () => {
    expect(run(base, own, { type: "lineup", participants: [pos({ providerId: "a", model: "b", available: false })] }).participants[0]!.issue).toBe("Позиция состава недоступна");
  });
  it("provider and model clear issue and note only on their own row; role and move keep them", () => {
    const [a, b, c] = applied.participants.map((p) => p.key) as [number, number, number];
    const bad = (f: SetupForm) => f.participants.map((p) => [p.issue ?? null, p.note ?? null]);
    expect(bad(run(applied, own, { type: "model", key: b, model: "s" }))).toEqual([[null, null], [null, null], [null, "Модели «m» нет в перечне."]]);
    expect(bad(run(applied, own, { type: "provider", key: c, providerId: "claude" }))[2]).toEqual([null, null]);
    expect(bad(run(applied, own, { type: "provider", key: c, providerId: "claude" }))[1]).toEqual(["Сценарий «x.json» недоступен.", null]);
    expect(bad(run(applied, own, { type: "role", key: b, role: "Р" }))).toEqual(bad(applied));
    expect(bad(run(applied, own, { type: "move", key: a, delta: 1 }))).toEqual([bad(applied)[1], bad(applied)[0], bad(applied)[2]]);
  });
  it("checkSetup: issue blocks, note does not", () => {
    const c = checkSetup(applied, registry);
    expect(c.canStart).toBe(false);
    expect(c.startHint).toContain("частник 2: Сценарий «x.json» недоступен.");
    expect(c.participantNotes).toEqual([null, null, "Модели «m» нет в перечне."]);
    const fixed = run(applied, own, { type: "model", key: applied.participants[1]!.key, model: "s" });
    expect(checkSetup(fixed, registry).canStart).toBe(true);
    expect(checkSetup(fixed, registry).participantNotes[2]).toBe("Модели «m» нет в перечне.");
  });
  it("the earlier rule takes precedence over issue", () => {
    const f = run(base, own, { type: "lineup", participants: [pos({ providerId: "gone", model: "m", available: false, reason: "Причина" }), pos({ providerId: "claude", model: "default" })] });
    expect(checkSetup(f, registry).participantErrors[0]).toBe("Провайдер не найден в реестре");
  });
  it("toStartInput does not pass issue, note, key", () => {
    const f = run(base, own, { type: "lineup", participants: [pos({ providerId: "claude", model: "default", modelNote: "н" }), pos({ providerId: "codex", model: "default", role: " Р " })] });
    const input = toStartInput(f, registry);
    expect(input.participants).toEqual([{ providerId: "claude", model: "default", role: null }, { providerId: "codex", model: "default", role: "Р" }]);
  });
});

describe("lineupSaveInput, lineupLabel", () => {
  it("order, role trimming, empty role, three keys", () => {
    const f = { ...ready(), participants: [{ key: 5, providerId: "codex", model: "m", role: "  Р  ", issue: "x", note: "y" }, { key: 2, providerId: "claude", model: "default", role: "   " }] };
    const r = lineupSaveInput(f, "Имя");
    expect(r).toEqual({ name: "Имя", participants: [{ providerId: "codex", model: "m", role: "Р" }, { providerId: "claude", model: "default", role: null }] });
    expect(Object.keys(r.participants[0]!).sort()).toEqual(["model", "providerId", "role"]);
  });
  it("label of an unavailable lineup", () => {
    expect(lineupLabel({ id: "1", name: "А", available: true, participants: [] })).toBe("А");
    expect(lineupLabel({ id: "1", name: "А", available: false, participants: [] })).toBe("А — есть недоступные");
  });
});

describe("Save a named lineup from settings: save and apply return the same lineup", () => {
  const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rnd = mulberry32(20260509);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const providers = ["claude", "codex", "openrouter", "scripted", "gone", "неизвестный"];
  const roles = ["", "   ", "  Критик ", "Автор", "Роль с пробелами внутри", "\tТаб\n"];
  const randomForm = (count: number, mode: "mixed" | "emptyRoles" | "same"): SetupForm => ({
    ...ready(), topic: `t${rnd()}`, templateId: rnd() < 0.5 ? null : "t", maxRounds: 1 + Math.floor(rnd() * 20), tokenCap: String(Math.floor(rnd() * 1000)), pauseAfterRound: rnd() < 0.5, waitForOwner: rnd() < 0.5, waitSec: String(Math.floor(rnd() * 100)), nextKey: Math.floor(rnd() * 50),
    participants: Array.from({ length: count }, (_, i) => mode === "same" ? { key: i, providerId: "claude", model: "default", role: pick(roles) } : { key: i, providerId: pick(providers), model: pick(["default", "opus", "m", "a/b:free", ""]), role: mode === "emptyRoles" ? "" : pick(roles) }),
  });
  it("no fewer than 200 cases, including bounds", () => {
    let cases = 0;
    const seen = { two: false, eight: false, empty: false, same: false };
    for (let n = 0; n < 240; n++) {
      const count = n % 12 === 0 ? 2 : n % 12 === 1 ? 8 : 2 + Math.floor(rnd() * 7);
      const mode = n % 12 === 2 ? "emptyRoles" : n % 12 === 3 ? "same" : "mixed";
      const a = randomForm(count, mode);
      const b = randomForm(2 + Math.floor(rnd() * 7), "mixed");
      const saved = lineupSaveInput(a, "Имя").participants;
      const out = reduceSetup(b, { type: "lineup", participants: saved.map((p) => pos(p)) }, own);
      expect(out.participants.map((p) => [p.providerId, p.model, p.role])).toEqual(saved.map((p) => [p.providerId, p.model, p.role ?? ""]));
      const { participants: _a, nextKey: _b, ...rest } = out;
      const { participants: _c, nextKey: _d, ...was } = b;
      expect(rest).toEqual(was);
      seen.two ||= count === 2; seen.eight ||= count === 8; seen.empty ||= saved.every((p) => p.role === null); seen.same ||= mode === "same";
      cases++;
    }
    expect(cases).toBeGreaterThanOrEqual(200);
    expect(seen).toEqual({ two: true, eight: true, empty: true, same: true });
  });
});

describe("independent drafts", () => {
  const three = run(ready(), own, { type: "add" }, { type: "rounds", value: 2 });
  const keys = three.participants.map((p) => p.key);
  const input = (f: SetupForm) => toStartInput(f, registry);
  it("off by default: initialForm, formFromRerun, start without the drafts field", () => {
    const f = initialForm(own, null);
    expect(f).toMatchObject({ drafts: false, synthesizerKey: null });
    const rerun = formFromRerun({ sessionId: "s", date: "2026-10-07", topic: "Т", templateId: null, framingFromSession: false, participants: [{ providerId: "claude", model: "default", role: null }, { providerId: "codex", model: "default", role: null }], maxRounds: 3, ownerWait: null, materials: mv(0, 0) }, registry);
    expect(rerun).toMatchObject({ drafts: false, synthesizerKey: null });
    expect(input(three)).not.toHaveProperty("drafts");
  });
  it("enabling picks the first: estimate 27, start p1, the mark names the first one", () => {
    expect(estimate(three, registry)!.calls).toBe(18);
    const f = run(three, own, { type: "drafts", value: true });
    expect(f.synthesizerKey).toBe(keys[0]);
    const e = estimate(f, registry)!;
    expect(e.calls).toBe(27);
    expect(e.callsText).toBe("не более 27 вызовов");
    expect(e.draftsNote).toBe("Независимые черновики: синтезатор — 1 · Claude Code; фаза добавляет до 9 вызовов");
    expect(input(f).drafts).toEqual({ synthesizerId: "p1" });
  });
  it("choosing the second gives p2, moving up keeps the key and gives p1", () => {
    const f = run(three, own, { type: "drafts", value: true }, { type: "synthesizer", key: keys[1]! });
    expect(input(f).drafts).toEqual({ synthesizerId: "p2" });
    const g = run(f, own, { type: "move", key: keys[1]!, delta: -1 });
    expect(g.synthesizerKey).toBe(keys[1]);
    expect(input(g).drafts).toEqual({ synthesizerId: "p1" });
    expect(synthesizerOf(g)).toEqual({ index: 0, key: keys[1]! });
  });
  it("deleting the selected one moves the selection to the first remaining", () => {
    const f = run(three, own, { type: "drafts", value: true }, { type: "synthesizer", key: keys[1]! }, { type: "remove", key: keys[1]! });
    expect(f.synthesizerKey).toBe(keys[0]);
    expect(f.participants.some((p) => p.key === keys[1])).toBe(false);
  });
  it("the lineup action selects the first participant of the new lineup", () => {
    const f = run(three, own, { type: "drafts", value: true }, { type: "synthesizer", key: keys[2]! }, { type: "lineup", participants: [pos({ providerId: "codex", model: "default" }), pos({ providerId: "claude", model: "default" })] });
    expect(f.synthesizerKey).toBe(f.participants[0]!.key);
    expect(keys).not.toContain(f.synthesizerKey);
  });
  it("turning off resets the key, the estimate and the drafts field", () => {
    const f = run(three, own, { type: "drafts", value: true }, { type: "drafts", value: false });
    expect(f.synthesizerKey).toBeNull();
    expect(estimate(f, registry)!.calls).toBe(18);
    expect(estimate(f, registry)).not.toHaveProperty("draftsNote");
    expect(input(f)).not.toHaveProperty("drafts");
  });
  it("a synthesizer with a foreign key or with the option off does not change the form", () => {
    const on = run(three, own, { type: "drafts", value: true });
    expect(reduceSetup(on, { type: "synthesizer", key: 9999 }, own)).toBe(on);
    expect(reduceSetup(three, { type: "synthesizer", key: keys[1]! }, own)).toBe(three);
  });

  it("Independent drafts setup: for any sequence of actions the synthesizer is a participant of the lineup", () => {
    const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const rnd = mulberry32(20261009);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const seen = { emptyOn: 0, lineupOn: 0, reEnable: 0, foreignKey: 0 };
    for (let n0 = 0; n0 < 400; n0++) {
      let f = initialForm(own, null);
      let wasOn = false;
      const steps = 1 + Math.floor(rnd() * 40);
      for (let s = 0; s < steps; s++) {
        const k = rnd();
        let a: SetupAction;
        if (k < 0.12) a = { type: "add" };
        else if (k < 0.3) a = { type: "remove", key: rnd() < 0.85 && f.participants.length ? pick(f.participants).key : 9999 };
        else if (k < 0.4) a = { type: "move", key: f.participants.length ? pick(f.participants).key : 0, delta: rnd() < 0.5 ? -1 : 1 };
        else if (k < 0.55) a = { type: "drafts", value: rnd() < 0.6 };
        else if (k < 0.7) a = { type: "synthesizer", key: rnd() < 0.7 && f.participants.length ? pick(f.participants).key : 9000 + Math.floor(rnd() * 5) };
        else if (k < 0.8) a = { type: "lineup", participants: Array.from({ length: Math.floor(rnd() * 4) }, () => pos({ providerId: pick(["claude", "codex", "scripted"]), model: "default" })) };
        else if (k < 0.9) a = { type: "provider", key: f.participants.length ? pick(f.participants).key : 0, providerId: pick(["claude", "codex", "scripted"]) };
        else a = { type: "rounds", value: 1 + Math.floor(rnd() * 6) };
        if (a.type === "synthesizer" && !f.participants.some((p) => p.key === a.key)) seen.foreignKey++;
        const before = f;
        f = reduceSetup(f, a, own);
        if (a.type === "drafts" && a.value && !before.drafts && wasOn) seen.reEnable++;
        if (f.drafts) wasOn = true;
        if (f.drafts && f.participants.length === 0) seen.emptyOn++;
        if (a.type === "lineup" && before.drafts && f.drafts) seen.lineupOn++;
        const n = f.participants.length;
        if (!f.drafts) expect(f.synthesizerKey).toBeNull();
        else if (n > 0) expect(f.participants.some((p) => p.key === f.synthesizerKey)).toBe(true);
        else expect(f.synthesizerKey).toBeNull();
        if (n >= 2) expect(estimate(f, registry)!.calls).toBe(maxCallsBound(n, f.maxRounds, f.drafts));
        if (f.drafts && n > 0) {
          const place = f.participants.findIndex((p) => p.key === f.synthesizerKey);
          expect(toStartInput(f, registry).drafts?.synthesizerId).toBe(`p${place + 1}`);
        } else expect(toStartInput(f, registry)).not.toHaveProperty("drafts");
      }
    }
    expect(seen.emptyOn).toBeGreaterThan(0);
    expect(seen.lineupOn).toBeGreaterThan(0);
    expect(seen.reEnable).toBeGreaterThan(0);
    expect(seen.foreignKey).toBeGreaterThan(0);
  });
});

describe("setup: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const NO_CYR = /[А-Яа-яЁё]/;
  const mat = (items: number, chars: number, limit = 100): MaterialsView => ({ items: Array.from({ length: items }, (_, i) => ({ id: `m${i + 1}`, name: `f${i}`, chars: 1, source: null })), skipped: [], left: [], folder: null, ignored: [], error: null, chars, limit, over: Math.max(0, chars - limit), stamp: "s" });
  const enReg: RegistryView = { ...registry, providers: [claude, codex, router, prov("scripted", "Scripted", "free", ["s"]), prov("broken", "Broken", "paid", ["m"], false, "no key")] };
  const form = (ps: [string, string][], over: Partial<SetupForm> = {}): SetupForm => ({ ...initialForm({ registry: enReg, template: null }, null), participants: ps.map(([providerId, model], key) => ({ key, providerId, model, role: "" })), nextKey: ps.length, ...over });

  it("en texts are exact and without Cyrillic", () => {
    const m = mat(2, 150, 100);
    expect(materialsTotal(m, "en")).toBe("2 materials · 150 of 100 characters");
    expect(materialsOverText(m, "en")).toBe("Materials: 150 characters against a limit of 100 — over by 50. Remove some of the materials.");
    expect(materialsLeftHint(m, "en")).toBe("The request includes descriptions within the limit of 100 characters. Participants will read the remaining files of the folder on request if the topic needs it; the limit is changed in “Settings”.");
    expect(materialsFolderLine({ files: 3, chars: 2398 }, "en")).toBe("Folder: 3 files, 2398 characters — participants read files on request if the topic needs it");
    expect(lineupLabel({ id: "l", name: "Duo", available: false, participants: [] }, "en")).toBe("Duo — has unavailable positions");
    expect(callsBound(7, "en")).toBe("at most 7 calls");
    expect(billingNote([{ label: "A", billing: "free", providerBilling: "free" }], "en")).toEqual({ free: true, note: "The session is free: participants neither use a subscription nor are billed" });
    const rows = [
      { label: "Claude Code", billing: "subscription" as const, providerBilling: "subscription" as const },
      { label: "Codex", billing: "subscription" as const, providerBilling: "subscription" as const },
      { label: "OpenRouter", billing: "paid" as const, providerBilling: "paid" as const },
      { label: "Free", billing: "free" as const, providerBilling: "paid" as const },
    ];
    expect(billingNote(rows, "en").note).toBe("Claude Code and Codex use the subscription; OpenRouter is billed at the provider’s rate; Free — free model");
    const d = estimate(form([["claude", "default"], ["codex", "default"]], { drafts: true, synthesizerKey: 1, tokenCap: "1" }), enReg, mat(1, 5), "en")!;
    expect(d.materialsNote).toBe("Materials: 5 characters go into every call");
    expect(d.capNote).toBe("cap 1 token");
    expect(d.draftsNote).toBe(`Independent drafts: synthesizer — 2 · Codex; the phase adds up to ${maxCallsBound(2, 0, true)} calls`);
    expect(estimate(form([["claude", "default"], ["codex", "default"]]), enReg, null, "en")!.capNote).toBe("no cap");
    const c = checkSetup(form([["claude", "default"], ["broken", "m"], ["claude", ""], ["claude", "default"], ["claude", "default"]], { tokenCap: "x", pauseAfterRound: true, waitSec: "0" }), enReg, mat(1, 200), "en");
    expect(c).toMatchObject({ topicError: "Topic is required", countError: "No more than 4 participants", capError: "An integer of 1 or more is required", waitError: "An integer from 1 to 86400 is required", participantErrors: [null, "Broken is unavailable: no key", "No model selected", null, null] });
    expect(c.startHint).toBe("Fill in the topic, keep no more than 4 participants, participant 2: Broken is unavailable: no key, participant 3: No model selected, fix the token cap, and fix the wait time");
    expect(checkSetup(form([["claude", "default"]]), enReg, null, "en").startHint).toBe("Fill in the topic and add a second participant");
    expect(checkSetup(form([]), enReg, null, "en").countError).toBe("At least two participants are required");
    expect(checkSetup(form([["nope", "m"], ["claude", "default"]]), enReg, null, "en").participantErrors[0]).toBe("Provider not found in the registry");
    expect(checkSetup(form([["broken", "m"], ["claude", "default"]]), { ...enReg, providers: [{ ...prov("broken", "Broken", "paid", ["m"], false, null) }, claude] }, null, "en").participantErrors[0]).toBe("Broken is unavailable: reason unknown");
    const lineup = reduceSetup(form([]), { type: "lineup", participants: [{ providerId: "claude", model: "default", role: null, available: false, reason: null, modelNote: null } as LineupPositionView] }, { registry: enReg, template: null }, "en");
    expect(lineup.participants[0]!.issue).toBe("Lineup position unavailable");
    for (const text of [materialsTotal(m, "en"), materialsOverText(m, "en"), materialsLeftHint(m, "en"), materialsFolderLine({ files: 1, chars: 1 }, "en"), d.note, d.callsText, d.materialsNote!, d.capNote!, d.draftsNote!, c.startHint!, c.waitError!, lineup.participants[0]!.issue!]) expect(text).not.toMatch(NO_CYR);
  });

  it("plural forms in en and ru", () => {
    const ru = { m: ["материал", "материала", "материалов", "материалов", "материал"], f: ["файл", "файла", "файлов", "файлов", "файл"], t: ["токен", "токена", "токенов", "токенов", "токен"] };
    [1, 2, 5, 11, 21].forEach((n, i) => {
      expect(materialsTotal(mat(n, 0), "ru")).toBe(`${n} ${ru.m[i]} · 0 из 100 знаков`);
      expect(materialsTotal(mat(n, 0), "en")).toBe(`${n} ${n === 1 ? "material" : "materials"} · 0 of 100 characters`);
      expect(materialsFolderLine({ files: n, chars: 5 }, "ru")).toBe(`Папка: ${n} ${ru.f[i]}, 5 знаков — участники читают файлы по запросу, если тема этого требует`);
      expect(materialsFolderLine({ files: n, chars: 5 }, "en")).toContain(`Folder: ${n} ${n === 1 ? "file" : "files"}, 5 characters`);
      expect(callsBound(n, "en")).toBe(`at most ${n} ${n === 1 ? "call" : "calls"}`);
      expect(callsBound(n, "ru")).toBe(`не более ${n} ${n % 10 === 1 && n % 100 !== 11 ? "вызова" : "вызовов"}`);
      const cap = (l: "en" | "ru") => estimate(form([["claude", "default"], ["codex", "default"]], { tokenCap: String(n) }), enReg, null, l)!.capNote;
      expect(cap("ru")).toBe(`потолок ${n} ${ru.t[i]}`);
      expect(cap("en")).toBe(`cap ${n} ${n === 1 ? "token" : "tokens"}`);
    });
  });

  it("preview time follows the language", () => {
    const at = (h: number, m: number) => new Date(2026, 9, 9, h, m).toISOString();
    const flat = (t: string) => t.replace(/\s/g, " ");
    const cases: [number, number, string, string][] = [[0, 0, "00:00", "12:00 AM"], [9, 5, "09:05", "9:05 AM"], [12, 0, "12:00", "12:00 PM"], [14, 5, "14:05", "2:05 PM"], [23, 59, "23:59", "11:59 PM"]];
    for (const [h, m, ru, en] of cases) {
      expect(previewTime(at(h, m), "ru")).toBe(ru);
      expect(flat(previewTime(at(h, m), "en"))).toBe(en);
    }
  });

  it("folder line in en: the singular for counts", () => {
    expect(materialsFolderLine({ files: 1, chars: 1 }, "en")).toBe("Folder: 1 file, 1 character — participants read files on request if the topic needs it");
    expect(materialsFolderLine({ files: 2, chars: 286 }, "en")).toBe("Folder: 2 files, 286 characters — participants read files on request if the topic needs it");
    expect(materialsFolderLine({ files: 1, chars: 1 }, "ru")).toBe("Папка: 1 файл, 1 знак — участники читают файлы по запросу, если тема этого требует");
  });

  it("the language parameter takes priority over the process language", () => {
    setProcessLanguage("ru");
    expect(callsBound(3, "en")).toBe("at most 3 calls");
    expect(materialsTotal(mat(1, 1), "en")).toBe("1 material · 1 of 100 characters");
    expect(checkSetup(form([]), enReg, null, "en").topicError).toBe("Topic is required");
    setProcessLanguage("en");
    expect(callsBound(3)).toBe("at most 3 calls");
    expect(callsBound(3, "ru")).toBe("не более 3 вызовов");
    expect(checkSetup(form([]), enReg).topicError).toBe("Topic is required");
  });

  it("bounds and parsing do not depend on the language", () => {
    const f = form([["claude", "default"], ["broken", "m"]], { tokenCap: "0", topic: "t" });
    const pick = (c: ReturnType<typeof checkSetup>) => ({ ...c, topicError: !!c.topicError, countError: !!c.countError, capError: !!c.capError, waitError: !!c.waitError, participantErrors: c.participantErrors.map((e) => e !== null), startHint: !!c.startHint });
    expect(pick(checkSetup(f, enReg, mat(1, 200), "en"))).toEqual(pick(checkSetup(f, enReg, mat(1, 200), "ru")));
    expect(checkSetup(f, enReg, null, "en").canStart).toBe(false);
    expect(checkSetup(f, enReg, null, "en").participantErrors).not.toEqual(checkSetup(f, enReg, null, "ru").participantErrors);
    for (const l of ["en", "ru"] as const) {
      setProcessLanguage(l);
      expect([parseTokenCap(""), parseTokenCap(" 12 "), parseTokenCap("0"), parseTokenCap("1.5")]).toEqual([null, 12, undefined, undefined]);
    }
  });
});

// Independent oracle of endings: by remainders, without Intl.PluralRules and plural.
const ends1 = (n: number): boolean => n % 10 === 1 && n % 100 !== 11;
const ends234 = (n: number): boolean => [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100);
const gen2 = (n: number, one: string, other: string): string => (ends1(n) ? one : other);
const nom3 = (n: number, one: string, few: string, many: string): string => (ends1(n) ? one : ends234(n) ? few : many);
const upTo1200 = Array.from({ length: 1201 }, (_, n) => n);

describe("Numbers, dates and plural forms of the preparation screens by language: declension of counts and calls for any n", () => {
  it("ru: after «of N» and «limit N» — genitive, folder line — nominative, «up to N calls» — as callsBound", () => {
    for (const n of upTo1200) {
      expect(materialsTotal(mv(1, 1, n), "ru")).toBe(`1 материал · 1 из ${n} ${gen2(n, "знака", "знаков")}`);
      expect(materialsLeftHint(mv(1, 1, n), "ru")).toContain(`в пределах лимита ${n} ${gen2(n, "знака", "знаков")}. `);
      expect(materialsFolderLine({ files: 1, chars: n }, "ru")).toBe(`Папка: 1 файл, ${n} ${nom3(n, "знак", "знака", "знаков")} — участники читают файлы по запросу, если тема этого требует`);
      expect(setupMessages("ru").draftsNote(1, "X", n)).toBe(`Независимые черновики: синтезатор — 1 · X; фаза добавляет до ${n} ${gen2(n, "вызова", "вызовов")}`);
    }
  });
  it("ru: 7 participants with drafts — «up to 21 calls»", () => {
    const wide: SetupContext = { registry: { ...registry, defaults: { ...registry.defaults, maxParticipants: 8 } }, template: null };
    const f = run(ready(wide), wide, ...Array.from({ length: 5 }, () => ({ type: "add" }) as SetupAction), { type: "drafts", value: true });
    expect(f.participants).toHaveLength(7);
    expect(estimate(f, wide.registry, null, "ru")!.draftsNote).toMatch(/фаза добавляет до 21 вызова$/);
  });
  it("en: lines as before", () => {
    expect([0, 1, 2, 21].map((n) => materialsTotal(mv(1, 1, n), "en"))).toEqual(["1 material · 1 of 0 characters", "1 material · 1 of 1 characters", "1 material · 1 of 2 characters", "1 material · 1 of 21 characters"]);
    expect(materialsLeftHint(mv(1, 1, 21), "en")).toContain("within the limit of 21 characters.");
    expect([0, 1, 2, 21].map((n) => materialsFolderLine({ files: 1, chars: n }, "en").split(" — ")[0])).toEqual(["Folder: 1 file, 0 characters", "Folder: 1 file, 1 character", "Folder: 1 file, 2 characters", "Folder: 1 file, 21 characters"]);
    expect([0, 1, 2, 21].map((n) => setupMessages("en").draftsNote(1, "X", n).split("; ")[1])).toEqual(["the phase adds up to 0 calls", "the phase adds up to 1 call", "the phase adds up to 2 calls", "the phase adds up to 21 calls"]);
  });
});

describe("one list of supported material formats", () => {
  const root = join(import.meta.dirname, "../../../../..");
  it("the catalog list appears verbatim in the skill and in docs/materials.md", () => {
    expect(readFileSync(join(root, "skill/osen/SKILL.md"), "utf8")).toContain(materialsMessages("en").supportedFormats);
    expect(readFileSync(join(root, "docs/materials.md"), "utf8")).toContain(materialsMessages("en").supportedFormats);
  });
  it("the setup hint names only categories", () => {
    expect(sessionSetup("ru").materialsNote).toBe("текст файлов, документов, PDF и картинок уходит в каждый ход");
    expect(sessionSetup("en").materialsNote).toBe("the text of files, documents, PDFs and pictures goes into every turn");
  });
});
