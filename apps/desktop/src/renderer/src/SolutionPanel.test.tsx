import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { LanguageProvider } from "./language.tsx";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent, SessionState } from "@model-council/core/protocol";
import { SolutionPanelView, copyVersion, diffAfterTab, tabTarget } from "./SolutionPanel.tsx";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const mk = (bodies: Body[]): SessionEvent[] => bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);
const created: Body = {
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Цена", templateId: null, framing: "",
    participants: [1, 2, 3].map((i) => ({ id: `p${i}`, name: `Имя${i}`, providerId: "scripted", model: `мод${i}`, role: null })),
    limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 },
  },
};
const started = (turn: number, participantId: string): Body => ({ type: "turn_started", turn, round: 1, participantId });
const done = (turn: number, participantId: string, stance: "amend" | "agree", version: number, text = `текст v${version}`): Body => ({
  type: "turn_completed", turn, round: 1, participantId, stance, normalized: false, reasoning: "а",
  solution: stance === "amend" ? text : null, version, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 5,
});
const fold = (b: Body[]) => foldEvents(mk(b));
const view = (s: SessionState, selected: number | null = null) => renderToStaticMarkup(<SolutionPanelView state={s} selected={selected} onSelect={() => {}} />);

const v2 = fold([created, started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2)]);
const v3 = fold([created, started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2), started(3, "p3"), done(3, "p3", "amend", 3)]);

describe("SolutionPanelView", () => {
  it("p2 proposed version 2: current, author p2, one agreeing, v2 tab selected", () => {
    const h = view(v2);
    expect(h).toContain("версия 2 · текущая");
    expect(h).toContain("Имя2");
    expect(h.match(/class="avatar avatar--sm" data-tone="info"/g)).toHaveLength(1);
    expect(h).toContain('title="Имя2"');
    expect(h).toMatch(/aria-selected="true"[^>]*>v2</);
    expect(h).toMatch(/aria-selected="false"[^>]*>v1</);
  });
  it("after p1 agree there are two agreeing", () => {
    const s = fold([created, started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2), started(3, "p1"), done(3, "p1", "agree", 2)]);
    expect(view(s).match(/class="avatar avatar--sm" data-tone="info"/g)).toHaveLength(2);
  });
  it("viewing version 1 while current is 3", () => {
    const h = view(v3, 1);
    expect(h).toContain("текст v1");
    expect(h).toContain("Это не текущая версия. Текущая — версия 3.");
    expect(h).not.toContain("согласны");
    expect(h).toMatch(/aria-selected="true"[^>]*>v1</);
    expect(h).toContain("версия 1<");
    expect(h).not.toContain("версия 1 · текущая");
  });
  it("null follows the new version, an unknown number shows the current one", () => {
    expect(view(v3, null)).toContain("версия 3 · текущая");
    const h = view(v3, 99);
    expect(h).toContain("версия 3 · текущая");
    expect(h).not.toContain("Это не текущая версия");
  });
  it("no versions", () => {
    const h = view(fold([created]));
    expect(h).toContain("Решения пока нет");
    expect(h).not.toContain('role="tab"');
  });
  it("the vote of an agreeing participant — info", () => {
    expect(view(v2)).toMatch(/class="session-votes" data-tone="info"/);
    expect(view(v2)).not.toMatch(/data-tone="ok" title/);
  });
  it("«Agreeing: nobody»", () => {
    expect(view({ ...v2, agreed: [] })).toContain('<span class="muted">никто</span>');
  });
  it("«Objecting:» on the current version; no objections or an old version — no line", () => {
    const obj = fold([created, started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p3"), { ...done(2, "p3", "agree", 1), stance: "object" } as Body]);
    const h = view(obj);
    expect(h).toContain("возражает");
    expect(h).toContain('data-tone="danger" title="Имя3"');
    expect(view(v2)).not.toContain("возражает");
    const old = fold([created, started(1, "p3"), { ...done(1, "p3", "agree", 1), stance: "object" } as Body, started(2, "p1"), done(2, "p1", "amend", 2)]);
    expect(view(old, 1)).not.toContain("возражает");
  });
  it("the link becomes <a>", () => {
    const s = fold([created, started(1, "p1"), done(1, "p1", "amend", 1, "см. https://example.com/x тут")]);
    expect(view(s)).toContain('<a href="https://example.com/x"');
  });
  it("labels in lowercase, without colons; version mono", () => {
    const obj = fold([created, started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p3"), { ...done(2, "p3", "agree", 1), stance: "object" } as Body]);
    const h = view(obj);
    for (const t of ["автор", "согласны", "возражает"]) expect(h).toContain(`>${t}<`);
    for (const t of ["Автор:", "Согласны:", "Возражает:"]) expect(h).not.toContain(t);
    expect(h.match(/class="session-meta__label"/g)).toHaveLength(3);
    expect(view(v3)).toMatch(/<div class="session-meta__version mono">версия 3 · текущая<\/div>/);
    setProcessLanguage("en");
    try {
      const e = view(obj);
      for (const t of [">author<", ">agreed<", ">objecting<"]) expect(e).toContain(t);
      expect(view(v2)).toContain('mono">version 2 · current<');
    } finally { setProcessLanguage("ru"); }
  });
  it("votes: group with one mark, sm avatars with a tone and a name, without svg", () => {
    const s = fold([created, started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p3"), { ...done(2, "p3", "agree", 1), stance: "object" } as Body, started(3, "p2"), done(3, "p2", "agree", 1)]);
    const h = view(s);
    const groups = h.match(/<span class="session-votes" data-tone="[a-z]+">.*?<\/span><\/span>/g) ?? [];
    expect(groups).toHaveLength(2);
    const info = groups.find((g) => g.includes('data-tone="info"'))!, danger = groups.find((g) => g.includes('data-tone="danger"'))!;
    expect(info.match(/class="avatar avatar--sm" data-tone="info" title="Имя\d"/g)).toHaveLength(2);
    expect(info.match(/✓/g)).toHaveLength(1);
    expect(danger.match(/class="avatar avatar--sm" data-tone="danger" title="Имя3"/g)).toHaveLength(1);
    expect(danger.match(/×/g)).toHaveLength(1);
    expect(info + danger).not.toContain("<svg");
  });
  it("classes: solution header, mono tab, «Copy» btn btn--sm", () => {
    const h = view(v3);
    expect(h).toContain("session-col__head session-col__head--solution");
    expect(h.match(/class="tab mono"/g)).toHaveLength(3);
    expect(h).toMatch(/<button type="button" class="btn btn--sm"[^>]*>/);
    expect(h).not.toContain("btn--ghost");
  });
  it("numbered plain text — ol.solution-list, without numbers; link inside li", () => {
    const h = view(texts("1. a\n2. b\n3. c\n4. d"));
    expect(h).toMatch(/<ol class="prose session-view__text solution-list">/);
    expect(h.match(/<li>/g)).toHaveLength(4);
    expect(h).not.toContain("1. a");
    const l = view(texts("1. см. https://example.com/x тут\n2. b"));
    expect(l).toMatch(/<li>[^<]*<a href="https:\/\/example.com\/x"/);
  });
  it("paragraphs and a single line with a number — without ol", () => {
    expect(view(texts("первый абзац\n\nвторой абзац"))).not.toContain("<ol");
    const h = view(texts("1. Принять тариф"));
    expect(h).not.toContain("<ol");
    expect(h).toContain("1. Принять тариф");
  });
  it("comparison of a numbered version — a flow with ins, without ol", () => {
    const h = vx(texts("1. a\n2. b", "1. a\n2. c\n3. d"), null, { diff: true });
    expect(h).not.toContain("<ol");
    expect(h).toContain('<ins class="diff-add">');
  });
  it("no session — empty", () => expect(view(fold([]))).toBe(""));
});

describe("tabTarget", () => {
  it("current → null, old → number", () => {
    expect(tabTarget(3, 3)).toBeNull();
    expect(tabTarget(1, 3)).toBe(1);
  });
});

const texts = (...t: string[]) => fold([created, ...t.flatMap((x, i) => [started(i + 1, `p${(i % 3) + 1}`), done(i + 1, `p${(i % 3) + 1}`, "amend", i + 1, x)])]);
type Extra = { diff?: boolean; notice?: { tone: "ok" | "danger"; text: string } | null };
const vx = (s: SessionState, selected: number | null, o: Extra = {}) =>
  renderToStaticMarkup(<SolutionPanelView state={s} selected={selected} onSelect={() => {}} diff={o.diff} notice={o.notice} />);
const swap = texts("Один старый план", "Один новый план");

describe("SolutionPanelView: comparison", () => {
  it("normal state: toolbar row, the switch is off and available", () => {
    const h = vx(v3, null);
    expect(h).toContain("solution-tools");
    expect(h).toMatch(/<input type="checkbox"(?![^>]*checked)(?![^>]*disabled)[^>]*\/>/);
    expect(h).not.toContain("<ins");
    expect(h).not.toContain("<del");
    expect(h).not.toContain("Изменения:");
  });
  it("comparison is off for version 3: plain text", () => {
    const h = vx(v3, null, { diff: false });
    expect(h).toContain("текст v3");
    expect(h).not.toContain("+");
    expect(h).not.toContain("\u2212");
  });
  it("version 1: unavailable, not checked even with diff, plain text", () => {
    for (const h of [vx(v3, 1, { diff: true }), vx(fold([created, started(1, "p1"), done(1, "p1", "amend", 1)]), null, { diff: true })]) {
      expect(h).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*disabled/);
      expect(h).toContain("первая версия");
      expect(h).toContain("текст v1");
      expect(h).not.toContain("<ins");
      expect(h).not.toContain("Изменения:");
    }
  });
  it("word replacement", () => {
    const h = vx(swap, null, { diff: true });
    expect(h).toContain('<del class="diff-del">\u2212старый</del>');
    expect(h).toContain('<ins class="diff-add">+новый</ins>');
    expect(h).toContain("Изменения: версия 2 против 1");
    expect(h).toContain("Имя2");
    expect(h).toContain("Добавлено слов: 1");
    expect(h).toContain("Убрано слов: 1");
    expect(h).toMatch(/Один <del/);
    expect(h).toMatch(/<\/ins> план/);
    expect(h).toMatch(/<input type="checkbox"[^>]*checked/);
  });
  it("old version: 2 against 1, a warning, no «Agreeing»", () => {
    const h = vx(v3, 2, { diff: true });
    expect(h).toContain("версия 2 против 1");
    expect(h).not.toContain("версия 3 против 2");
    expect(h).toMatch(/<input type="checkbox"[^>]*checked/);
    expect(h).toContain("Это не текущая версия");
    expect(h).not.toContain("согласны");
  });
  it("following the new version", () => {
    expect(vx(v2, null, { diff: true })).toContain("версия 2 против 1");
    const h = vx(v3, null, { diff: true });
    expect(h).toContain("версия 3 против 2");
    expect(h).toContain("Имя3");
  });
  it("identical versions: zeros, no ins/del", () => {
    const h = vx(texts("тот же текст", "тот же текст"), null, { diff: true });
    expect(h).toContain("Добавлено слов: 0");
    expect(h).toContain("Убрано слов: 0");
    expect(h).not.toContain("<ins");
    expect(h).not.toContain("<del");
  });
  it("only spaces and line breaks changed", () => {
    const h = vx(texts("а б\nв", "а  б\n\nв"), null, { diff: true });
    expect(h).not.toContain("<ins");
    expect(h).not.toContain("<del");
    expect(h).toContain("а  б\n\nв");
  });
  it("long text: comparison by lines", () => {
    const w = (n: number, x: string) => Array.from({ length: n }, () => x).join(" ");
    const long = (mid: string) => `начало\n${mid} ${w(2000, "слово")}\nконец`;
    const h = vx(texts(long("старое"), long("новое")), null, { diff: true });
    expect(h).toContain("Сравнение по строкам: длинный текст");
    expect(h).toContain("Добавлено слов: 2001");
    expect(h).toContain("Убрано слов: 2001");
    expect(vx(swap, null, { diff: true })).not.toContain("Сравнение по строкам");
  });
  it("safety: markup escaped, links clickable", () => {
    const bad = "<script>alert(1)</script> <b>x</b> см. https://a.example/1 тут";
    const s = texts("старое", bad);
    for (const diff of [false, true]) {
      const h = vx(s, null, { diff });
      expect(h).not.toContain("<script>");
      expect(h).not.toContain("<b>");
      expect(h).toContain("&lt;script&gt;");
      expect(h).toContain('<a href="https://a.example/1" target="_blank" rel="noreferrer">');
    }
    const keep = vx(texts("см. https://a.example/1 старое", "см. https://a.example/1 новое https://b.example/2"), null, { diff: true });
    expect(keep).toContain('<a href="https://a.example/1"');
    expect(keep).toMatch(/<ins class="diff-add">[^<]*<a href="https:\/\/b.example\/2"/);
  });
  it("accessibility: checkbox inside label, button, marks as text", () => {
    const h = vx(swap, null, { diff: true });
    expect(h).toMatch(/<label[^>]*><input type="checkbox"[^>]*\/> Показать изменения<\/label>/);
    expect(h).toMatch(/<button type="button"[^>]*>.*Скопировать<\/button>/);
    expect(h).toMatch(/<ins[^>]*>\+/);
    expect(h).toMatch(/<del[^>]*>\u2212/);
  });
  it("no decision: no tools", () => {
    const h = vx(fold([created]), null);
    expect(h).not.toContain("solution-tools");
    expect(h).not.toContain('type="checkbox"');
    expect(h).not.toContain("Скопировать");
    expect(h).toContain("Решения пока нет");
  });
  it("notification: role=status and tone; tab and switch are kept", () => {
    const ok = vx(v3, 2, { diff: true, notice: { tone: "ok", text: "Версия 2 скопирована в буфер обмена" } });
    expect(ok).toContain('data-tone="ok" role="status"');
    expect(ok).toContain("Версия 2 скопирована");
    const bad = vx(v3, 2, { diff: true, notice: { tone: "danger", text: "нет доступа" } });
    expect(bad).toContain('data-tone="danger" role="status"');
    for (const h of [ok, bad]) {
      expect(h).toMatch(/aria-selected="true"[^>]*>v2</);
      expect(h).toMatch(/<input type="checkbox"[^>]*checked/);
    }
  });
});

describe("diffAfterTab and copyVersion", () => {
  it("the first version turns comparison off, the others keep their position", () => {
    expect(diffAfterTab(true, 1, 1)).toBe(false);
    expect(diffAfterTab(true, 2, 1)).toBe(true);
    expect(diffAfterTab(false, 3, 1)).toBe(false);
  });
  const ok = (got: string[]) => (t: string) => { got.push(t); return Promise.resolve(); };
  it("the exact text is copied: v1, previous v2, line breaks", async () => {
    const s = texts("первый\n\n  текст\n", "второй вариант", "третий");
    const got: string[] = [];
    const [a, b] = s.versions;
    expect(await copyVersion(a!, ok(got))).toEqual({ tone: "ok", text: "Версия 1 скопирована в буфер обмена" });
    await copyVersion(b!, ok(got));
    expect(got).toEqual(["первый\n\n  текст\n", "второй вариант"]);
  });
  it("with comparison on, the source text goes to the clipboard, not the marked-up one", async () => {
    const got: string[] = [];
    const shown = swap.versions[1]!;
    expect(vx(swap, 2, { diff: true })).toContain("+новый");
    await copyVersion(shown, ok(got));
    expect(got).toEqual(["Один новый план"]);
  });
  it("error: danger with the error text", async () => {
    expect(await copyVersion(swap.versions[0]!, () => Promise.reject(new Error("нет доступа")))).toEqual({ tone: "danger", text: "нет доступа" });
    expect(await copyVersion(swap.versions[0]!, () => Promise.reject("сбой"))).toEqual({ tone: "danger", text: "сбой" });
  });
});

describe("SolutionPanelView: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = <T,>(f: () => T): T => { setProcessLanguage("en"); return f(); };
  const cyr = /[А-Яа-яЁё]/;
  // Cyrillic is allowed only in version text, names and owner input.
  const bare = (h: string) => h.replace(/Имя\d|текст v\d|Один|старый|новый|план|старое|новое|слово|начало|конец/g, "");

  it("no decision", () => {
    const h = en(() => vx(fold([created]), null));
    expect(h).toContain(">Solution<");
    expect(h).toContain('aria-label="Solution panel"');
    expect(h).toContain("No solution yet");
    expect(h).not.toContain("Copy");
  });
  it("one version: first version, copy, agreeing", () => {
    const one = fold([created, started(1, "p1"), done(1, "p1", "amend", 1)]);
    const h = en(() => vx(one, null));
    for (const t of ["Show changes", "first version", "Copy</button>", "version 1 · current", "author", "agreed"]) expect(h).toContain(t);
    expect(bare(h)).not.toMatch(cyr);
    expect(en(() => vx({ ...v2, agreed: [] }, null))).toContain('<span class="muted">nobody</span>');
  });
  it("several versions, not the current version", () => {
    const h = en(() => vx(v3, 1));
    expect(h).toContain("This is not the current version. The current one is version 3.");
    expect(h).toContain("version 1<");
    expect(h).not.toContain("version 1 · current");
    expect(h).not.toContain("agreed");
    expect(bare(h)).not.toMatch(cyr);
  });
  it("objecting", () => {
    const obj = fold([created, started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p3"), { ...done(2, "p3", "agree", 1), stance: "object" } as Body]);
    expect(en(() => vx(obj, null))).toContain("objecting");
  });
  it("comparison on and comparison by lines", () => {
    const h = en(() => vx(swap, null, { diff: true }));
    for (const t of ["Changes: version 2 vs 1", "Words added: 1", "Words removed: 1"]) expect(h).toContain(t);
    expect(bare(h)).not.toMatch(cyr);
    const w = (n: number, x: string) => Array.from({ length: n }, () => x).join(" ");
    const long = (mid: string) => `начало\n${mid} ${w(2000, "слово")}\nконец`;
    const l = en(() => vx(texts(long("старое"), long("новое")), null, { diff: true }));
    expect(l).toContain("Line-by-line comparison: the text is long. The counters include whole changed lines.");
    expect(l).toContain("Words added: 2001");
  });
  it("copy notification", async () => {
    expect(await copyVersion(swap.versions[1]!, () => Promise.resolve(), "en")).toEqual({ tone: "ok", text: "Version 2 copied to the clipboard" });
    expect(await copyVersion(swap.versions[1]!, () => Promise.resolve(), "ru")).toEqual({ tone: "ok", text: "Версия 2 скопирована в буфер обмена" });
    expect(await copyVersion(swap.versions[0]!, () => Promise.reject(new Error("нет доступа")), "en")).toEqual({ tone: "danger", text: "нет доступа" });
  });
  it("the same properties in two languages: tab, switch and version text are the same, labels differ", () => {
    const e = en(() => vx(v3, 2, { diff: true }));
    setProcessLanguage("ru");
    const r = vx(v3, 2, { diff: true });
    for (const h of [e, r]) {
      expect(h).toMatch(/aria-selected="true"[^>]*>v2</);
      expect(h).toMatch(/<input type="checkbox"[^>]*checked/);
      expect(h).toContain("Имя2");
    }
    expect(e).toContain("version 2 vs 1"); expect(r).toContain("версия 2 против 1");
  });
  it("language from the context when the process language is ru", () => {
    const ctx = (language: Language) => renderToStaticMarkup(
      <LanguageProvider initial={{ language, source: "file", locked: false, damaged: false }}>
        <SolutionPanelView state={swap} selected={null} onSelect={() => {}} diff />
      </LanguageProvider>);
    const e = ctx("en"), r = ctx("ru");
    for (const t of ["Solution panel", "Show changes", "Copy", "version 2 · current", "Words added: 1"]) expect(e).toContain(t);
    for (const t of ["Панель решения", "Показать изменения", "Скопировать", "версия 2 · текущая", "Добавлено слов: 1"]) expect(r).toContain(t);
  });
  it("the lineup does not depend on the language", () => {
    const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]).join(",");
    const states: [SessionState, number | null, Extra][] = [
      [fold([created]), null, {}], [v3, null, {}], [v3, 1, {}], [swap, null, { diff: true }],
      [v3, 2, { diff: true, notice: { tone: "ok", text: "x" } }],
    ];
    for (const [s, sel, o] of states) {
      const e = en(() => vx(s, sel, o));
      setProcessLanguage("ru");
      expect(tags(e)).toBe(tags(vx(s, sel, o)));
    }
  });
});
