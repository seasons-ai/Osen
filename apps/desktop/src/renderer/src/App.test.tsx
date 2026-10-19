import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { Shell, setupView } from "./App.tsx";
import { NewFlow } from "./NewFlow.tsx";
import type { SessionEvent } from "@model-council/core/protocol";
import { History, runPin } from "./History.tsx";
import { initialUi, reduce } from "./store.ts";
import type { UiAction, UiState } from "./store.ts";
import type { HistoryItem } from "../../shared/bridge.ts";

const html = (s: UiState) => renderToStaticMarkup(<Shell state={s} dispatch={() => {}} />);

describe("Shell", () => {
  it("rail: three items, the current one marked", () => {
    const h = html(initialUi());
    for (const l of ["Новое", "История", "Настройки"]) expect(h).toContain(`<span>${l}</span>`);
    expect(h.match(/aria-current="page"/g)).toHaveLength(1);
    expect(h).toMatch(/aria-current="page"[^>]*><svg class="icon"><use href="#i-history"/);
  });

  it("«New» section — gallery screen", () => {
    const h = html({ ...initialUi(), section: "new" });
    expect(h).toContain(">Новое обсуждение</h1>");
    expect(h).toContain("Своя тема");
    expect(h).toContain("Загружаю шаблоны…");
    expect(h).not.toContain("Раздел появится");
  });

  it("settings section — settings screen", () => {
    const h = html({ ...initialUi(), section: "settings" });
    expect(h).toContain(">Настройки</h1>");
    expect(h).toContain("Проверяю провайдеров…");
    expect(h).not.toContain("Раздел появится");
  });

  it("error is visible with the «Close» button", () => {
    const h = html(reduce(initialUi(), { type: "error", message: "Сбой моста" }));
    expect(h).toContain("Сбой моста");
    expect(h).toContain('aria-label="Закрыть"');
    expect(h).toContain('data-tone="danger"');
  });

  it("without openId — History, with openId — session screen", () => {
    expect(html(initialUi())).toContain(">История</h1>");
    const h = html(reduce(initialUi(), { type: "open", id: "x" }));
    expect(h).toContain(">Сессия</h1>");
    expect(h).not.toContain(">История</h1>");
  });
});

describe("Shell: open summary", () => {
  it("open-result from settings and the event of a completed session show «Summary»", () => {
    const ts = "2026-01-01T00:00:00Z";
    const events = [
      {
        seq: 1, ts, type: "session_created", pid: 1,
        session: {
          id: "s1", createdAt: ts, origin: "cli", topic: "Цена", templateId: null, framing: "",
          participants: [1, 2].map((i) => ({ id: `p${i}`, name: `Имя${i}`, providerId: "scripted", model: "m", role: null })),
          limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
        },
      },
      { seq: 2, ts, type: "session_finished", status: "consensus", version: 1, agreed: ["p1"], objectors: [] },
    ] as unknown as SessionEvent[];
    let s = reduce({ ...initialUi(), section: "settings" }, { type: "bridge", event: { type: "open-result", id: "s1" } });
    for (const event of events) s = reduce(s, { type: "bridge", event: { type: "session-event", id: "s1", event } });
    const h = html(s);
    expect(h).toContain("Согласие достигнуто");
    expect(h).not.toContain(">Настройки</h1>");
  });
});

describe("Shell: version", () => {
  it("with version the number is pinned to the bottom of the rail", () => {
    const h = renderToStaticMarkup(<Shell state={initialUi()} dispatch={() => {}} version="9.9.9" />);
    expect(h).toContain('<div class="rail__version" title="Версия приложения">v9.9.9</div>');
    expect(h.indexOf("rail__spacer")).toBeGreaterThan(h.lastIndexOf('class="rail__item"'));
  });

  it("without version there is no number", () => {
    expect(html(initialUi())).not.toContain("rail__version");
  });
});

describe("Shell: owner wait expiry", () => {
  it("an event from the store reaches the feed through the session screen", () => {
    const ts = "2026-01-01T00:00:00Z";
    const events: SessionEvent[] = [
      { seq: 1, ts, type: "session_created", pid: 1, session: {
        id: "s1", createdAt: ts, origin: "cli", topic: "Тема", templateId: null, framing: "",
        participants: [1, 2].map((i) => ({ id: `p${i}`, name: `Имя${i}`, providerId: "scripted", model: "m", role: null })),
        limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
      } },
      { seq: 2, ts, type: "owner_wait_started", waitId: "w1", reasons: ["round_boundary"], questionIds: [], afterTurn: 0, deadline: ts },
      { seq: 3, ts, type: "owner_wait_finished", waitId: "w1", reason: "expired" },
    ];
    let s = reduce(initialUi(), { type: "open", id: "s1" });
    for (const event of events.slice(0, 2)) s = reduce(s, { type: "bridge", event: { type: "session-event", id: "s1", event } });
    expect(html(s)).not.toContain("Время ожидания истекло");
    s = reduce(s, { type: "bridge", event: { type: "session-event", id: "s1", event: events[2]! } });
    expect(html(s)).toContain("Время ожидания истекло · обсуждение продолжилось само");
  });
});

describe("Shell: pinning in history", () => {
  const it1 = (o: Partial<HistoryItem>): HistoryItem => ({ id: "s1", topic: "Тема", createdAt: new Date(2026, 9, 8, 11, 42).toISOString(), origin: "desktop", status: "consensus", templateName: null, participants: [], round: 1, maxRounds: 3, turns: 3, pinned: false, tokenCapStop: false, tokensIncomplete: false, partial: null, ...o });
  const withSessions = (sessions: HistoryItem[]) => reduce(initialUi(), { type: "sessions", sessions });
  const historyProps = (s: UiState, dispatch: (a: UiAction) => void) => {
    const found: Record<string, unknown>[] = [];
    const walk = (n: ReactNode) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === "object" && "type" in n) {
        const el = n as ReactElement<{ children?: ReactNode }>;
        if (el.type === History) found.push(el.props);
        walk(el.props.children);
      }
    };
    walk(Shell({ state: s, dispatch }));
    return found[0] as { filter: unknown; onFilter(f: unknown): void; onError(m: string): void };
  };

  it("a setPinned error is shown to the owner, the row is not pinned, a retry calls setPinned again", async () => {
    let s = withSessions([it1({})]);
    const dispatch = (a: UiAction) => { s = reduce(s, a); };
    let calls = 0;
    const set = async () => { calls++; throw new Error("Не удалось сохранить закрепления"); };
    const busy = () => {};
    await runPin(set, "s1", true, busy, (m) => historyProps(s, dispatch).onError(m));
    expect(html(s)).toContain("Не удалось сохранить закрепления");
    expect(html(s)).toContain('aria-pressed="false" aria-label="Закрепить"');
    expect(html(s)).not.toContain("Закреплена");
    await runPin(set, "s1", true, busy, (m) => historyProps(s, dispatch).onError(m));
    expect(calls).toBe(2);
  });

  it("after a sessions event with pinned: true the row is in the «Pinned» group", () => {
    let s = withSessions([it1({ id: "a" }), it1({ id: "b", topic: "Старая" })]);
    expect(html(s)).not.toContain("Закреплённые");
    s = reduce(s, { type: "bridge", event: { type: "sessions", sessions: [it1({ id: "a" }), it1({ id: "b", topic: "Старая", pinned: true })] } });
    const h = html(s);
    expect(h).toContain("Закреплённые");
    expect(h.indexOf("Закреплённые")).toBeLessThan(h.indexOf("Старая"));
    expect(h.indexOf("Старая")).toBeLessThan(h.indexOf("Остальные"));
  });

  it("a filter from the store applies to the screen and survives a new list", () => {
    let s = reduce(withSessions([it1({ id: "a", topic: "Импорт" }), it1({ id: "b", topic: "Другое" })]), { type: "history-filter", filter: { query: "импорт", status: "all" } });
    expect(html(s)).not.toContain("Другое");
    s = reduce(s, { type: "bridge", event: { type: "sessions", sessions: [it1({ id: "a", topic: "Импорт" }), it1({ id: "b", topic: "Другое" }), it1({ id: "c", topic: "Импорт 2" })] } });
    const h = html(s);
    expect(h).toContain("Импорт 2");
    expect(h).not.toContain("Другое");
    expect(h).toContain('value="импорт"');
  });
});

describe("Shell: rerun", () => {
  it("with state.rerun «Session setup» is open, not the gallery", () => {
    const rerun = {
      sessionId: "s1", date: "2026-10-07", topic: "Тема", templateId: null, framingFromSession: false, participants: [], maxRounds: 3, ownerWait: null,
      materials: { items: [], skipped: [], left: [], folder: null, ignored: [], error: null, chars: 0, limit: 100, over: 0, stamp: "s" },
    };
    const h = html({ ...initialUi(), section: "new", rerun });
    expect(h).toContain("Настройка сессии");
    expect(h).not.toContain("Новое обсуждение");
  });
});

describe("mark in the rail", () => {
  const brand = (h: string) => /<div class="rail__brand"[^>]*>(.*?)<\/div>/.exec(h);

  it.each(["en", "ru"] as const)("%s: in .rail__brand an inline 32×32 svg on theme tokens, no veins, no img, no letter", (language) => {
    const h = renderToStaticMarkup(<Shell state={initialUi()} dispatch={() => {}} language={language} />);
    const m = brand(h)!;
    expect(m[0]).toContain('aria-hidden="true"');
    expect(m[1]).toMatch(/^<svg [^>]*width="32" height="32" aria-hidden="true" focusable="false">.*<\/svg>$/);
    expect(m[1]).toContain("fill:var(--leaf)");
    expect(m[1]).toContain("var(--rain)");
    expect(m[1]!.match(/<line /g)).toHaveLength(1);
    expect(h).not.toContain("<img");
    expect(h).not.toContain("osen-mark-small.svg");
  });

  it("the design/mockup/shell.js mockup puts the same mark in the rail", () => {
    const js = readFileSync(fileURLToPath(new URL("../../../../../design/mockup/shell.js", import.meta.url)), "utf8");
    const m = /'<div class="rail__brand" aria-hidden="true">(.*?)<\/div>'/.exec(js)!;
    expect(m[1]).toBe('<img src="../mockup-osen/brand/svg/osen-mark-small.svg" alt="" width="32" height="32">');
  });
});

describe("Shell: session setup survives leaving for «Settings»", () => {
  const view = { sessionId: "s1" } as never;
  const kept = (section: UiState["section"], extra: Partial<UiState> = {}): UiState => ({ ...initialUi(), section, setupKept: true, ...extra });
  const find = (s: UiState) => {
    const found: ReactElement<{ hidden?: boolean; inert?: boolean; children?: ReactNode; active?: boolean; rerun?: unknown }>[] = [];
    const walk = (n: ReactNode) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === "object" && "type" in n) {
        const el = n as ReactElement<{ children?: ReactNode }>;
        if (el.type === NewFlow || (el.props as { className?: string }).className === "main__setup") found.push(el as never);
        walk(el.props.children);
      }
    };
    walk(Shell({ state: s, dispatch: () => {} }));
    return { wrap: found.find((e) => e.type !== NewFlow), flow: found.find((e) => e.type === NewFlow) };
  };

  it("setupView: mounted when setupKept or in the new section; hidden outside new", () => {
    expect(setupView({ ...initialUi(), section: "history" })).toEqual({ mounted: false, hidden: false });
    expect(setupView({ ...initialUi(), section: "new" })).toEqual({ mounted: true, hidden: false });
    expect(setupView(kept("settings"))).toEqual({ mounted: true, hidden: true });
    expect(setupView(kept("history"))).toEqual({ mounted: true, hidden: true });
    expect(setupView(kept("new"))).toEqual({ mounted: true, hidden: false });
    expect(setupView({ ...initialUi(), section: "settings" })).toEqual({ mounted: false, hidden: false });
  });

  it("the NewFlow key does not change when leaving for «Settings» and returning; the wrapper is hidden and inert", () => {
    const a = find(kept("new", { rerun: view }));
    const b = find(kept("settings", { rerun: view }));
    const c = find(kept("new", { rerun: view }));
    expect(a.flow?.key).toBe("s1");
    expect(b.flow?.key).toBe(a.flow?.key);
    expect(c.flow?.key).toBe(a.flow?.key);
    expect(a.wrap?.props.hidden).toBe(false);
    expect(b.wrap?.props.hidden).toBe(true);
    expect(b.wrap?.props.inert).toBe(true);
    expect(a.flow?.props.active).toBe(true);
    expect(b.flow?.props.active).toBe(false);
  });

  it("after switching to history the setup is not mounted", () => {
    const s = reduce(kept("settings"), { type: "navigate", section: "history" });
    expect(find(s).flow).toBeUndefined();
    expect(html(s)).toContain(">История</h1>");
  });
});
