import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { TemplateCard, TemplatesView } from "../../shared/setup.ts";
import { initialGallery } from "./gallery.ts";
import type { GalleryState } from "./gallery.ts";
import { NewDiscussion } from "./NewDiscussion.tsx";

const tpl = (o: Partial<TemplateCard> = {}): TemplateCard => ({
  id: "t1", title: "Цена и тарифы", category: "Продукт", description: "Описание", exampleTopic: "", roles: ["а", "б", "в"], maxRounds: 4, source: "builtin", modified: false, ...o
});
const html = (view: TemplatesView | null, o: { error?: string | null; def?: number | null; gallery?: Partial<GalleryState> } = {}) =>
  renderToStaticMarkup(
    <NewDiscussion view={view} error={o.error ?? null} defaultMaxRounds={o.def === undefined ? 3 : o.def} onPick={() => {}}
      gallery={{ ...initialGallery, ...o.gallery }} onNew={() => {}} onEdit={() => {}} onDuplicate={() => {}} dispatchGallery={() => {}} onConfirmRemove={() => {}} />
  );
const ok = (templates: TemplateCard[], errors: TemplatesView["errors"] = []): TemplatesView => ({ templates, errors });
const meta = (h: string) => h.match(/<p class="card__meta index-meta">(.*?)<\/p>/)?.[1] ?? null;
const topbarMeta = (h: string) => h.match(/<span class="mono index-topbar-meta">(.*?)<\/span>/)?.[1] ?? null;

describe("NewDiscussion", () => {
  it("«Custom topic» comes before the first category", () => {
    const h = html(ok([tpl()]));
    expect(h.indexOf("Своя тема")).toBeGreaterThan(-1);
    expect(h.indexOf("Своя тема")).toBeLessThan(h.indexOf("Продукт"));
  });

  it("groups by category with a counter", () => {
    const h = html(ok([tpl({ id: "a", title: "А1" }), tpl({ id: "b", category: "Код", title: "Б1" }), tpl({ id: "c", title: "А2" })]));
    expect(h).toContain('<h2 class="section-title index-heading">Продукт<span class="mono index-count">2</span></h2>');
    expect(h).toContain('<h2 class="section-title index-heading">Код<span class="mono index-count">1</span></h2>');
    expect(h).not.toContain('class="chip">');
    expect(h.indexOf("А1")).toBeLessThan(h.indexOf("А2"));
    expect(h.indexOf("А2")).toBeLessThan(h.indexOf("Б1"));
  });

  it.each([[1, "1 шаблон не загрузился"], [2, "2 шаблона не загрузились"], [5, "5 шаблонов не загрузились"]])("errors %i", (n, title) => {
    const errors = Array.from({ length: n }, (_, i) => ({ file: `f${i}.json`, reason: `причина ${i}` }));
    const h = html(ok([tpl()], errors));
    expect(h).toContain(title);
    expect(h).toContain('<span class="mono">f0.json</span> — причина 0');
    expect(h).toContain("Остальные шаблоны доступны.");
    expect(h).toContain("Цена и тарифы");
    if (n > 1) expect(h).toContain("; ");
  });

  it("a custom template is marked, a built-in one is not", () => {
    expect(html(ok([tpl({ source: "user" })]))).toContain("пользовательский");
    expect(html(ok([tpl()]))).not.toContain("index-origin");
  });

  it.each([[1, "1 роль"], [3, "3 роли"], [5, "5 ролей"]])("roles %i", (n, text) => {
    expect(html(ok([tpl({ roles: Array(n).fill("р") })]))).toContain(text);
  });

  it("without roles there is no label", () => {
    expect(meta(html(ok([tpl({ roles: [] })])))).toBe("до 4 кругов");
  });

  it.each([[1, "до 1 круга"], [2, "до 2 кругов"], [5, "до 5 кругов"]])("rounds %i", (n, text) => {
    expect(html(ok([tpl({ maxRounds: n })]))).toContain(text);
  });

  it("the template's maxRounds takes priority over the registry, null takes the registry, both null — no label", () => {
    expect(html(ok([tpl({ maxRounds: 2 })]), { def: 7 })).toContain("до 2 кругов");
    expect(html(ok([tpl({ maxRounds: null })]), { def: 7 })).toContain("до 7 кругов");
    expect(meta(html(ok([tpl({ maxRounds: null })]), { def: null }))).toBe("3 роли");
  });

  it("loading", () => {
    const h = html(null);
    expect(h).toContain("Загружаю шаблоны…");
    expect(h).toContain("Своя тема");
  });

  it("loading error", () => {
    const h = html(null, { error: "Не вышло" });
    expect(h).toContain('data-tone="danger" role="alert"');
    expect(h).toContain("Не вышло");
    expect(h).not.toContain("Загружаю шаблоны…");
  });

  const own = tpl({ id: "own", title: "Свой", source: "user" });
  const mod = tpl({ id: "mod", title: "Правленый", source: "user", modified: true });
  const text = (h: string) => h.replace(/<[^>]+>/g, "");

  it("«New template» next to «Custom topic» in one grid", () => {
    const h = html(ok([tpl()]));
    expect(h).toContain("Новый шаблон");
    expect(h).toContain("Свой шаблон: рамка обсуждения, роли и лимиты.");
    const grid = h.slice(h.indexOf('<div class="grid-cards">'));
    expect(grid.slice(0, grid.indexOf("</div>"))).toContain("Своя тема");
    expect(grid.slice(0, grid.indexOf("</div>"))).toContain("Новый шаблон");
  });

  it("built-in: Edit and Duplicate, without Delete, Reset and the mark", () => {
    const h = html(ok([tpl()]));
    expect(h).toContain("Изменить");
    expect(h).toContain("Дублировать");
    expect(h).not.toContain("Удалить");
    expect(h).not.toContain("Сбросить к встроенному");
    expect(h).not.toContain("index-origin");
  });

  it("custom: mark, Delete, without Reset", () => {
    const h = html(ok([own]));
    expect(h).toContain("пользовательский");
    expect(h).toContain("Удалить");
    expect(h).not.toContain("Сбросить к встроенному");
  });

  it("modified built-in: mark, Delete and Reset", () => {
    const h = html(ok([mod]));
    expect(h).toContain("изменён");
    expect(h).toContain("Удалить");
    expect(h).toContain("Сбросить к встроенному");
  });

  it("the main area contains no nested buttons", () => {
    const h = html(ok([own, mod, tpl()]));
    const parts = h.split('<button type="button" class="index-card__main"').slice(1);
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      const inner = p.slice(0, p.indexOf("</button>"));
      expect(inner).not.toContain("<button");
      expect(inner).not.toContain("<a ");
    }
  });

  it("confirmation of deleting a custom one", () => {
    const h = html(ok([own, tpl({ id: "b", title: "Другой" })]), { gallery: { confirming: { id: "own", mode: "delete" } } });
    expect(h).toContain("Удалить шаблон «Свой»?");
    expect(h).toContain('Идентификатор <span class="mono">own</span>. Файл шаблона будет удалён из папки данных.');
    expect(h).toContain(">Отмена<");
    expect(h).toContain('role="alert"');
    expect(h.match(/index-card__actions/g)).toHaveLength(1);
  });

  it("confirmation of deleting a modified one and of reset", () => {
    const d = html(ok([mod]), { gallery: { confirming: { id: "mod", mode: "delete" } } });
    expect(text(d)).toContain("Ваша правка будет удалена, вернётся встроенный шаблон.");
    const r = html(ok([mod]), { gallery: { confirming: { id: "mod", mode: "reset" } } });
    expect(r).toContain("Сбросить «Правленый» к встроенному?");
    expect(r).toContain('data-tone="warn"');
    expect(r).toContain("Ваша правка шаблона будет удалена, вернётся встроенный вариант.");
    expect(r).toContain("btn btn--primary btn--sm");
  });

  it("removing blocks the confirmation buttons", () => {
    const h = html(ok([own]), { gallery: { confirming: { id: "own", mode: "delete" }, removing: true } });
    expect(h.match(/disabled=""/g)).toHaveLength(2);
  });

  it("refusal at the card and without a card", () => {
    const c = html(ok([own]), { gallery: { failure: { id: "own", message: "Идентификатор занят" } } });
    expect(c).toContain("Не удалось удалить шаблон");
    expect(c).toContain("Идентификатор занят");
    expect(c).toContain("Понятно");
    expect(c).toContain("index-card__actions");
    const n = html(ok([own]), { gallery: { failure: { id: null, message: "Нет файла" } } });
    expect(n).toContain("Не удалось открыть редактор");
    expect(n).not.toContain("Не удалось удалить шаблон");
  });

  it("a warning about broken files without buttons", () => {
    const h = html(ok([], [{ file: "x.json", reason: "битый" }]));
    const w = h.slice(h.indexOf('data-tone="warn"'));
    expect(w.slice(0, w.indexOf("Остальные шаблоны доступны.") + 30)).not.toContain("<button");
  });
});

describe("NewDiscussion: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = <T,>(f: () => T): T => { setProcessLanguage("en"); return f(); };
  const cyr = /[А-Яа-яЁё]/;
  const own = tpl({ id: "own", title: "Own", category: "Cat", description: "Desc", source: "user" });
  const mod = tpl({ id: "mod", title: "Mod", category: "Cat", description: "Desc", modified: true });

  it("en: heading, hint, cards, actions, marks; no Cyrillic", () => {
    const h = en(() => html(ok([own, mod])));
    for (const t of ["New discussion", "Choose a discussion template or set your own topic.", "Custom topic", "Any question without a template.", "New template", "Your own template: discussion framing, roles and limits.", "Edit", "Duplicate", "Delete", "Reset to built-in", "custom", "modified"]) expect(h).toContain(t);
    expect(h).not.toMatch(cyr);
  });

  it.each([[1, "1 role", "1 роль"], [2, "2 roles", "2 роли"], [5, "5 roles", "5 ролей"]])("roles %i in en and ru", (n, e, r) => {
    const v = ok([tpl({ roles: Array(n).fill("r") })]);
    expect(en(() => html(v))).toContain(e);
    setProcessLanguage("ru");
    expect(html(v)).toContain(r);
  });

  it.each([[1, "up to 1 round<", "до 1 круга"], [5, "up to 5 rounds", "до 5 кругов"]])("rounds %i in en and ru", (n, e, r) => {
    const v = ok([tpl({ maxRounds: n })]);
    expect(en(() => html(v))).toContain(e);
    setProcessLanguage("ru");
    expect(html(v)).toContain(r);
  });

  it("en: confirmations of delete and reset", () => {
    const d = en(() => html(ok([own]), { gallery: { confirming: { id: "own", mode: "delete" } } }));
    expect(d).toContain("Delete template “Own”?");
    expect(d).toContain("The template file will be deleted from the data folder. Past sessions will not change.");
    expect(d).toContain("Cancel");
    expect(d).not.toMatch(cyr);
    const m = en(() => html(ok([mod]), { gallery: { confirming: { id: "mod", mode: "delete" } } }));
    expect(m).toContain("Your edit will be removed and the built-in template will return.");
    const r = en(() => html(ok([mod]), { gallery: { confirming: { id: "mod", mode: "reset" } } }));
    expect(r).toContain("Reset “Mod” to the built-in version?");
    expect(r).toContain("Cancel");
    expect(r).not.toMatch(cyr);
  });

  it("en: failures, templates that did not load, loading", () => {
    const f = en(() => html(ok([own]), { gallery: { failure: { id: "own", message: "raw" } } }));
    expect(f).toContain("Could not delete the template");
    expect(f).toContain("Got it");
    expect(en(() => html(ok([own]), { gallery: { failure: { id: null, message: "raw" } } }))).toContain("Could not open the editor");
    const errs = (n: number) => ok([own], Array.from({ length: n }, (_, i) => ({ file: `f${i}.json`, reason: `why ${i}` })));
    expect(en(() => html(errs(1)))).toContain("1 template failed to load");
    const h = en(() => html(errs(3)));
    expect(h).toContain("3 templates failed to load");
    expect(h).toContain("The other templates are available.");
    expect(h).toContain('<span class="mono">f0.json</span> — why 0');
    expect(en(() => html(null))).toContain("Loading templates…");
  });

  it("template data is not translated, marks and counters are English", () => {
    const ru = tpl({ id: "r", title: "Цена", category: "Продукт", description: "Описание", source: "user", roles: ["а", "б"], maxRounds: 2 });
    const h = en(() => html(ok([ru])));
    expect(h).toContain("Цена");
    expect(h).toContain("Продукт");
    expect(h).toContain("Описание");
    expect(h).toContain("custom");
    expect(h).toContain("2 roles");
    expect(h).toContain("up to 2 rounds");
    const c = en(() => html(ok([ru]), { gallery: { confirming: { id: "r", mode: "delete" } } }));
    expect(c).toContain("Delete template “Цена”?");
  });

  it("ru: the name in the confirmation is verbatim, the text is unchanged", () => {
    const c = html(ok([tpl({ id: "own", title: "Цена", source: "user" })]), { gallery: { confirming: { id: "own", mode: "delete" } } });
    expect(c).toContain("Удалить шаблон «Цена»?");
    expect(c).toContain("Файл шаблона будет удалён из папки данных. Прошлые сессии не изменятся.");
  });
});

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("NewDiscussion: view of the «New discussion» screen per osen mockup", () => {
  afterEach(() => setProcessLanguage("ru"));
  const seven = ok(Array.from({ length: 7 }, (_, i) => tpl({ id: `t${i}`, title: `Т${i}`, category: i < 3 ? "Продукт" : "Код" })));

  it("panel meta: 7 templates · 2 categories in ru and en, mono on the right in the topbar", () => {
    const h = html(seven);
    expect(topbarMeta(h)).toBe("7 шаблонов · 2 категории");
    expect(h.slice(h.indexOf('<header class="topbar">'), h.indexOf("</header>"))).toContain('index-topbar-meta');
    setProcessLanguage("en");
    expect(topbarMeta(html(seven))).toBe("7 templates · 2 categories");
  });

  it("no meta until the list is received; with an empty list — zeros; a single form", () => {
    expect(topbarMeta(html(null))).toBeNull();
    expect(topbarMeta(html(null, { error: "Не вышло" }))).toBeNull();
    expect(topbarMeta(html(ok([])))).toBe("0 шаблонов · 0 категорий");
    expect(topbarMeta(html(ok([tpl()])))).toBe("1 шаблон · 1 категория");
    setProcessLanguage("en");
    expect(topbarMeta(html(ok([tpl()])))).toBe("1 template · 1 category");
    expect(topbarMeta(html(ok([])))).toBe("0 templates · 0 categories");
  });

  const ruTemplates = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "шаблон" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "шаблона" : "шаблонов"}`;
  const ruCategories = (k: number) => `${k} ${k % 10 === 1 && k % 100 !== 11 ? "категория" : k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 10 || k % 100 >= 20) ? "категории" : "категорий"}`;

  it("property: for any set of templates the meta is N templates · K distinct categories (200 seeds)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = mulberry32(seed);
      const n = Math.floor(rnd() * 40);
      const cats = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, i) => `к${i}`);
      const list = Array.from({ length: n }, (_, i) => tpl({ id: `s${i}`, title: `С${i}`, category: cats[Math.floor(rnd() * cats.length)]! }));
      const k = new Set(list.map((t) => t.category)).size;
      setProcessLanguage("ru");
      expect(topbarMeta(html(ok(list))), `seed ${seed}`).toBe(`${ruTemplates(n)} · ${ruCategories(k)}`);
      setProcessLanguage("en");
      expect(topbarMeta(html(ok(list))), `seed ${seed}`).toBe(`${n} ${n === 1 ? "template" : "templates"} · ${k} ${k === 1 ? "category" : "categories"}`);
    }
  });

  it("category number is mono without .chip, on one line with the heading", () => {
    const h = html(seven);
    expect(h).toContain('<h2 class="section-title index-heading">Продукт<span class="mono index-count">3</span></h2>');
    expect(h).not.toContain('<span class="chip">3</span>');
  });

  it("card: meta «3 roles · up to 4 rounds» without icons, the label chip without an icon", () => {
    const h = html(ok([tpl({ source: "user" })]));
    expect(meta(h)).toBe("3 роли · до 4 кругов");
    const origin = h.slice(h.indexOf('<p class="index-origin">'), h.indexOf("</p>", h.indexOf('<p class="index-origin">')));
    expect(origin).toContain('<span class="chip">пользовательский</span>');
    expect(origin).not.toContain("<svg");
    setProcessLanguage("en");
    expect(meta(html(ok([tpl()])))).toBe("3 roles · up to 4 rounds");
  });

  it("action row: quiet buttons of normal size without icons, including Delete and Reset", () => {
    const h = html(ok([tpl({ id: "mod", source: "user", modified: true })]));
    const row = h.slice(h.indexOf('<div class="index-card__actions">'), h.indexOf("</div>", h.indexOf('<div class="index-card__actions">')));
    expect(row).not.toContain("<svg");
    expect(row).not.toContain("btn--sm");
    expect(row.match(/<button type="button" class="btn btn--ghost">/g)).toHaveLength(4);
    for (const t of ["Изменить", "Дублировать", "Удалить", "Сбросить к встроенному"]) expect(row).toContain(`>${t}</button>`);
  });

  it("«Custom topic» and «New template»: glyphs ✎ and + instead of SVG", () => {
    const h = html(ok([tpl()]));
    expect(h).toContain('<h2 class="card__title index-custom"><span class="index-glyph" aria-hidden="true">✎</span> Своя тема</h2>');
    expect(h).toContain('<h2 class="card__title index-custom"><span class="index-glyph" aria-hidden="true">+</span> Новый шаблон</h2>');
    expect(h.slice(0, h.indexOf('<section'))).not.toContain("#i-edit");
    expect(h).toContain('<main class="content content--index">');
    expect(h).toContain('<section class="stack index-section">');
  });
});
