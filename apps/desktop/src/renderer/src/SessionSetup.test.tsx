import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { LineupView, MaterialsPreviewView, MaterialsView, ProviderOption, RegistryView, RosterEntry, TemplateCard } from "../../shared/setup.ts";
import { SessionSetup, startEnabled } from "./SessionSetup.tsx";
import type { LineupsProps } from "./SessionSetup.tsx";
import { formFromRerun, previewTime, initialForm, materialsFolderLine, materialsLeftHint, reduceSetup } from "./setup.ts";
import type { SetupAction, SetupContext, SetupForm } from "./setup.ts";

const prov = (o: Partial<ProviderOption> & Pick<ProviderOption, "id" | "label">): ProviderOption => ({
  kind: "cli", available: true, reason: null, models: ["default", "haiku"], defaultModel: "default", billing: "subscription", ...o
});
const claude = prov({ id: "claude", label: "Claude Code" });
const codex = prov({ id: "codex", label: "Codex" });
const router = prov({ id: "router", label: "OpenRouter", kind: "openai-http", models: ["m1"], defaultModel: null, billing: "paid" });
const scripted = prov({ id: "scripted", label: "Сценарный", kind: "scripted", models: ["scripted"], defaultModel: null, billing: "free" });
const broken = prov({ id: "broken", label: "Сломанный", available: false, reason: "Команда codex не найдена" });
const defaults = (participants: RosterEntry[], maxParticipants = 8) => ({ maxRounds: 4, maxParticipants, materialsChars: 60000, maxTotalTokens: null, participants });
const reg = (o: Partial<RegistryView> = {}): RegistryView => ({
  providers: [claude, codex, router, scripted, broken],
  ownerWait: { minSec: 1, maxSec: 86400, defaultSec: 300 },
  defaults: defaults([{ providerId: "claude", model: "default" }, { providerId: "codex", model: "default" }]),
  ...o
});
const tpl: TemplateCard = {
  id: "t1", title: "Цена и тарифы", category: "Продукт и стратегия", description: "Д", exampleTopic: "Пример темы", roles: ["Защитник", "Скептик"], maxRounds: 6, source: "builtin", modified: false
};
const make = (registry: RegistryView, template: TemplateCard | null, last: RosterEntry[] | null = null) => {
  const ctx: SetupContext = { registry, template };
  return { ctx, form: initialForm(ctx, last) };
};
const apply = (ctx: SetupContext, form: SetupForm, ...actions: SetupAction[]) => actions.reduce((f, a) => reduceSetup(f, a, ctx), form);
const noLineups: LineupsProps = { list: [], error: null, name: "", busy: false, saveError: null, pickError: null, notice: null, onPick() {}, onName() {}, onSave() {} };
const html = (form: SetupForm, registry: RegistryView, template: TemplateCard | null, o: { starting?: boolean; error?: string | null; saveAsBusy?: boolean; saveAsError?: string | null; lineups?: Partial<LineupsProps> } = {}) =>
  renderToStaticMarkup(<SessionSetup form={form} registry={registry} template={template} starting={o.starting ?? false} error={o.error ?? null} lineups={{ ...noLineups, ...o.lineups }} dispatch={() => {}} onStart={() => {}} onBack={() => {}} onSaveAs={() => {}} saveAsBusy={o.saveAsBusy ?? false} saveAsError={o.saveAsError ?? null} />);
// Element tree of the screen for finding handlers: language hooks work only inside rendering, so the call goes through a probe component.
const direct = (props: Parameters<typeof SessionSetup>[0]): ReactNode => {
  let tree: ReactNode = null;
  const Probe = (): ReactNode => (tree = SessionSetup(props));
  renderToStaticMarkup(<Probe />);
  return tree;
};
/** change 88: the call count in the estimate is wrapped in <span class="setup__cost"> — for text checks the wrapper is removed. */
const plainCost = (h: string) => h.replace(/<span class="setup__cost">([^<]*)<\/span>/g, "$1");
const startBtn = (h: string) => h.match(/<button[^>]*btn--primary[^>]*>/)![0];

describe("SessionSetup", () => {
  it("from a template: origin, topic example, roles, counter", () => {
    const r = reg();
    const { form } = make(r, tpl);
    const h = html(form, r, tpl);
    expect(h).toContain('<span class="chip">Продукт и стратегия</span><strong>Цена и тарифы</strong><span class="muted">рамка обсуждения и роли взяты из шаблона</span>');
    expect(h).toContain("Пример из шаблона — замените на свою ситуацию");
    expect(h).toContain('value="Защитник"');
    expect(h).toContain('value="Скептик"');
    expect(h).toContain("2 из 8");
    expect(h).not.toContain("Нужно не меньше двух");
  });

  it("custom topic: chip, empty topic, without the example hint", () => {
    const r = reg();
    const { form } = make(r, null);
    const h = html(form, r, null);
    expect(h).toContain('<span class="chip">Своя тема</span><span class="muted">нейтральная рамка, роли не заданы</span>');
    expect(h).toContain("Тема обязательна");
    expect(h).not.toContain("Пример из шаблона");
  });

  it("one participant: Start disabled, error and hint", () => {
    const r = reg({ defaults: defaults([{ providerId: "claude", model: "default" }]) });
    const { form } = make(r, tpl);
    const h = html(form, r, tpl);
    expect(startBtn(h)).toContain("disabled");
    expect(h).toContain("Нужно не меньше двух участников");
    expect(h).toContain("Добавьте второго участника");
    expect(h).toContain("setup__cost\">—<");
  });

  it("topic of spaces: error and button disabled", () => {
    const r = reg();
    const { ctx, form } = make(r, tpl);
    const h = html(apply(ctx, form, { type: "topic", value: "   " }), r, tpl);
    expect(h).toContain("Тема обязательна");
    expect(startBtn(h)).toContain("disabled");
  });

  it("unavailable provider: option, error, label", () => {
    const r = reg();
    const { ctx, form } = make(r, tpl);
    const h = html(apply(ctx, form, { type: "provider", key: 1, providerId: "broken" }), r, tpl);
    expect(h).toContain(">Сломанный — Команда codex не найдена</option>");
    expect(h).not.toContain("Сломанный — недоступен");
    expect(h).toContain("Сломанный недоступен: Команда codex не найдена");
    expect(startBtn(h)).toContain("disabled");
    expect(h).toContain("Участник 2: Сломанный недоступен: Команда codex не найдена");
  });

  it("Unavailable provider: a reason up to 60 characters whole, longer — trimmed with «…» and the full text in title and in the error line", () => {
    const at = (reason: string | null) => {
      const r = reg({ providers: [claude, codex, prov({ id: "broken", label: "Сломанный", available: false, reason })] });
      const { ctx, form } = make(r, tpl);
      return html(apply(ctx, form, { type: "provider", key: 1, providerId: "broken" }), r, tpl);
    };
    const r60 = "к".repeat(60);
    expect(at(r60)).toContain(`>Сломанный — ${r60}</option>`);
    const r61 = "к".repeat(61);
    const h61 = at(r61);
    expect(h61).toContain(`>Сломанный — ${"к".repeat(60)}…</option>`);
    expect(h61).toContain(`title="${r61}"`);
    expect(h61).toContain(`Сломанный недоступен: ${r61}`);
    const pair = `${"к".repeat(59)}😀дальше`; // surrogate pair — the 60th code point
    expect(at(pair)).toContain(`>Сломанный — ${"к".repeat(59)}😀…</option>`);
    expect(at("")).toContain(">Сломанный — недоступен</option>");
    expect(at(null)).toContain(">Сломанный — недоступен</option>");
  });

  it("one provider twice with different models: different names", () => {
    const r = reg();
    const { ctx, form } = make(r, tpl, [{ providerId: "claude", model: "default" }, { providerId: "claude", model: "haiku" }]);
    const h = html(form, r, tpl);
    // change 88: name without « (model)», the model as a separate tag; the default model has no tag
    expect(h.match(/<div class="participant__name">Claude Code<\/div>/g)).toHaveLength(2);
    expect(h).not.toContain("Claude Code (haiku)");
    expect(h.match(/<span class="tag">[^<]*<\/span>/g)).toEqual(['<span class="tag">haiku</span>']);
    expect(ctx.registry).toBe(r);
  });

  it("osen look: rows in one frame, call count mono, one primary button", () => {
    const r = reg();
    const { ctx, form } = make(r, tpl);
    const h = html(apply(ctx, form, { type: "rounds", value: 6 }), r, tpl);
    expect(h.match(/class="setup__list"/g)).toHaveLength(1);
    expect(h.match(/class="participant setup-p"/g)).toHaveLength(form.participants.length);
    expect(h).toMatch(/не более <span class="setup__cost">36<\/span> вызовов/);
    expect(h.match(/<button[^>]*btn--primary[^>]*>/g)).toHaveLength(1);
    expect(h.match(/<button[^>]*setup__save[^>]*>/)![0]).toContain("btn--ghost");
    // «Add participant» — at the bottom of the list frame, as a quiet button
    expect(h.indexOf('class="setup__add"')).toBeLessThan(h.lastIndexOf("</div>", h.indexOf("setup-drafts")));
    expect(h.match(/<div class="setup__add"><button[^>]*class="btn btn--ghost"/)).not.toBeNull();
  });

  it("estimate: subscription, 36 calls", () => {
    const r = reg();
    const { ctx, form } = make(r, tpl);
    const h = html(apply(ctx, form, { type: "rounds", value: 6 }), r, tpl);
    expect(plainCost(h)).toContain("не более 36 вызовов");
    expect(h.match(/расходует подписку<\/span>/g)).toHaveLength(2);
    expect(h).toContain("Claude Code и Codex расходуют подписку");
  });

  it("estimate: a paid participant is marked", () => {
    const r = reg();
    const { form } = make(r, tpl, [{ providerId: "claude", model: "default" }, { providerId: "router", model: "m1" }]);
    expect(html(form, r, tpl)).toContain(" оплачивается</span>");
  });

  it("estimate: all scripted — free, no spending chips", () => {
    const r = reg();
    const { form } = make(r, null, [{ providerId: "scripted", model: "scripted" }, { providerId: "scripted", model: "scripted" }]);
    const h = html(form, r, null);
    expect(h).toContain("Сессия бесплатна");
    expect(h).not.toContain("расходует подписку</span>");
    expect(h).not.toContain("оплачивается</span>");
  });

  it("maximum participants: adding is blocked", () => {
    const r = reg({ defaults: defaults([{ providerId: "claude", model: "default" }, { providerId: "codex", model: "default" }], 2) });
    const { form } = make(r, tpl);
    const h = html(form, r, tpl);
    expect(h).toMatch(/<button[^>]*disabled[^>]*>[^]*?Добавить участника/);
    expect(h).toContain("достигнут максимум: 2");
    expect(html(make(reg(), tpl).form, reg(), tpl)).toContain("не больше 8");
  });

  it("stepper: bounds", () => {
    const r = reg();
    const { ctx, form } = make(r, tpl);
    const low = html(apply(ctx, form, { type: "rounds", value: 1 }), r, tpl);
    expect(low).toMatch(/aria-label="Меньше" disabled=""/);
    expect(low).not.toMatch(/aria-label="Больше" disabled/);
    expect(low).toContain("от 1 до 20");
    const high = html(apply(ctx, form, { type: "rounds", value: 20 }), r, tpl);
    expect(high).toMatch(/aria-label="Больше" disabled=""/);
    expect(high).not.toMatch(/aria-label="Меньше" disabled/);
  });

  it("starting: button disabled, «Starting…»", () => {
    const r = reg();
    const h = html(make(r, tpl).form, r, tpl, { starting: true });
    expect(startBtn(h)).toContain("disabled");
    expect(h).toContain("Запускаю…");
    expect(html(make(r, tpl).form, r, tpl)).not.toContain("Запускаю…");
  });

  it("error: alert with the reason, fields in place", () => {
    const r = reg();
    const h = html(make(r, tpl).form, r, tpl, { error: "Диск полон" });
    expect(h).toContain('data-tone="danger" role="alert"');
    expect(h).toContain("Не удалось начать обсуждение");
    expect(h).toContain("Диск полон");
    expect(h).toContain("Пример темы");
    expect(h).toContain('aria-label="Провайдер"');
  });

  it("order: «Up» disabled for the first, «Down» for the last", () => {
    const r = reg();
    const h = html(make(r, tpl).form, r, tpl);
    const ups = h.match(/<button[^>]*aria-label="Выше"[^>]*>/g)!;
    const downs = h.match(/<button[^>]*aria-label="Ниже"[^>]*>/g)!;
    expect(ups[0]).toContain("disabled");
    expect(ups[1]).not.toContain("disabled");
    expect(downs[0]).not.toContain("disabled");
    expect(downs[1]).toContain("disabled");
  });

  it("default model is shown in words", () => {
    const r = reg();
    expect(html(make(r, tpl).form, r, tpl)).toContain(">по умолчанию</option>");
  });
});

describe("SessionSetup: materials", () => {
  const view = (o: Partial<MaterialsView> = {}): MaterialsView => ({ items: [], skipped: [], left: [], folder: null, ignored: [], error: null, chars: 0, limit: 60000, over: 0, stamp: "s", ...o });
  const three = view({
    items: [{ id: "m1", name: "topic.txt", chars: 420, source: null }, { id: "m2", name: "folder/a.txt", chars: 1240, source: null }, { id: "m3", name: "folder/sub/b.txt", chars: 16760, source: null }],
    chars: 18420,
  });
  const ready = () => { const r = reg(); const { ctx, form } = make(r, null); return { r, form: apply(ctx, form, { type: "topic", value: "Тема" }) }; };
  const render = (materials: MaterialsView | null, o: { materialsBusy?: boolean; dragOver?: boolean; error?: string | null } = {}) => {
    const { r, form } = ready();
    return renderToStaticMarkup(<SessionSetup form={form} registry={r} template={null} starting={false} error={o.error ?? null} lineups={noLineups} dispatch={() => {}} onStart={() => {}} onBack={() => {}} onSaveAs={() => {}} saveAsBusy={false} saveAsError={null} materials={materials} materialsBusy={o.materialsBusy} dragOver={o.dragOver} />);
  };

  it("empty draft", () => {
    const h = render(view());
    expect(h).toContain("Приложить файлы");
    expect(h).toContain("Приложить папку");
    expect(h).toContain("или перетащите файлы и папки сюда");
    expect(h).toContain("0 материалов · 0 из 60000 знаков");
    expect(h).not.toContain("setup-materials__list");
    expect(h).not.toContain("Пропущено");
    expect(startBtn(h)).not.toContain("disabled");
    expect(h).not.toContain("data-drop");
  });
  it("three materials", () => {
    const h = render(three);
    for (const t of ["topic.txt", "folder/a.txt", "folder/sub/b.txt", "420 знаков", "1240 знаков", "16760 знаков", "3 материала · 18420 из 60000 знаков"]) expect(h).toContain(t);
    expect(h).toContain('aria-label="Убрать материал folder/a.txt"');
    expect(h).toContain("Материалы: 18420 знаков уходят в каждый вызов");
  });
  it("omissions", () => {
    const h = render(view({ skipped: [{ name: "folder/.cache", reason: "скрытое имя" }, { name: "folder/binary.bin", reason: "двоичный файл неизвестного формата" }, { name: "folder/node_modules", reason: "в списке игнорирования" }] }));
    expect(h).toContain('<details class="disclosure"><summary>Пропущено: 3</summary>');
    for (const t of ["folder/.cache", "скрытое имя", "двоичный файл неизвестного формата", "в списке игнорирования"]) expect(h).toContain(t);
  });
  it("not included: names, reasons and hint", () => {
    const m = view({ left: [{ name: "proj/src/a.ts", reason: "не описание — из папки больше лимита берутся только описания" }, { name: "proj/docs/big.md", reason: "не поместился в лимит — 90000 знаков" }] });
    const h = render(m);
    expect(h).toContain("Не вошло: 2");
    for (const t of ["proj/src/a.ts", "proj/docs/big.md", "берутся только описания", "не поместился в лимит — 90000 знаков", materialsLeftHint(m)]) expect(h).toContain(t);
    expect(materialsLeftHint(m)).toContain("60000");
  });
  it("folder line: present with folder, absent with null", () => {
    const f = { files: 562, chars: 4861571 };
    expect(render(view({ folder: f }))).toContain(materialsFolderLine(f));
    expect(render(view({ folder: null }))).not.toContain("Папка:");
  });
  it("without left there is no «Not included» line", () => {
    expect(render(view())).not.toContain("Не вошло");
  });
  it("name from left is escaped", () => {
    const h = render(view({ left: [{ name: "<script>q</script>", reason: "r" }] }));
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;q");
  });
  it("error of two lines, list in place", () => {
    const h = render({ ...three, error: "первая причина\nвторая причина" });
    expect(h).toContain('<span class="setup-material__name mono">topic.txt</span>');
    expect(h.match(/<div class="setup__error" data-tone="danger">/g)).toHaveLength(2);
    expect(h).toContain("первая причина");
    expect(h).toContain("вторая причина");
  });
  it("exceeding blocks «Start», no line under the limit", () => {
    const over = render({ ...three, chars: 72000, over: 12000 });
    expect(over).toContain("Материалы: 72000 знаков при лимите 60000 — превышение 12000. Уберите часть материалов.");
    expect(startBtn(over)).toContain("disabled");
    const ok = render(three);
    expect(ok).not.toContain("превышение");
    expect(startBtn(ok)).not.toContain("disabled");
  });
  it("spending estimate: a line about materials; without them the card is as before", () => {
    expect(render(three)).toContain('<span class="muted">Материалы: 18420 знаков уходят в каждый вызов</span>');
    const { r, form } = ready();
    const plain = renderToStaticMarkup(<SessionSetup form={form} registry={r} template={null} starting={false} error={null} lineups={noLineups} dispatch={() => {}} onStart={() => {}} onBack={() => {}} onSaveAs={() => {}} saveAsBusy={false} saveAsError={null} />);
    const side = (h: string) => h.slice(h.indexOf("setup__side"));
    expect(side(render(view()))).toBe(side(plain));
    expect(plain).not.toContain("уходят в каждый вызов");
  });
  it("busy: label and disabled buttons", () => {
    const h = render(three, { materialsBusy: true });
    expect(h).toContain("Читаю материалы…");
    expect(h).toMatch(/<button[^>]*disabled[^>]*><svg[^>]*><use href="#i-plus"><\/use><\/svg> Приложить файлы/);
    expect(h).toMatch(/<button[^>]*aria-label="Убрать материал topic.txt"[^>]*disabled/);
    expect(render(three)).not.toContain("Читаю материалы…");
  });
  it("drag: data-drop=over", () => {
    expect(render(three, { dragOver: true })).toContain('class="stack setup-materials" data-drop="over"');
  });
  it("view not received: heading and disabled buttons without a summary", () => {
    const h = render(null);
    expect(h).toContain("Материалы</h2>");
    expect(h).not.toContain("setup-materials__total");
    expect(h).not.toContain("setup-materials__list");
    expect(h.match(/<button[^>]*disabled[^>]*><svg[^>]*><use href="#i-plus"/g)).toHaveLength(2);
  });
  it("escaping and no paths", () => {
    const h = render(view({ items: [{ id: "m1", name: "<script>x</script>.txt", chars: 5, source: null }], chars: 5, skipped: [{ name: "a", reason: "<script>y</script>" }], error: "<script>z</script>" }));
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;x&lt;/script&gt;.txt");
    expect(h).toContain("&lt;script&gt;y");
    expect(h).toContain("&lt;script&gt;z");
    expect(h).not.toMatch(/"\/(Users|home|private)\//);
  });
  it("launch error and the list are visible at the same time", () => {
    const h = render(three, { error: "Сбой запуска" });
    expect(h).toContain("Не удалось начать обсуждение");
    expect(h).toContain("Сбой запуска");
    expect(h).toContain("folder/a.txt");
  });
});

describe("SessionSetup: materials preview", () => {
  const view = (stamp = "s1"): MaterialsView => ({ items: [{ id: "m1", name: "topic.txt", chars: 420, source: null }], skipped: [], left: [], folder: null, ignored: [], error: null, chars: 420, limit: 60000, over: 0, stamp });
  const pv = (o: Partial<MaterialsPreviewView> = {}): MaterialsPreviewView => ({
    sources: [], handle: "h1", stamp: "s1", createdAt: "2026-10-09T11:05:00.000Z", initial: "Первый материал", manifest: null, folder: null,
    available: [], skipped: [], left: [], materials: view(), ...o
  });
  const render = (materials: MaterialsView | null, o: Partial<{ preview: MaterialsPreviewView | null; previewOpen: boolean; previewError: string | null; accepted: { handle: string; stamp: string; createdAt: string } | null }> = {}) => {
    const r = reg();
    const { ctx, form } = make(r, null);
    return renderToStaticMarkup(<SessionSetup form={apply(ctx, form, { type: "topic", value: "Тема" })} registry={r} template={null} starting={false} error={null} lineups={noLineups} dispatch={() => {}} onStart={() => {}} onBack={() => {}} onSaveAs={() => {}} saveAsBusy={false} saveAsError={null} materials={materials} {...o} />);
  };
  const button = (h: string) => h.match(/<button[^>]*>Предпросмотр материалов<\/button>/)![0];

  it("button: unavailable without materials, available with them", () => {
    expect(button(render(null))).toContain("disabled");
    expect(button(render({ ...view(), items: [], chars: 0 }))).toContain("disabled");
    expect(button(render(view()))).not.toContain("disabled");
  });
  it("panel: sections, chips, reasons and omissions", () => {
    const h = render(view(), {
      previewOpen: true,
      preview: pv({
        manifest: "proj/a.ts",
        available: [{ name: "proj/a.ts", chars: 10, initial: false, reason: "не описание" }, { name: "proj/README.md", chars: 5, initial: true, reason: null }],
        skipped: [{ name: ".env", reason: "файл окружения — защита секретов" }],
      }),
    });
    expect(h).toContain("Начальный контекст — уходит в каждый запрос");
    expect(h).toContain("Файлы папки: 2 · доступны по запросу: 1");
    expect(h).toContain("доступен по запросу</span>");
    expect(h).toContain("в начальном контексте</span>");
    expect(h).toContain("не описание");
    expect(h).toContain(".env");
    expect(h).toContain("файл окружения — защита секретов");
    expect(h).toContain("Оглавление папки");
  });
  it("the set text is escaped", () => {
    const h = render(view(), { previewOpen: true, preview: pv({ initial: "<script>alert(1)</script> & x" }) });
    expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; x");
    expect(h).not.toContain("<script>");
  });
  it("panel closed: there is an action row, no panel", () => {
    const h = render(view(), { previewOpen: false, preview: pv() });
    expect(h).toContain("setup-materials__preview");
    expect(h).not.toContain("setup-preview\"");
  });
  it("the accepted current set", () => {
    const h = render(view(), { previewOpen: true, preview: pv(), accepted: { handle: "h1", stamp: "s1", createdAt: "2026-10-09T11:05:00.000Z" } });
    expect(h).toContain("Набор принят в");
    const accept = h.match(/<button[^>]*btn--primary[^>]*>Набор принят<\/button>/)![0];
    expect(accept).toContain("disabled");
  });
  it("the outdated accepted set", () => {
    const h = render(view("s2"), { accepted: { handle: "h1", stamp: "s1", createdAt: "2026-10-09T11:05:00.000Z" } });
    expect(h).toContain("Предпросмотр устарел");
    expect(h).toContain(">Обновить</button>");
  });
  it("refresh refusal: reason and the previous text next to it", () => {
    const h = render(view(), { previewOpen: true, preview: pv({ initial: "Прежний текст набора" }), previewError: "Источник не прочитан" });
    expect(h).toContain("Источник не прочитан");
    expect(h).toContain("Прежний текст набора");
  });
  it("set not current: warning, cannot accept", () => {
    const h = render(view("s2"), { previewOpen: true, preview: pv() });
    expect(h).toContain("Показан прежний набор: состав или лимит материалов изменились");
    expect(h.match(/<button[^>]*btn--primary[^>]*>Принять набор<\/button>/)![0]).toContain("disabled");
  });
});

describe("SessionSetup: rerun", () => {
  const rv = (o: Partial<import("../../shared/setup.ts").RerunView> = {}): import("../../shared/setup.ts").RerunView => ({
    sessionId: "s1", date: "2026-10-07", topic: "Прошлая тема", templateId: null, framingFromSession: true,
    participants: [{ providerId: "claude", model: "default", role: "Критик" }, { providerId: "codex", model: "default", role: null }],
    maxRounds: 3, ownerWait: null, materials: { items: [], skipped: [], left: [], folder: null, ignored: [], error: null, chars: 0, limit: 60000, over: 0, stamp: "s" }, ...o,
  });
  const page = (v: import("../../shared/setup.ts").RerunView, registry = reg()) =>
    renderToStaticMarkup(<SessionSetup form={formFromRerun(v, registry)} registry={registry} template={null} starting={false} error={null} lineups={noLineups} dispatch={() => {}} onStart={() => {}} onBack={() => {}} onSaveAs={() => {}} saveAsBusy={false} saveAsError={null}
      materials={v.materials} rerun={{ framingFromSession: v.framingFromSession, date: v.date }} />);
  it("both labels with framingFromSession", () => {
    const h = page(rv());
    expect(h).toContain("повтор сессии от 2026-10-07");
    expect(h).toContain("рамка из прошлой сессии");
    expect(h).toContain("тема, состав и роли взяты из прошлой сессии");
    expect(h).toContain("Прошлая тема");
  });
  it("without framingFromSession only the rerun label", () => {
    const h = page(rv({ framingFromSession: false }));
    expect(h).toContain("повтор сессии от 2026-10-07");
    expect(h).not.toContain("рамка из прошлой сессии");
  });
  it("without rerun there are no labels, the source line is as before", () => {
    const r = reg();
    const { form } = make(r, null);
    const h = html(form, r, null);
    expect(h).not.toContain("повтор сессии");
    expect(h).toContain('<div class="setup__origin"><span class="chip">Своя тема</span><span class="muted">нейтральная рамка, роли не заданы</span></div>');
  });
  it("rerun materials: list and two error lines", () => {
    const h = page(rv({ materials: { items: [{ id: "m1", name: "a.md", chars: 10, source: null }], skipped: [], left: [], folder: null, ignored: [], error: "a: нет файла\nb: нет доступа", chars: 10, limit: 60000, over: 0, stamp: "s" } }));
    expect(h).toContain("a.md");
    expect(h).toContain("a: нет файла");
    expect(h).toContain("b: нет доступа");
  });
  it("unknown provider: error in the card and «Start» unavailable", () => {
    const h = page(rv({ participants: [{ providerId: "claude", model: "default", role: null }, { providerId: "gone", model: "x", role: null }] }));
    expect(h).toContain("Провайдер не найден в реестре");
    expect(startBtn(h)).toContain("disabled");
  });
  it("material limit exceeded", () => {
    const h = page(rv({ materials: { items: [{ id: "m1", name: "a.md", chars: 70000, source: null }], skipped: [], left: [], folder: null, ignored: [], error: null, chars: 70000, limit: 60000, over: 10000, stamp: "s" } }));
    expect(h).toContain("превышение 10000");
    expect(startBtn(h)).toContain("disabled");
  });
});

describe("SessionSetup: token ceiling", () => {
  const capReg = () => reg({ defaults: { ...defaults([{ providerId: "claude", model: "default" }, { providerId: "codex", model: "default" }]), maxTotalTokens: 50000 } });
  const page = (r: RegistryView, ...actions: SetupAction[]) => {
    const { ctx, form } = make(r, null);
    return html(apply(ctx, apply(ctx, form, { type: "topic", value: "Тема" }), ...actions), r, null);
  };
  it("the field stands after the rounds limit and before the estimate, with a label and hint", () => {
    const h = page(reg());
    const at = (t: string) => h.indexOf(t);
    expect(at("Лимит кругов")).toBeGreaterThan(-1);
    expect(at("Лимит кругов")).toBeLessThan(at("Потолок токенов на сессию"));
    expect(at("Потолок токенов на сессию")).toBeLessThan(at("Оценка расхода"));
    expect(h).toContain("Сумма входных и выходных токенов всех вызовов моделей, включая неудачные попытки; пусто — без потолка");
    expect(h).toContain('placeholder="без потолка" value=""');
  });
  it("the hint names all model calls and failed attempts, not «all turns» (en, ru)", () => {
    const cases = [["en", ["all model calls", "failed attempts", "empty — no cap"], "all turns"], ["ru", ["всех вызовов моделей", "неудачные попытки", "пусто — без потолка"], "всех ходов"]] as const;
    try {
      for (const [lang, has, not] of cases) {
        setProcessLanguage(lang);
        const h = page(reg());
        for (const x of has) expect(h).toContain(x);
        expect(h).not.toContain(not);
      }
    } finally { setProcessLanguage("ru"); }
  });
  it("default value 50000 in the field and in the estimate next to the number of calls", () => {
    const h = page(capReg());
    expect(h).toContain('value="50000"');
    expect(h).toContain("потолок 50000 токенов");
    expect(plainCost(h)).toMatch(/не более \d+ вызов[^<]*<\/span>.*потолок 50000 токенов/);
  });
  it("empty field — «no ceiling»", () => {
    expect(page(capReg(), { type: "cap", value: "" })).toContain("потолка нет");
  });
  it("«many»: error, Start disabled, hint, no line in the estimate", () => {
    const h = page(capReg(), { type: "cap", value: "много" });
    expect(h).toContain("Нужно целое число от 1");
    expect(startBtn(h)).toContain("disabled");
    expect(h).toContain("Исправьте потолок токенов");
    expect(h).not.toContain("потолок 50000");
    expect(h).not.toContain("потолка нет");
  });
});

describe("SessionSetup: save as template", () => {
  const saveBtn = (h: string) => h.match(/<button[^>]*setup__save[^>]*>/)![0];
  it("button present with a template, a custom topic and an incomplete setup", () => {
    const r = reg();
    expect(html(make(r, tpl).form, r, tpl)).toContain("Сохранить как шаблон");
    expect(html(make(r, null).form, r, null)).toContain("Сохранить как шаблон");
    const one = reg({ defaults: defaults([{ providerId: "claude", model: "default" }]) });
    const h = html(make(one, tpl).form, one, tpl);
    expect(startBtn(h)).toContain("disabled");
    expect(saveBtn(h)).not.toContain("disabled");
  });
  it("starting and saveAsBusy block the button", () => {
    const r = reg();
    const { form } = make(r, tpl);
    expect(saveBtn(html(form, r, tpl))).not.toContain("disabled");
    expect(saveBtn(html(form, r, tpl, { starting: true }))).toContain("disabled");
    expect(saveBtn(html(form, r, tpl, { saveAsBusy: true }))).toContain("disabled");
  });
  it("refusal reason shown, without an error no line", () => {
    const r = reg();
    const { form } = make(r, tpl);
    expect(html(form, r, tpl, { saveAsError: "нет связи" })).toContain("Не удалось открыть редактор шаблона: нет связи");
    expect(html(form, r, tpl)).not.toContain("Не удалось открыть редактор шаблона");
  });
});

describe("SessionSetup: owner wait", () => {
  const page = (...actions: SetupAction[]) => {
    const r = reg();
    const { ctx, form } = make(r, tpl);
    return html(apply(ctx, form, ...actions), r, tpl);
  };
  it("by default two checkboxes are off, no deadline and no hint", () => {
    const h = page();
    const boxes = h.match(/<input[^>]*type="checkbox"[^>]*>/g)!;
    expect(boxes).toHaveLength(3); // two wait checkboxes and the independent drafts checkbox
    for (const box of boxes) expect(box).not.toContain("checked");
    expect(h).not.toContain("Время ожидания, сек");
    expect(h).not.toContain("Когда время выйдет");
    expect(h.indexOf("Ожидание владельца")).toBeGreaterThan(h.indexOf("Потолок токенов на сессию"));
    expect(h.indexOf("Ожидание владельца")).toBeLessThan(h.indexOf("Оценка расхода"));
  });
  it.each(["pause-after-round", "wait-for-owner"] as const)("mode %s shows the deadline from the form and the hint", (type) => {
    const h = page({ type, value: true }, { type: "wait-sec", value: "60" });
    expect(h).toContain("Время ожидания, сек");
    expect(h).toContain('inputMode="numeric" value="60"');
    expect(h).toContain("Когда время выйдет, обсуждение продолжится само; вопросы без ответа останутся без ответа.");
    expect(startBtn(h)).not.toContain("disabled");
  });
  it("an invalid deadline shows an error and blocks «Start»", () => {
    const h = page({ type: "wait-for-owner", value: true }, { type: "wait-sec", value: "0" });
    expect(h).toContain("Нужно целое число от 1 до 86400");
    expect(h).toContain("Исправьте время ожидания");
    expect(startBtn(h)).toContain("disabled");
  });
  it("checkboxes and the deadline field send the corresponding actions", () => {
    const r = reg();
    const { form } = make(r, tpl);
    const sent: SetupAction[] = [];
    const tree = direct({ form: { ...form, pauseAfterRound: true }, registry: r, template: tpl, starting: false, error: null, lineups: noLineups, dispatch: (a) => sent.push(a), onStart() {}, onBack() {}, onSaveAs() {}, saveAsBusy: false, saveAsError: null });
    const inputs: ReactElement<{ type?: string; value?: string; onChange(e: unknown): void; children?: ReactNode }>[] = [];
    const visit = (n: ReactNode): void => {
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (!n || typeof n !== "object" || !("props" in n)) return;
      const el = n as typeof inputs[number];
      if (el.type === "input") inputs.push(el);
      visit(el.props.children);
    };
    visit(tree);
    const boxes = inputs.filter((el) => el.props.type === "checkbox");
    expect(boxes).toHaveLength(3); // two wait checkboxes and the independent drafts checkbox
    boxes[1]!.props.onChange({ target: { checked: false } }); // boxes[0] — independent drafts
    boxes[2]!.props.onChange({ target: { checked: true } });
    inputs.find((el) => el.props.value === "300")!.props.onChange({ target: { value: "60" } });
    expect(sent).toEqual([{ type: "pause-after-round", value: false }, { type: "wait-for-owner", value: true }, { type: "wait-sec", value: "60" }]);
  });
});

describe("lineups", () => {
  const r = reg();
  const ok = (): SetupForm => make(r, tpl).form;
  const lv = (id: string, name: string, available = true): LineupView => ({ id, name, available, participants: [] });
  const list = [lv("id-1", "Ревью"), lv("id-2", "Старый", false)];
  const named = { list, name: "Ревью" };
  const saveBtn = (h: string) => h.match(/<button[^>]*setup-lineups__save[^>]*>/)![0];
  it("row in place, lineup items", () => {
    const h = html(ok(), r, tpl, { lineups: { list } });
    for (const t of ["setup-lineups", ">Состав<", "Название состава", "Сохранить состав", "Выбрать состав…", ">Ревью</option>", ">Старый — есть недоступные</option>", "Сохранить как шаблон"]) expect(h).toContain(t);
    expect(h).toContain('placeholder="Например, Ревью"');
    expect(h).toContain("i-users");
    expect(h.indexOf("setup-lineups")).toBeGreaterThan(h.indexOf("Участники"));
    expect(h.indexOf("setup-lineups")).toBeLessThan(h.indexOf("setup__list"));
  });
  it("save button: empty and blank name, non-empty, busy", () => {
    expect(saveBtn(html(ok(), r, tpl))).toContain("disabled");
    expect(saveBtn(html(ok(), r, tpl, { lineups: { name: "   " } }))).toContain("disabled");
    expect(saveBtn(html(ok(), r, tpl, { lineups: { name: "Ревью" } }))).not.toContain("disabled");
    expect(saveBtn(html(ok(), r, tpl, { lineups: { name: "Ревью", busy: true } }))).toContain("disabled");
  });
  it("busy: the lineup list is not disabled — keyboard focus stays on it", () => {
    const pick = html(ok(), r, tpl, { lineups: { list, busy: true } }).match(/setup-lineups__pick.*?<select[^>]*>/)![0];
    expect(pick).not.toContain("disabled");
  });
  it("error: line, list and button disabled, form in place", () => {
    const h = html(ok(), r, tpl, { lineups: { error: "lineups.json: не JSON", name: "x" } });
    expect(h).toContain('role="alert"');
    expect(h).toMatch(/data-tone="danger" role="alert"><svg[^>]*><use href="#i-alert"><\/use><\/svg> Составы не прочитаны: lineups\.json: не JSON/);
    expect(h).toMatch(/<select[^>]*disabled=""[^>]*><option value=""[^>]*>Выбрать состав/);
    expect(saveBtn(h)).toContain("disabled");
    expect(startBtn(h)).toBeDefined();
  });
  it("saveError: line, aria on the field", () => {
    const h = html(ok(), r, tpl, { lineups: { saveError: "Название «Ревью» уже занято", name: "Ревью" } });
    expect(h).toMatch(/id="([^"]+)" class="setup__error" data-tone="danger" role="alert"><svg[^>]*><use href="#i-alert"><\/use><\/svg> Название «Ревью» уже занято/);
    const id = h.match(/id="([^"]+)" class="setup__error"/)![1];
    expect(h).toContain('aria-invalid="true"');
    expect(h).toContain(`aria-describedby="${id}"`);
    expect(html(ok(), r, tpl)).not.toContain("aria-invalid");
  });
  it("pickError", () => {
    expect(html(ok(), r, tpl, { lineups: { pickError: "Состав не найден" } })).toMatch(/class="setup__error" data-tone="danger" role="alert"><svg[^>]*><use href="#i-alert"><\/use><\/svg> Состав не найден/);
  });
  it("notice: ok and muted", () => {
    expect(html(ok(), r, tpl, { lineups: { notice: { tone: "ok", text: "Сохранён" } } })).toMatch(/setup-lineups__note" data-tone="ok" role="status"><svg[^>]*><use href="#i-check"><\/use><\/svg> Сохранён/);
    const m = html(ok(), r, tpl, { lineups: { notice: { tone: "muted", text: "Применён" } } });
    expect(m).toContain('<div class="setup-lineups__note" data-tone="muted">Применён</div>');
    expect(m).not.toContain("i-check");
  });
  it("issue blocks «Start», note does not", () => {
    const f = ok();
    const withIssue = { ...f, participants: f.participants.map((p, i) => (i === 1 ? { ...p, issue: "Сценарий «x.json» недоступен." } : p)) };
    const h = html(withIssue, r, tpl);
    expect(h).toContain('<div class="setup__error" data-tone="danger"><svg class="icon icon--sm"><use href="#i-alert"></use></svg> Сценарий «x.json» недоступен.</div>');
    expect(startBtn(h)).toContain("disabled");
    expect(h).toContain("частник 2: Сценарий «x.json» недоступен.");
    const withNote = { ...f, participants: f.participants.map((p, i) => (i === 1 ? { ...p, note: "Модели нет в перечне" } : p)) };
    const n = html(withNote, r, tpl);
    expect(n).toContain('data-tone="warn"><svg class="icon icon--sm"><use href="#i-alert"></use></svg> Модели нет в перечне</div>');
    expect(startBtn(n)).not.toContain("disabled");
  });
  it("handlers: list, name, button, Enter; launch is not called", () => {
    const calls: string[] = [];
    const lineups: LineupsProps = { ...noLineups, ...named, onPick: (id) => calls.push(`pick:${id}`), onName: (t) => calls.push(`name:${t}`), onSave: () => calls.push("save") };
    const run = (l: LineupsProps) => {
      const tree = direct({ form: ok(), registry: r, template: tpl, starting: false, error: null, lineups: l, dispatch() {}, onStart: () => calls.push("start"), onBack() {}, onSaveAs() {}, saveAsBusy: false, saveAsError: null });
      const found: ReactElement<Record<string, any>>[] = [];
      const visit = (n: ReactNode): void => {
        if (Array.isArray(n)) { n.forEach(visit); return; }
        if (!n || typeof n !== "object" || !("props" in n)) return;
        const el = n as ReactElement<Record<string, any>>;
        found.push(el);
        visit(el.props.children);
      };
      visit(tree);
      const cls = (c: string) => found.find((el) => String(el.props.className ?? "").split(" ").includes(c))!;
      return { select: found.find((el) => el.type === "select" && el.props.value === "" && el.props.disabled !== undefined && !el.props["aria-label"])!, input: found.find((el) => el.type === "input" && el.props.placeholder === "Например, Ревью")!, save: cls("setup-lineups__save") };
    };
    const a = run(lineups);
    a.select.props.onChange({ target: { value: "id-1" } });
    a.select.props.onChange({ target: { value: "" } });
    a.input.props.onChange({ target: { value: "Н" } });
    a.save.props.onClick();
    let prevented = 0;
    const key = (extra = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, nativeEvent: {}, preventDefault: () => { prevented++; }, ...extra });
    a.input.props.onKeyDown(key());
    a.input.props.onKeyDown(key({ key: "a" }));
    a.input.props.onKeyDown(key({ nativeEvent: { isComposing: true } }));
    expect(calls).toEqual(["pick:id-1", "name:Н", "save", "save"]);
    expect(prevented).toBe(1);
    const b = run({ ...lineups, name: "  " });
    b.input.props.onKeyDown(key());
    expect(calls).toEqual(["pick:id-1", "name:Н", "save", "save"]);
    expect(prevented).toBe(1);
  });
});

describe("SessionSetup: independent drafts", () => {
  const three = () => {
    const r = reg();
    const { ctx, form } = make(r, null);
    return { r, ctx, form: apply(ctx, form, { type: "add" }, { type: "rounds", value: 2 }) };
  };
  it("by default the checkbox is cleared, no «Synthesizer» list, the experiment mark is visible", () => {
    const { r, form } = three();
    const h = html(form, r, null);
    const box = h.match(/<input[^>]*id="setup-drafts"[^>]*>|<input[^>]*type="checkbox"[^>]*aria-describedby="setup-drafts-flag[^>]*>/)![0];
    expect(box).not.toContain("checked");
    expect(box).toContain('aria-describedby="setup-drafts-flag setup-drafts-hint"');
    expect(h).toContain("Независимые черновики");
    expect(h).toContain("Эксперимент: польза не подтверждена");
    expect(h).toContain("не видя чужих");
    expect(h).not.toContain("Синтезатор");
    expect(plainCost(h)).toContain("не более 18 вызовов");
    expect(h).not.toContain("фаза добавляет");
  });
  it("when enabled: a list with the first participant, 27 calls, a line about the synthesizer", () => {
    const { r, ctx, form } = three();
    const h = html(apply(ctx, form, { type: "drafts", value: true }), r, null);
    expect(h).toContain("Синтезатор");
    expect(h).toMatch(/<option value="0" selected="">1 · Claude Code/);
    expect(plainCost(h)).toContain("не более 27 вызовов");
    expect(h).toContain("Независимые черновики: синтезатор — 1 · Claude Code; фаза добавляет до 9 вызовов");
  });
});

describe("SessionSetup: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const cyr = /[А-Яа-яЁё]/;
  const lat = prov({ id: "claude", label: "Claude Code" });
  const down = prov({ id: "down", label: "Broken", available: false, reason: "binary not found" });
  const r = reg({ providers: [lat, codex, router, down] });
  const etpl: TemplateCard = { ...tpl, title: "Pricing", category: "Strategy", exampleTopic: "Example topic", roles: ["Advocate", "Skeptic"] };
  const mat = (o: Partial<MaterialsView> = {}): MaterialsView => ({ items: [{ id: "m1", name: "a.md", chars: 70000, source: null }], skipped: [{ name: "x.bin", reason: "binary file" }], left: [{ name: "y.ts", reason: "too large" }], folder: { files: 3, chars: 900 }, ignored: [], error: null, chars: 70000, limit: 60000, over: 10000, stamp: "s", ...o });
  const pvw = (): MaterialsPreviewView => ({ sources: [], handle: "h1", stamp: "s", createdAt: "2026-10-09T11:05:00.000Z", initial: "text", manifest: "proj/a.ts", folder: null, available: [{ name: "proj/a.ts", chars: 10, initial: false, reason: "reason" }, { name: "proj/b.md", chars: 1, initial: true, reason: null }], skipped: [{ name: ".env", reason: "secrets" }], left: [{ name: "z", reason: "limit" }], materials: mat() });
  const render = (form: SetupForm, o: Partial<Parameters<typeof SessionSetup>[0]> = {}) =>
    renderToStaticMarkup(<SessionSetup form={form} registry={r} template={etpl} starting={false} error={null} lineups={noLineups} dispatch={() => {}} onStart={() => {}} onBack={() => {}} onSaveAs={() => {}} saveAsBusy={false} saveAsError={null} {...o} />);
  const three = () => { const { ctx, form } = make(r, etpl); return { ctx, form: apply(ctx, form, { type: "add" }, { type: "topic", value: "Topic" }) }; };

  it("en: labels of all blocks in English, no Cyrillic", () => {
    setProcessLanguage("en");
    const { ctx, form } = three();
    const full = apply(ctx, form, { type: "provider", key: form.participants[2]!.key, providerId: "router" }, { type: "drafts", value: true }, { type: "pause-after-round", value: true }, { type: "wait-for-owner", value: true });
    const h = render(full, { materials: mat(), preview: pvw(), previewOpen: true, accepted: { handle: "h1", stamp: "s", createdAt: "2026-10-09T11:05:00.000Z" }, rerun: { framingFromSession: true, date: "2026-10-07" } });
    for (const t of ["Session setup", "Back to templates", "Discussion topic", "Materials", "Attach files", "Attach a folder", "Release to attach", "Materials preview", "Set accepted", "Initial context — goes into every request", "Skipped: 1", "Not included: 1", "Not sent: 1", "Folder files: 2 · available on request: 1", "Participants", "3 of 8", "Lineup", "Choose…", "Lineup name", "Save lineup", "Add participant", "Independent drafts", "Experiment: benefit not confirmed", "Synthesizer", "Round limit", "Token cap per session", "Waiting for the owner", "Pause after a round", "Wait for the owner’s reply", "Wait time, sec", "Cost estimate", "Save as template", "rerun of the session from 2026-10-07", "framing from the previous session", "uses subscription", "paid", "Start"]) expect(h, t).toContain(t);
    expect(h).toContain('aria-label="Remove material a.md"');
    expect(h).not.toMatch(cyr);
    const stale = render(full, { materials: mat({ stamp: "other" }), preview: pvw(), previewOpen: true, accepted: { handle: "h1", stamp: "s", createdAt: "2026-10-09T11:05:00.000Z" } });
    expect(stale).toContain("The preview is outdated: the set of materials or their limit has changed");
    expect(stale).not.toMatch(cyr);
    const open = render(full, { materials: mat(), preview: pvw(), previewOpen: true });
    expect(open).toContain("Accept set");
    expect(open).not.toMatch(cyr);
    expect(render(full, { starting: true })).toContain("Starting…");
    expect(render(full, { starting: true })).not.toMatch(cyr);
  });
  it("en: empty form and a lineup with an unavailable position", () => {
    setProcessLanguage("en");
    const { form } = make(r, null);
    const empty = render({ ...form, participants: [] }, { template: null });
    expect(empty).toContain("Custom topic");
    expect(empty).toContain("Topic is required");
    expect(empty).not.toMatch(cyr);
    const lineups = { ...noLineups, list: [{ id: "l1", name: "Review", available: false, participants: [] }], name: "Review", saveError: "save failed", notice: { tone: "ok" as const, text: "Saved" } };
    const h = render(form, { template: null, lineups });
    expect(h).toContain("Review — has unavailable positions");
    expect(h).not.toMatch(cyr);
  });
  it("empty form: hint and field errors in one language", () => {
    const { form } = make(r, null);
    const one = { ...form, participants: form.participants.slice(0, 1) };
    setProcessLanguage("en");
    const en = render(one, { template: null });
    expect(en).toContain("Topic is required");
    expect(en).toContain("At least two participants are required");
    expect(en).toContain("Fill in the topic");
    expect(en).toContain("add a second participant");
    expect(en).not.toMatch(cyr);
    setProcessLanguage("ru");
    const ru = render(one, { template: null });
    expect(ru).toContain("Тема обязательна");
    expect(ru).toContain("Нужно не меньше двух участников");
  });
  it("estimate with three participants: en and ru", () => {
    const { form } = three();
    setProcessLanguage("en");
    expect(plainCost(render(form))).toContain("at most 54 calls");
    setProcessLanguage("ru");
    expect(plainCost(render(form))).toContain("не более 54 вызовов");
  });
  it("owner and core data in en are shown verbatim, labels around are English", () => {
    setProcessLanguage("en");
    const { ctx, form } = three();
    const f = apply(ctx, form, { type: "topic", value: "Тема про цены" }, { type: "role", key: form.participants[0]!.key, role: "Критик" });
    const ctpl = { ...etpl, title: "Цена", category: "Продукт" };
    const lineups = { ...noLineups, list: [{ id: "l1", name: "Ревью", available: true, participants: [] }], name: "Ревью" };
    const h = render(f, { template: ctpl, lineups, materials: mat({ items: [{ id: "m1", name: "заметки.md", chars: 5, source: null }], skipped: [{ name: "a", reason: "скрытое имя" }], left: [{ name: "b", reason: "не описание" }], over: 0, chars: 5 }), error: "Ошибка main", saveAsError: "Нет файла" });
    for (const t of ["Тема про цены", 'value="Критик"', "Ревью", "Цена", "Продукт", "заметки.md", "скрытое имя", "не описание", "Ошибка main", "Нет файла"]) expect(h, t).toContain(t);
    for (const t of ["Discussion topic", "Skipped: 1", "Not included: 1", "Could not start the discussion", "Could not open the template editor: "]) expect(h, t).toContain(t);
    expect(h.replace(/Тема про цены|Критик|Ревью|Цена|Продукт|заметки\.md|скрытое имя|не описание|Ошибка main|Нет файла/g, "")).not.toMatch(cyr);
  });
  it("bounds of the rounds limit and the wait deadline are the same in en and ru", () => {
    const { ctx, form } = three();
    const f = apply(ctx, form, { type: "wait-for-owner", value: true });
    setProcessLanguage("en");
    const en = render(f);
    setProcessLanguage("ru");
    const ru = render(f);
    const bounds = (h: string) => [h.match(/<div class="stepper"[^>]*>/)![0], h.match(/setup-wait__sec.*?(<input[^>]*>)/)![1]];
    expect(bounds(en)).toEqual(bounds(ru));
    expect(bounds(en)[0]).toContain('data-min="1" data-max="20"');
    expect(en).toContain("from 1 to 20");
    expect(ru).toContain("от 1 до 20");
  });
});

describe("SessionSetup: excluded by rules", () => {
  const ign = (o: Partial<MaterialsView["ignored"][number]> = {}) => ({ id: "x1", name: "proj/out", rule: "out/", returned: false, ...o });
  const view = (o: Partial<MaterialsView> = {}): MaterialsView => ({ items: [], skipped: [], left: [], ignored: [], folder: null, error: null, chars: 0, limit: 60000, over: 0, stamp: "s1", ...o });
  const pv = (materials: MaterialsView): MaterialsPreviewView => ({ handle: "h1", stamp: "s1", createdAt: "2026-10-09T11:05:00.000Z", initial: "text", manifest: null, folder: null, available: [], skipped: [], left: [], sources: [], materials });
  const props = (o: Partial<Parameters<typeof SessionSetup>[0]> = {}): Parameters<typeof SessionSetup>[0] => {
    const r = reg();
    const { ctx, form } = make(r, null);
    return { form: apply(ctx, form, { type: "topic", value: "Тема" }), registry: r, template: null, starting: false, error: null, lineups: noLineups, dispatch() {}, onStart() {}, onBack() {}, onSaveAs() {}, saveAsBusy: false, saveAsError: null, ...o };
  };
  const html2 = (o: Partial<Parameters<typeof SessionSetup>[0]> = {}) => renderToStaticMarkup(<SessionSetup {...props(o)} />);
  const buttons = (o: Partial<Parameters<typeof SessionSetup>[0]>): ReactElement<Record<string, any>>[] => {
    const found: ReactElement<Record<string, any>>[] = [];
    const visit = (n: ReactNode): void => {
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (!n || typeof n !== "object" || !("props" in n)) return;
      const el = n as ReactElement<Record<string, any>>;
      if (el.type === "button") found.push(el);
      visit(el.props.children);
    };
    visit(direct(props(o)));
    return found;
  };
  afterEach(() => setProcessLanguage("ru"));

  it("section visible with a non-empty ignored list and hidden with an empty one", () => {
    const h = html2({ materials: view({ ignored: [ign()] }) });
    expect(h).toContain("<summary>Исключено правилами: 1</summary>");
    expect(h).toContain("proj/out");
    expect(h).toContain(">out/<");
    expect(h).toContain(">Вернуть</button>");
    expect(html2({ materials: view() })).not.toContain("Исключено правилами");
  });
  it("a returned line is included in N, the chip and «Exclude again» are shown", () => {
    const h = html2({ materials: view({ ignored: [ign(), ign({ id: "x2", name: "proj/dist", rule: "dist/", returned: true })] }) });
    expect(h).toContain("Исключено правилами: 2");
    expect(h).toContain(">возвращён</span>");
    expect(h).toContain(">Исключить снова</button>");
    expect(h.match(/>Вернуть<\/button>/g)).toHaveLength(1);
  });
  it("buttons call returnIgnored/excludeIgnored with the line id", () => {
    const calls: string[] = [];
    const materials = view({ ignored: [ign(), ign({ id: "x2", name: "b/out", returned: true })] });
    const bs = buttons({ materials, onReturnIgnored: (id) => calls.push(`return:${id}`), onExcludeIgnored: (id) => calls.push(`exclude:${id}`) });
    const ret = bs.find((b) => b.props["aria-label"] === "Вернуть proj/out")!;
    const exc = bs.find((b) => b.props["aria-label"] === "Исключить снова b/out")!;
    ret.props.onClick();
    exc.props.onClick();
    expect(calls).toEqual(["return:x1", "exclude:x2"]);
  });
  it("buttons disabled during materialsBusy", () => {
    const materials = view({ ignored: [ign(), ign({ id: "x2", name: "b/out", returned: true })] });
    const h = html2({ materials, materialsBusy: true });
    for (const label of ["Вернуть proj/out", "Исключить снова b/out"]) expect(h.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))![0]).toContain("disabled");
    const free = html2({ materials });
    expect(free.match(/<button[^>]*aria-label="Вернуть proj\/out"[^>]*>/)![0]).not.toContain("disabled");
  });
  it("preview: section and actions are the same; after return (new stamp) «Preview is outdated» is shown", () => {
    const old = view({ ignored: [ign()] });
    const preview = pv(old);
    expect(html2({ materials: old, preview, previewOpen: true }).match(/Исключено правилами: 1/g)).toHaveLength(2);
    const calls: string[] = [];
    const after = view({ stamp: "s2", ignored: [ign({ returned: true })] });
    const h = html2({ materials: after, preview, previewOpen: true, onExcludeIgnored: (id) => calls.push(id) });
    expect(h).toContain("Показан прежний набор");
    expect(h).toContain("возвращён");
    expect(h.match(/Исключить снова<\/button>/g)).toHaveLength(2);
    const preBtn = buttons({ materials: after, preview, previewOpen: true, onExcludeIgnored: (id) => calls.push(id) }).filter((b) => b.props["aria-label"] === "Исключить снова proj/out");
    expect(preBtn).toHaveLength(2);
    preBtn[1]!.props.onClick();
    expect(calls).toEqual(["x1"]);
    const acc = html2({ materials: after, accepted: { handle: "h1", stamp: "s1", createdAt: "2026-10-09T11:05:00.000Z" } });
    expect(acc).toContain("Предпросмотр устарел");
  });
  it("en: labels in English, no Cyrillic", () => {
    setProcessLanguage("en");
    const materials = view({ ignored: [ign(), ign({ id: "x2", name: "b/out", returned: true })] });
    const h = html2({ materials, preview: pv(materials), previewOpen: true });
    for (const t of ["Excluded by rules: 2", ">Return</button>", ">returned</span>", ">Exclude again</button>", 'aria-label="Return proj/out"', 'aria-label="Exclude again b/out"']) expect(h, t).toContain(t);
    const blocks = h.match(/<details[^>]*><summary>Excluded[\s\S]*?<\/details>/g)!;
    expect(blocks).toHaveLength(2);
    expect(blocks.join()).not.toMatch(/[А-Яа-яЁё]/);
  });
});

describe("SessionSetup: link", () => {
  const link = { label: "example.com/docs/pricing", fetchedAt: "2026-10-09T11:05:00.000Z" };
  const view = (o: Partial<MaterialsView> = {}): MaterialsView => ({ items: [{ id: "m1", name: "topic.txt", chars: 420, source: null }], skipped: [], left: [], ignored: [], folder: null, error: null, chars: 420, limit: 60000, over: 0, stamp: "s1", ...o });
  const withLink = (o: Partial<MaterialsView> = {}) => view({ items: [{ id: "m1", name: "topic.txt", chars: 420, source: null }, { id: "m2", name: "example.com/docs/pricing", chars: 3100, source: link }], chars: 3520, ...o });
  const props = (o: Partial<Parameters<typeof SessionSetup>[0]> = {}): Parameters<typeof SessionSetup>[0] => {
    const r = reg();
    const { ctx, form } = make(r, null);
    return { form: apply(ctx, form, { type: "topic", value: "Тема" }), registry: r, template: null, starting: false, error: null, lineups: noLineups, dispatch() {}, onStart() {}, onBack() {}, onSaveAs() {}, saveAsBusy: false, saveAsError: null, ...o };
  };
  const page = (o: Partial<Parameters<typeof SessionSetup>[0]> = {}) => renderToStaticMarkup(<SessionSetup {...props(o)} />);
  const find = (o: Partial<Parameters<typeof SessionSetup>[0]>, type: string): ReactElement<Record<string, any>>[] => {
    const found: ReactElement<Record<string, any>>[] = [];
    const visit = (n: ReactNode): void => {
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (!n || typeof n !== "object" || !("props" in n)) return;
      const el = n as ReactElement<Record<string, any>>;
      if (el.type === type) found.push(el);
      visit(el.props.children);
    };
    visit(direct(props(o)));
    return found;
  };
  const submit = (o: Partial<Parameters<typeof SessionSetup>[0]>) => find(o, "form")[0]!.props.onSubmit({ preventDefault() {} });
  const btn = (h: string, label: string) => h.match(new RegExp(`<button[^>]*>[^<]*${label}[^<]*</button>`))![0];
  afterEach(() => setProcessLanguage("ru"));

  it("empty field does not send a request", () => {
    const calls: string[] = [];
    submit({ materials: view(), urlText: "   ", onAddUrl: (u) => calls.push(u) });
    submit({ materials: view(), urlText: "", onAddUrl: (u) => calls.push(u) });
    expect(calls).toEqual([]);
    submit({ materials: view(), urlText: "https://example.com/a", onAddUrl: (u) => calls.push(u) });
    expect(calls).toEqual(["https://example.com/a"]);
    const h = page({ materials: view() });
    expect(h).toContain("Ссылка");
    expect(h).toContain("Добавить ссылку");
  });
  it("link added: line with a mark and source", () => {
    const h = page({ materials: withLink() });
    expect(h).toContain('<span class="chip">ссылка</span>');
    expect(h).toContain("example.com/docs/pricing · получено ");
    expect(h).toContain("3100 знаков");
    expect(h).toContain("2 материала · 3520 из 60000 знаков");
    expect(h.match(/>ссылка</g)).toHaveLength(1);
  });
  it("while the link loads: buttons inactive, other materials in place", () => {
    const h = page({ materials: view(), materialsBusy: true, urlPending: "https://example.com/docs/pricing?token=1#x" });
    expect(h).toContain(">загружается…<");
    expect(h).toContain("example.com/docs/pricing");
    expect(h).not.toContain("token=1");
    expect(h).toContain("topic.txt");
    expect(h).not.toContain("Читаю материалы");
    for (const l of ["Предпросмотр материалов", "Добавить ссылку"]) expect(btn(h, l), l).toContain("disabled");
    expect(startBtn(h)).toContain("disabled");
    const idle = page({ materials: view() });
    expect(btn(idle, "Добавить ссылку")).not.toContain("disabled");
    expect(idle).not.toContain("загружается…");
  });
  it("refusal: error line, list and «Start» availability as before", () => {
    const err = "«https://example.com/missing»: ответ HTTP 404";
    const h = page({ materials: view({ error: err }), urlText: "https://example.com/missing" });
    expect(h).toContain('value="https://example.com/missing"');
    expect(btn(h, "Добавить ссылку")).not.toContain("disabled");
    expect(h).toContain("setup__error");
    expect(h).toContain(err);
    expect(h).toContain("topic.txt");
    expect(h).not.toContain("setup-material\" data-pending");
    expect(startBtn(h)).toBe(startBtn(page({ materials: view() })));
    expect(startBtn(h)).not.toContain("disabled");
  });
  it("link over the limit: label with numbers", () => {
    const h = page({ materials: withLink({ chars: 72000, over: 12000 }) });
    expect(h).toContain('<span class="chip">ссылка</span>');
    expect(h).toContain("72000");
    expect(h).toContain("60000");
    expect(h).toContain("12000");
    expect(startBtn(h)).toContain("disabled");
  });
  it("link sources in the preview", () => {
    const m = withLink();
    const pv: MaterialsPreviewView = { handle: "h1", stamp: "s1", createdAt: "2026-10-09T11:05:00.000Z", initial: "text", manifest: null, folder: null, available: [], skipped: [], left: [], sources: [{ id: "m2", url: "https://docs.stand.test/doc", fetchedAt: "2026-10-14T10:02:42.290Z" }], materials: m };
    const h = page({ materials: m, preview: pv, previewOpen: true });
    expect(h).toContain("<summary>Источники ссылок</summary>");
    expect(h).toContain("m2 ← https://docs.stand.test/doc · получено ");
    expect(page({ materials: m, preview: { ...pv, sources: [] }, previewOpen: true })).not.toContain("Источники ссылок");
  });
  it("link sources: time by language", () => {
    const m = withLink();
    const iso = "2026-10-14T10:02:42.290Z";
    const pv: MaterialsPreviewView = { handle: "h1", stamp: "s1", createdAt: iso, initial: "text", manifest: null, folder: null, available: [], skipped: [], left: [], sources: [{ id: "m2", url: "https://docs.stand.test/doc", fetchedAt: iso }], materials: m };
    for (const [lang, word] of [["en", "fetched"], ["ru", "получено"]] as const) {
      setProcessLanguage(lang);
      const line = page({ materials: m, preview: pv, previewOpen: true }).match(/<li><span class="mono">(m2 ←[^<]*)<\/span><\/li>/)![1]!;
      expect(line).toContain("docs.stand.test/doc");
      expect(line).toContain(`${word} ${previewTime(iso, lang)}`);
      expect(line).not.toContain(iso);
    }
  });
  it("link labels in English", () => {
    setProcessLanguage("en");
    const cyr = /[А-Яа-яЁё]/;
    const m = withLink();
    const pv: MaterialsPreviewView = { handle: "h1", stamp: "s1", createdAt: "2026-10-09T11:05:00.000Z", initial: "text", manifest: null, folder: null, available: [], skipped: [], left: [], sources: [{ id: "m2", url: "https://docs.stand.test/doc", fetchedAt: "2026-10-14T10:02:42.290Z" }], materials: m };
    const h = page({ materials: m, preview: pv, previewOpen: true });
    for (const t of ["Link", "Add link", '<span class="chip">link</span>', "fetched ", "Link sources"]) expect(h, t).toContain(t);
    const pend = page({ materials: view(), materialsBusy: true, urlPending: "https://example.com/x" });
    expect(pend).toContain(">loading…<");
    for (const frag of [h.match(/<form[\s\S]*?<\/form>/)![0], h.match(/<li class="setup-material">(?:(?!<\/li>)[\s\S])*example\.com[\s\S]*?<\/li>/)![0], h.match(/<summary>Link sources<\/summary>/)![0], pend.match(/data-pending[\s\S]*?<\/li>/)![0]]) expect(frag).not.toMatch(cyr);
  });
});

describe("The launch button waits for materials to be read (change 106)", () => {
  afterEach(() => setProcessLanguage("ru"));
  const page = (o: { materialsBusy?: boolean; previewBusy?: boolean }) => {
    const r = reg();
    const { ctx, form } = make(r, null);
    const f = apply(ctx, form, { type: "topic", value: "Тема" });
    return renderToStaticMarkup(<SessionSetup form={f} registry={r} template={null} starting={false} error={null} lineups={noLineups} dispatch={() => {}} onStart={() => {}} onBack={() => {}} onSaveAs={() => {}} saveAsBusy={false} saveAsError={null} materialsBusy={o.materialsBusy} previewBusy={o.previewBusy} />);
  };
  // launch button and the line under it: state is conveyed by icon and text
  const hint = (h: string, text: string) => new RegExp(`btn--primary[^>]*>.*?</button><span class="field__hint"><svg[^>]*>.*?</svg> ${text}</span>`).test(h);
  for (const [lang, text] of [["ru", "Читаю материалы…"], ["en", "Reading materials…"]] as const) {
    for (const flag of ["materialsBusy", "previewBusy"] as const) {
      it(`${flag}, ${lang}: «Start» disabled, next to it «${text}»`, () => {
        setProcessLanguage(lang);
        const h = page({ [flag]: true });
        expect(startBtn(h)).toContain("disabled");
        expect(hint(h, text)).toBe(true);
      });
    }
  }
  it("without reading: «Start» available, no waiting line under the button", () => {
    const h = page({});
    expect(startBtn(h)).not.toContain("disabled");
    expect(hint(h, "Читаю материалы…")).toBe(false);
  });
  it("startEnabled: starting and urlPending also block", () => {
    const ok = { canStart: true, starting: false, urlPending: null, materialsBusy: false, previewBusy: false };
    expect(startEnabled(ok)).toBe(true);
    expect(startEnabled({ ...ok, starting: true })).toBe(false);
    expect(startEnabled({ ...ok, urlPending: "https://a.b" })).toBe(false);
    expect(startEnabled({ ...ok, canStart: false })).toBe(false);
  });
});
