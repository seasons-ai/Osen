import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredStatus } from "@model-council/core";
import type { HistoryItem } from "../../shared/bridge.ts";
import type { ReactElement, ReactNode } from "react";
import { setProcessLanguage } from "@model-council/core/i18n";
import { LanguageProvider } from "./language.tsx";
import { HistoryView, formatWhen, runPin, selectHistory, stepStatus } from "./History.tsx";
import type { HistoryFilter } from "./store.ts";
import { StatusBadge } from "./StatusBadge.tsx";

const item = (o: Partial<HistoryItem> = {}): HistoryItem => ({
  id: "s1", topic: "Тема", createdAt: new Date(2026, 9, 8, 11, 42).toISOString(), origin: "desktop", status: "consensus",
  templateName: "Цена и тарифы", participants: [{ id: "a", name: "Альфа", model: "default", dropped: false }, { id: "b", name: "Бета", model: "default", dropped: true }],
  round: 3, maxRounds: 4, turns: 9, pinned: false, tokenCapStop: false, tokensIncomplete: false, partial: null, ...o
});
const ALL: HistoryFilter = { query: "", status: "all" };
const html = (sessions: HistoryItem[] | null, filter: HistoryFilter = ALL, busy: string[] = [], usage?: ReactNode) =>
  renderToStaticMarkup(<HistoryView sessions={sessions} filter={filter} busy={new Set(busy)} onFilter={() => {}} onOpen={() => {}} onPin={() => {}} onNew={() => {}} usage={usage} />);
const row = (o?: Partial<HistoryItem>) => html([item(o)]);
// Summary text without markup: numbers wrapped in .mono, part «running now» in .history-summary__live (change 92).
const summaryText = (h: string) => `>${(h.match(/<p class="muted history-summary">(.*?)<\/p>/)?.[1] ?? "").replace(/<[^>]+>/g, "")}<`;

describe("History", () => {
  it.each([
    ["running", "идёт", "accent", '<span class="dots">'],
    ["consensus", "согласие достигнуто", "info", "#i-check"],
    ["no_consensus", "согласия нет", "warn", "#i-alert"],
    ["stopped", "остановлена", "muted", "#i-stop"],
    ["interrupted", "прервана", "muted", "#i-alert"],
    ["failed", "сбой", "danger", "#i-x"]
  ] as [StoredStatus, string, string, string][])("статус %s", (status, text, tone, mark) => {
    const h = row({ status });
    expect(h).toContain(text);
    expect(h).toContain(`data-tone="${tone}"`);
    expect(h).toContain(mark);
    expect(h.includes("history-row--live")).toBe(status === "running");
  });

  it("token ceiling stop: label and badge only on it", () => {
    const h = html([item({ id: "x", status: "stopped", tokenCapStop: true }), item({ id: "y", status: "stopped" })]);
    expect(h.match(/остановлена · потолок токенов/g)).toHaveLength(1);
    expect(h).toContain("#i-coins");
  });
  it("incomplete accounting: only on a token ceiling stop", () => {
    expect(row({ status: "stopped", tokenCapStop: true, tokensIncomplete: true })).toContain("учёт неполный");
    expect(row({ status: "stopped", tokenCapStop: true })).not.toContain("учёт неполный");
    expect(row({ status: "stopped", tokensIncomplete: true })).not.toContain("учёт неполный");
  });

  it.each([["desktop", "приложение", "#i-spark"], ["cli", "терминал", "#i-terminal"], ["mcp", "MCP", "#i-cloud"]] as const)("origin %s", (origin, text, icon) => {
    const h = row({ origin });
    expect(h).toContain(text);
    expect(h).toContain(icon);
  });

  it("empty and null", () => {
    const h = html([]);
    expect(h).toContain("Обсуждений пока нет");
    expect(h).toContain("Новое обсуждение</button>");
    for (const x of [html(null)]) {
      expect(x).not.toContain("history-row");
      expect(x).not.toContain("Обсуждений пока нет");
      expect(x).not.toContain('class="list"');
    }
  });

  it("a new session is added, order as in the array", () => {
    const a = item({ id: "a", topic: "Первая" });
    const b = item({ id: "b", topic: "Вторая" });
    expect(html([a])).not.toContain("Вторая");
    const h = html([b, a]);
    expect(h.indexOf("Вторая")).toBeGreaterThan(-1);
    expect(h.indexOf("Вторая")).toBeLessThan(h.indexOf("Первая"));
  });

  it("summary row", () => {
    const many = (n: number, status: StoredStatus = "consensus") => Array.from({ length: n }, (_, i) => item({ id: String(i), status }));
    expect(summaryText(html(many(1)))).toBe(">1 сессия<");
    expect(summaryText(html(many(2)))).toBe(">2 сессии<");
    expect(summaryText(html(many(5)))).toBe(">5 сессий<");
    expect(summaryText(html([...many(6), item({ id: "r", status: "running" })]))).toBe(">7 сессий · 1 идёт сейчас<");
    expect(summaryText(html([item({ id: "r1", status: "running" }), item({ id: "r2", status: "running" })]))).toBe(">2 сессии · 2 идут сейчас<");
  });

  it("size", () => {
    expect(row({ status: "running", round: 3, maxRounds: 4, turns: 9 })).toContain("круг 3 из 4 · 9 ходов");
    expect(row({ round: 1, turns: 0 })).toContain("1 круг · 0 ходов");
    expect(row({ round: 2, turns: 4 })).toContain("2 круга · 4 хода");
    expect(row({ round: 5, turns: 1 })).toContain("5 кругов · 1 ход<");
  });

  it("participants and template", () => {
    const h = row({ templateName: null });
    expect(h).toContain('<span class="avatar" title="Альфа">1</span>');
    expect(h).toContain('<span class="avatar avatar--off" title="Бета">2</span>');
    expect(h).toContain("Своя тема");
  });

  it("ninth participant: number without the participant color", () => {
    const h = row({ participants: Array.from({ length: 9 }, (_, i) => ({ id: `p${i + 1}`, name: `И${i + 1}`, model: "default", dropped: false })) });
    expect(h).toContain('<span class="avatar" title="И9">9</span>');
    expect(h).toContain('<span class="avatar" title="И8">8</span>');
    expect(h).not.toContain("data-p=");
  });

  it("no delete and no edit", () => {
    const h = row();
    for (const x of ["Удалить", "Изменить", "i-trash"]) expect(h).not.toContain(x);
  });
});

describe("formatWhen", () => {
  const now = new Date(2026, 9, 8, 12, 0);
  const f = (d: Date) => formatWhen(d.toISOString(), now);
  it("today, yesterday, another day, another year", () => {
    expect(f(new Date(2026, 9, 8, 11, 42))).toBe("сегодня, 11:42");
    expect(f(new Date(2026, 9, 7, 18, 3))).toBe("вчера, 18:03");
    expect(f(new Date(2026, 9, 6, 22, 50))).toBe("6 окт., 22:50");
    expect(f(new Date(2025, 9, 6, 22, 50))).toBe("6 окт. 2025 г., 22:50");
  });
  it("en: today, yesterday, another day, another year", () => {
    const e = (d: Date) => formatWhen(d.toISOString(), now, "en").replace(/\s/g, " ");
    expect(e(new Date(2026, 9, 8, 11, 42))).toBe("today, 11:42 AM");
    expect(e(new Date(2026, 9, 7, 18, 3))).toBe("yesterday, 6:03 PM");
    expect(e(new Date(2026, 9, 6, 22, 50))).toBe("Oct 6, 10:50 PM");
    expect(e(new Date(2025, 9, 6, 22, 50))).toBe("Oct 6, 2025, 10:50 PM");
  });
});

// Tree of elements with expanded function components (all without hooks): find the node by condition and call its handler.
type Props = Record<string, unknown> & { children?: ReactNode };
function expand(n: ReactNode): ReactNode {
  if (Array.isArray(n)) return n.map(expand);
  if (n && typeof n === "object" && "type" in n) {
    const el = n as ReactElement<Props>;
    if (el.type === StatusBadge) return el; // uses the language hook: cannot be expanded outside rendering
    if (typeof el.type === "function") return expand((el.type as (p: Props) => ReactNode)(el.props));
    return { ...el, props: { ...el.props, children: expand(el.props.children) } };
  }
  return n;
}
function find(n: ReactNode, pred: (p: Props, type: unknown) => boolean, out: Props[] = []): Props[] {
  if (Array.isArray(n)) n.forEach((c) => find(c, pred, out));
  else if (n && typeof n === "object" && "type" in n) {
    const el = n as ReactElement<Props>;
    if (pred(el.props, el.type)) out.push(el.props);
    find(el.props.children, pred, out);
  }
  return out;
}
interface Spy { opened: string[]; pins: [string, boolean][]; filters: HistoryFilter[] }
function tree(sessions: HistoryItem[], filter: HistoryFilter = ALL, busy: string[] = []) {
  const spy: Spy = { opened: [], pins: [], filters: [] };
  const t = expand(<HistoryView sessions={sessions} filter={filter} busy={new Set(busy)} onFilter={(f) => spy.filters.push(f)} onOpen={(id) => spy.opened.push(id)} onPin={(id, p) => spy.pins.push([id, p])} onNew={() => {}} />);
  return { spy, t, byClass: (c: string) => find(t, (p) => String(p.className ?? "").split(" ").includes(c)) };
}
const click = (p: Props) => (p.onClick as () => void)();

const T = (i: number) => new Date(2026, 9, 8, 12, 0, 0 - i).toISOString();
const S = [
  item({ id: "a", topic: "Переписать импорт заказов", createdAt: T(1), status: "consensus", templateName: "Переписать или чинить" }),
  item({ id: "b", topic: "Сколько брать за подписку", createdAt: T(2), status: "running", templateName: "Цена и тарифы" }),
  item({ id: "c", topic: "Письмо клиенту", createdAt: T(3), status: "stopped", templateName: null }),
  item({ id: "d", topic: "Выбор CRM", createdAt: T(4), status: "failed", templateName: "custom-tpl-removed" }),
  item({ id: "e", topic: "Хостинг", createdAt: T(5), status: "no_consensus", templateName: "Цена и тарифы" }),
  item({ id: "f", topic: "Архив", createdAt: T(6), status: "interrupted", templateName: null })
];
const ids = (r: { pinned: HistoryItem[]; rest: HistoryItem[] }) => [...r.pinned, ...r.rest].map((s) => s.id);
const q = (query: string, status: HistoryFilter["status"] = "all"): HistoryFilter => ({ query, status });

describe("selectHistory: search", () => {
  it("topic case-insensitive", () => expect(ids(selectHistory(S, q("ИМПОРТ")))).toEqual(["a"]));
  it("template name only", () => expect(ids(selectHistory(S, q("тариф")))).toEqual(["b", "e"]));
  it("label «Custom topic» and the id of a missing template", () => {
    expect(ids(selectHistory(S, q("своя")))).toEqual(["c", "f"]);
    expect(ids(selectHistory(S, q("custom-tpl")))).toEqual(["d"]);
  });
  it("spaces at the edges of the query are trimmed, an empty query does not limit", () => {
    expect(ids(selectHistory(S, q("  импорт ")))).toEqual(["a"]);
    expect(ids(selectHistory(S, q("   ")))).toHaveLength(6);
  });
  it("clearing the query leaves only the status", () => {
    expect(ids(selectHistory(S, q("импорт", "running")))).toEqual([]);
    expect(ids(selectHistory(S, q("", "running")))).toEqual(["b"]);
  });
  it("search together with the filter", () => {
    expect(ids(selectHistory(S, q("импорт", "consensus")))).toEqual(["a"]);
    expect(ids(selectHistory(S, q("тариф", "consensus")))).toEqual([]);
  });
  it.each([["running", "b"], ["consensus", "a"], ["no_consensus", "e"], ["stopped", "c"], ["failed", "d"], ["interrupted", "f"]] as const)("status %s on its own", (status, id) => {
    expect(ids(selectHistory(S, q("", status)))).toEqual([id]);
    const h = html(S, q("", status));
    expect(h.match(/class="list__row/g)).toHaveLength(1);
    expect(h).toContain("badge");
  });
  it("«all» does not limit the status", () => expect(ids(selectHistory(S, q("", "all")))).toEqual(["a", "b", "c", "d", "e", "f"]));
});

describe("selectHistory: groups", () => {
  it("pinned separately, order within the groups kept, each session once", () => {
    const r = selectHistory(S.map((s) => (s.id === "f" || s.id === "b" ? { ...s, pinned: true } : s)), ALL);
    expect(r.pinned.map((s) => s.id)).toEqual(["b", "f"]);
    expect(r.rest.map((s) => s.id)).toEqual(["a", "c", "d", "e"]);
  });
  it("pinning does not bypass the filter", () => {
    const r = selectHistory(S.map((s) => (s.id === "f" ? { ...s, pinned: true } : s)), q("", "running"));
    expect(r.pinned).toEqual([]);
    expect(ids(r)).toEqual(["b"]);
  });
});

describe("HistoryView: groups and states", () => {
  const pinned = S.map((s) => (s.id === "f" ? { ...s, pinned: true } : s));
  it("two groups: «Pinned» before «Others»", () => {
    const h = html(pinned);
    expect(h).toContain('<h2 class="history-group">Закреплённые</h2>');
    expect(h.indexOf("Закреплённые")).toBeLessThan(h.indexOf("Остальные"));
    expect(h.indexOf("Архив")).toBeLessThan(h.indexOf("Остальные"));
    expect(h.indexOf("Остальные")).toBeLessThan(h.indexOf("Переписать импорт"));
  });
  it("a pinned row did not pass the filter: no «Pinned» group, no headings", () => {
    const h = html(pinned, q("", "running"));
    expect(h).not.toContain("Закреплённые");
    expect(h).not.toContain("Остальные");
    expect(h).not.toContain("Архив");
  });
  it("no pins — no headings", () => {
    const h = html(S);
    expect(h).not.toContain("history-group");
    expect(h.match(/class="list"/g)).toHaveLength(1);
  });
  it("all pinned — «Others» not shown", () => {
    const h = html(S.map((s) => ({ ...s, pinned: true })));
    expect(h).toContain("Закреплённые");
    expect(h).not.toContain("Остальные");
  });
  it("«Nothing found» with the panel and «Reset», not «No discussions yet»", () => {
    const h = html(S, q("нет такого"));
    expect(h).toContain("Ничего не найдено");
    expect(h).toContain(">Сбросить</button>");
    expect(h).toContain("По запросу «нет такого» ничего нет");
    expect(h).toContain("history-tools");
    expect(h).not.toContain("Обсуждений пока нет");
    expect(summaryText(h)).toBe(">найдено 0 из 6 сессий<");
    expect(html(S, q("импорт", "failed"))).toContain("По запросу «импорт» среди сессий со статусом «сбой» ничего нет");
  });
  it("empty history: no filter panel and no «Nothing found»", () => {
    const h = html([], q("x"));
    expect(h).toContain("Обсуждений пока нет");
    expect(h).toContain("Новое обсуждение</button>");
    expect(h).not.toContain("history-tools");
    expect(h).not.toContain("Ничего не найдено");
  });
  it("«Reset» sets an empty query and «all»", () => {
    const { spy, t } = tree(S, q("нет такого", "failed"));
    const [reset] = find(t, (p, type) => type === "button" && p.children === "Сбросить");
    click(reset!);
    expect(spy.filters).toEqual([ALL]);
  });
  it("summary: numbers in .mono, «running now» in .history-summary__live, with a filter — the mockup format and number forms", () => {
    expect(html(S)).toContain('<p class="muted history-summary"><span class="mono">6</span> сессий · <span class="history-summary__live"><span class="mono">1</span> идёт сейчас</span></p>');
    expect(html(S, q("импорт"))).toContain('>найдена <span class="mono">1</span> из <span class="mono">6</span> сессий<');
    expect(html(S, q("тариф"))).toContain('>найдено <span class="mono">2</span> из <span class="mono">6</span> сессий<');
    expect(html([S[0]!], q("импорт"))).toContain('>найдена <span class="mono">1</span> из <span class="mono">1</span> сессии<');
    expect(html(S.filter((s) => s.status !== "running"))).not.toContain("history-summary__live");
  });
  it("row: avatars without participant color, departed one — avatar--off, second time line mono", () => {
    const h = row();
    expect(h).toContain('<div class="history-people"><span class="avatar" title="Альфа">1</span><span class="avatar avatar--off" title="Бета">2</span></div>');
    expect(h).not.toContain("data-p=");
    expect(h).not.toContain("avatar--sm");
    expect(h).toContain('<div class="history-size mono">3 круга · 9 ходов</div>');
    expect(h).not.toContain('history-size muted');
  });
});

describe("HistoryView: panel and row", () => {
  it("search field without a magnifier icon, value from state", () => {
    const h = html(S, q("импорт"));
    expect(h).toContain('class="history-search-wrap"><input type="search"');
    expect(h).not.toContain("#i-search\"></use></svg><input");
    expect(h).toContain('value="импорт"');
  });
  it("radio group: seven .pill capsules, the selected one without a check mark and with tabindex 0", () => {
    const h = html(S, q("", "consensus"));
    expect(h).toContain('role="radiogroup"');
    expect(h.match(/role="radio"/g)).toHaveLength(7);
    for (const l of ["все", "идёт", "согласие", "нет согласия", "остановлена", "сбой", "прервана"]) expect(h).toContain(`${l}</button>`);
    expect(h).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*class="pill">согласие</);
    expect(h).not.toContain("history-filter__item");
    expect(h).not.toMatch(/class="pill"><svg/);
    expect(h.match(/tabindex="-1"/g)).toHaveLength(6);
    expect(h.match(/aria-checked="true"/g)).toHaveLength(1);
  });
  it("click on an item sets the status, the query is kept", () => {
    const { spy, t } = tree(S, q("тариф"));
    const radios = find(t, (p) => p.role === "radio");
    click(radios[2]!);
    expect(spy.filters).toEqual([q("тариф", "consensus")]);
  });
  it("arrows in the radio group: right, left, wrapping; another key is ignored", () => {
    expect(stepStatus("all", "ArrowRight")).toBe("running");
    expect(stepStatus("running", "ArrowLeft")).toBe("all");
    expect(stepStatus("all", "ArrowLeft")).toBe("interrupted");
    expect(stepStatus("interrupted", "ArrowRight")).toBe("all");
    expect(stepStatus("all", "Tab")).toBeNull();
    const { spy, t } = tree(S, q("x", "all"));
    const focused: number[] = [];
    const kids = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ focus: () => focused.push(i) }));
    let prevented = 0;
    const [first] = find(t, (p) => p.role === "radio");
    (first!.onKeyDown as (e: unknown) => void)({ key: "ArrowRight", preventDefault: () => prevented++, currentTarget: { parentElement: { children: kids } } });
    expect(spy.filters).toEqual([q("x", "running")]);
    expect(focused).toEqual([1]);
    expect(prevented).toBe(1);
  });
  it("row: opening — button, pinning — separate button with aria-pressed and a label", () => {
    const h = row();
    expect(h).toMatch(/<button type="button" class="history-topic__title history-open" title="Тема">Тема<\/button>/);
    expect(h).toContain('class="history-pin" aria-pressed="false" aria-label="Закрепить" title="Закрепить"');
    expect(h).not.toContain("Закреплена");
    expect(h).not.toContain("history-row--pinned");
  });
  it("pinned row: label, icon, aria-pressed, «Unpin»", () => {
    const h = row({ pinned: true });
    expect(h).toContain("history-row--pinned");
    expect(h).toContain('<span class="history-pinned"><svg class="icon icon--sm"><use href="#i-pin"');
    expect(h).toContain("Закреплена</span>");
    expect(h).toContain('aria-pressed="true" aria-label="Открепить" title="Открепить"');
  });
  it("while a call is in progress this row's button is unavailable, others are available", () => {
    const h = html(S, ALL, ["a"]);
    expect(h.match(/class="history-pin"[^>]*disabled/g)).toHaveLength(1);
  });
  it("pinning calls onPin(id, true) and does not open; unpinning — onPin(id, false)", () => {
    const { spy, byClass } = tree([item({ id: "x" }), item({ id: "y", pinned: true })]);
    const pins = byClass("history-pin");
    click(pins[0]!);
    click(pins[1]!);
    expect(spy.pins).toEqual([["y", false], ["x", true]]); // the pinned group is first
    expect(spy.opened).toEqual([]);
  });
  it("keyboard: opening and pinning are different focusable buttons, each does its own action", () => {
    const { spy, byClass } = tree([item({ id: "x", pinned: true })]);
    const [open] = byClass("history-open");
    const [pin] = byClass("history-pin");
    expect(open).not.toBe(pin);
    click(open!);
    expect(spy.opened).toEqual(["x"]);
    expect(spy.pins).toEqual([]);
    click(pin!);
    expect(spy.pins).toEqual([["x", false]]);
    expect(spy.opened).toEqual(["x"]);
    expect(html([item({ pinned: true })])).not.toMatch(/tabindex="-1"[^>]*history-open|history-pin[^>]*tabindex="-1"/);
  });
  it("no delete and no edit on a pinned row", () => {
    const h = row({ pinned: true });
    for (const x of ["Удалить", "Изменить", "i-trash"]) expect(h).not.toContain(x);
  });
});

describe("runPin", () => {
  it("success: the button is busy during the call and freed; no error", async () => {
    let busy: ReadonlySet<string> = new Set();
    const seen: string[][] = [];
    const errors: string[] = [];
    await runPin(async (id, p) => { seen.push([id, String(p), [...busy].join()]); }, "x", true, (u) => { busy = u(busy); }, (m) => errors.push(m));
    expect(seen).toEqual([["x", "true", "x"]]);
    expect([...busy]).toEqual([]);
    expect(errors).toEqual([]);
  });
  it("error: the reason goes to onError, the button is available again, a retry is possible", async () => {
    let busy: ReadonlySet<string> = new Set();
    const errors: string[] = [];
    let calls = 0;
    const set = async () => { calls++; throw new Error("Не удалось записать закрепления"); };
    await runPin(set, "x", true, (u) => { busy = u(busy); }, (m) => errors.push(m));
    expect(errors).toEqual(["Не удалось записать закрепления"]);
    expect(busy.has("x")).toBe(false);
    await runPin(set, "x", true, (u) => { busy = u(busy); }, (m) => errors.push(m));
    expect(calls).toBe(2);
  });
});

describe("History: usage summary slot", () => {
  const slot = <section data-testid="usage-slot" />;
  it("stands before the «history-summary» row when sessions exist", () => {
    const h = html([item()], ALL, [], slot);
    expect(h.indexOf("usage-slot")).toBeGreaterThan(-1);
    expect(h.indexOf("usage-slot")).toBeLessThan(h.indexOf("history-summary"));
  });
  it("not rendered for empty history and before the list is loaded", () => {
    expect(html([], ALL, [], slot)).not.toContain("usage-slot");
    expect(html(null, ALL, [], slot)).not.toContain("usage-slot");
  });
  it("with an active search and filter the slot is the same, including without matches", () => {
    expect(html([item()], { query: "Тема", status: "consensus" }, [], slot)).toContain("usage-slot");
    expect(html([item()], { query: "нет такого", status: "all" }, [], slot)).toContain("usage-slot");
  });
});

describe("History: language en", () => {
  beforeEach(() => setProcessLanguage("en")); // the status badge and date take the process language (change 58)
  afterEach(() => setProcessLanguage("ru"));
  const E = (o: Partial<HistoryItem> = {}) => item({ topic: "Topic", templateName: "Pricing", participants: [{ id: "a", name: "Alpha", model: "default", dropped: false }], ...o });
  const he = (sessions: HistoryItem[] | null, filter: HistoryFilter = ALL) =>
    renderToStaticMarkup(<HistoryView language="en" sessions={sessions} filter={filter} busy={new Set()} onFilter={() => {}} onOpen={() => {}} onPin={() => {}} onNew={() => {}} />);
  const many = (n: number) => Array.from({ length: n }, (_, i) => item({ id: String(i) }));

  it("labels, size, sources", () => {
    const h = he([E({ round: 3, turns: 7, pinned: true, origin: "cli", templateName: null }), E({ id: "r", status: "running", round: 2, maxRounds: 4, turns: 1 })]);
    for (const x of ["History", "New discussion", 'placeholder="Search by topic and template"', 'aria-label="Status"', "3 rounds · 7 turns", "round 2 of 4 · 1 turn<", "terminal", "Pinned", "Custom topic", 'aria-label="Unpin"', 'aria-label="Pin"', "<span class=\"mono\">2</span> sessions · <span class=\"history-summary__live\"><span class=\"mono\">1</span> running now</span>"])
      expect(h, x).toContain(x);
    expect(h).not.toMatch(/[А-Яа-я]/);
  });
  it("number forms", () => {
    expect(summaryText(he(many(1)))).toBe(">1 session<");
    expect(summaryText(he(many(2)))).toBe(">2 sessions<");
    expect(summaryText(he(many(2), { query: "Тема", status: "all" }))).toBe(">Found 2 of 2 sessions<");
    expect(summaryText(he(many(1), { query: "Тема", status: "all" }))).toBe(">Found 1 of 1 session<");
  });
  it("incomplete accounting and the empty state", () => {
    expect(he([item({ status: "stopped", tokenCapStop: true, tokensIncomplete: true })])).toContain("usage incomplete");
    const e = he([]);
    expect(e).toContain("No discussions yet");
    expect(e).not.toMatch(/[А-Яа-я]/);
  });
  it("nothing found: query and status substituted", () => {
    const h = he([item()], q("abc", "failed"));
    expect(h).toContain("Nothing found</h2>");
    expect(h).toContain("Nothing found for “abc” among sessions with status “failed”.");
    expect(h).toContain(">Reset<");
    expect(he([item()], q("abc"))).toContain("Nothing found for “abc”. Change");
    expect(he([item()], q("", "failed"))).toContain("No sessions with status “failed”.");
  });
  it("the status filter is labeled in English", () => {
    const h = he([item()]);
    for (const x of [">all<", ">running<", ">consensus<", ">no consensus<", ">stopped<", ">failed<", ">interrupted<"]) expect(h, x).toContain(x);
  });
  it("groups", () => {
    const h = he([item({ id: "p", pinned: true }), item({ id: "o" })]);
    expect(h).toContain(">Pinned</h2>");
    expect(h).toContain(">Others</h2>");
  });
  it("search: «custom» finds a session without a template, the Russian word for «custom» does not; a Russian topic is searched", () => {
    const L = [item({ id: "c", templateName: null, topic: "x" }), item({ id: "d", topic: "Выбор базы данных", templateName: "T" })];
    expect(ids(selectHistory(L, q("custom"), "en"))).toEqual(["c"]);
    expect(ids(selectHistory(L, q("своя"), "en"))).toEqual([]);
    expect(ids(selectHistory(L, q("СВОЯ"), "ru"))).toEqual(["c"]);
    expect(ids(selectHistory(L, q("базы"), "en"))).toEqual(["d"]);
  });
  it("switching language with history open keeps the query and status", () => {
    const f = q("Тема", "consensus");
    const view = (language: "en" | "ru") => renderToStaticMarkup(
      <LanguageProvider initial={{ language, source: "file", locked: false }}>
        <HistoryView language={language} sessions={[item()]} filter={f} busy={new Set()} onFilter={() => {}} onOpen={() => {}} onPin={() => {}} onNew={() => {}} />
      </LanguageProvider>);
    for (const l of ["en", "ru"] as const) {
      const h = view(l);
      expect(h).toContain('value="Тема"');
      expect(h).toMatch(/aria-checked="true"[^>]*>(<svg.*?<\/svg>)?(consensus|согласие)</);
    }
    expect(summaryText(view("en"))).toBe(">Found 1 of 1 session<");
    expect(summaryText(view("ru"))).toBe(">найдена 1 из 1 сессии<");
  });
});

describe("History: journal read only partially", () => {
  it("newer_version: badge and mark instead of status", () => {
    const h = row({ status: "interrupted", partial: { reason: "newer_version", lastEvent: 42 } });
    expect(h).toContain("нужна новая версия");
    expect(h).toContain("прочитано до события №42");
    expect(h).not.toContain('</svg>прервана</span>'); // the «interrupted» filter button — not a badge
  });
  it("corrupted: the journal is damaged", () => {
    const h = row({ status: "interrupted", partial: { reason: "corrupted", lastEvent: 17 } });
    expect(h).toContain("журнал повреждён");
    expect(h).toContain("прочитано до события №17");
  });
  it("without partial the status badge is as before", () => {
    const h = row({ status: "interrupted" });
    expect(h).toContain('</svg>прервана</span>');
    expect(h).not.toContain("прочитано до события");
  });
  it("the «interrupted» filter does not show a session with partial, «all» shows it", () => {
    const list = [item({ id: "p", status: "interrupted", partial: { reason: "corrupted", lastEvent: 3 } }), item({ id: "i", status: "interrupted" })];
    const ids = (status: HistoryFilter["status"]) => selectHistory(list, { query: "", status }).rest.map((x) => x.id);
    expect(ids("interrupted")).toEqual(["i"]);
    expect(ids("all")).toEqual(["p", "i"]);
  });
  it("en", () => {
    const h = renderToStaticMarkup(<HistoryView language="en" sessions={[item({ partial: { reason: "newer_version", lastEvent: 42 } })]} filter={ALL} busy={new Set()} onFilter={() => {}} onOpen={() => {}} onPin={() => {}} onNew={() => {}} />);
    expect(h).toContain("newer version needed");
    expect(h).toContain("read up to event No. 42");
  });
});
