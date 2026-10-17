import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { LanguageProvider } from "./language.tsx";
import { panels } from "../../shared/messages/session-panels.ts";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent, SessionState } from "@model-council/core/protocol";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const mk = (bodies: Body[]): SessionEvent[] => bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);

const created = (n = 3, topic = "Цена", origin: "desktop" | "cli" = "cli"): Body => ({
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin, topic, templateId: null, framing: "",
    participants: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Имя${i + 1}`, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  },
});
const started = (turn: number, participantId: string): Body => ({ type: "turn_started", turn, round: 1, participantId });
const done = (
  turn: number, participantId: string, stance: "amend" | "agree" | "object", version: number,
  extra: { reasoning?: string; questions?: { id: string; to: string; text: string }[]; answers?: { questionId: string; text: string }[] } = {},
): Body => ({
  type: "turn_completed", turn, round: 1, participantId, stance, normalized: false, reasoning: extra.reasoning ?? `аргумент ${turn}`,
  solution: stance === "amend" ? `текст v${version}` : null, version,
  questions: extra.questions ?? [], answers: extra.answers ?? [], attempts: 1, usage: {}, durationMs: 5,
});
const fold = (bodies: Body[]): SessionState => foldEvents(mk(bodies));
const noop = () => {};
import type { HistoryItem } from "../../shared/bridge.ts";
import { SessionScreen, noStop, openedPanel, sessionStatus, stopFlags, stopMarks } from "./SessionScreen.tsx";
import type { StopAction, StopMarks } from "./SessionScreen.tsx";
import { Discussion } from "./Discussion.tsx";
import { WaitPanelView } from "./WaitPanel.tsx";
import { openResume, submitChoice, submitResume } from "./Result.tsx";
import type { ResumeView } from "../../shared/bridge.ts";
import { SolutionPanelView } from "./SolutionPanel.tsx";

const item = (status: string, topic = "Цена из истории") => ({ status, topic } as HistoryItem);
const fin = (status: "consensus" | "no_consensus", objectors: { participantId: string; reasoning: string | null }[] = []): Body =>
  ({ type: "session_finished", status, version: 1, agreed: ["p1"], objectors }) as unknown as Body;
const html = (state: SessionState, it: HistoryItem | null = null) =>
  renderToStaticMarkup(<SessionScreen id="s1" item={it} state={state} live={null} onNew={noop} onError={noop} />);

const midway = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2")]);
const finished = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), fin("consensus")]);

describe("sessionStatus", () => {
  it("no session — loading", () => expect(sessionStatus(fold([]), item("running"))).toBe("loading"));
  it("there is a completion — its status, even if history lags behind", () => {
    expect(sessionStatus(finished, item("running"))).toBe("consensus");
    expect(sessionStatus(finished, null)).toBe("consensus");
  });
  it("history says «interrupted», no completion — interrupted", () => expect(sessionStatus(midway, item("interrupted"))).toBe("interrupted"));
  it("history knows about the completion, the event is not read to the end — loading", () => expect(sessionStatus(midway, item("stopped"))).toBe("loading"));
  it("otherwise running", () => {
    expect(sessionStatus(midway, item("running"))).toBe("running");
    expect(sessionStatus(midway, null)).toBe("running");
  });
});

describe("SessionScreen", () => {
  it("loading: topic from history", () => {
    const h = html(fold([]), item("running"));
    expect(h).toContain("Загрузка…");
    expect(h).toContain("Цена из истории");
    expect(h).not.toContain("Участники");
    expect(html(fold([]))).toContain(">Сессия</h1>");
  });
  it("in progress — discussion screen", () => {
    const h = html(midway, item("running"));
    for (const l of ["Участники", "Лента ходов", "Панель решения"]) expect(h).toContain(`aria-label="${l}"`);
    expect(h).toContain("Остановить");
    expect(h).toContain("думает");
  });
  it("in progress: the owner's reply field is present", () => {
    const h = html(midway, item("running"));
    expect(h).toContain("Реплика владельца");
    expect(h).toContain("<textarea");
  });
  // The «To feed» state is set by a click that is unavailable without the DOM: the completed-session rule is covered in Discussion.test.tsx.
  it("completed — summary screen without a field", () => {
    expect(html(finished, item("consensus"))).not.toContain("Уточнение, поправка курса"); // owner reply field; «Owner choice» has its own note
  });
  it("completed — summary screen", () => {
    const h = html(finished, item("consensus"));
    expect(h).toContain("Итоговое решение");
    expect(h).toContain(">Согласие достигнуто<");
    expect(h).toContain("текст v1");
    expect(h).not.toContain("Остановить");
  });
  it("interrupted: summary, nobody is «thinking»", () => {
    expect(midway.currentTurn).not.toBeNull();
    const h = html(midway, item("interrupted"));
    expect(h).toContain(">Обсуждение прервано<");
    expect(h).not.toContain("думает");
  });
  it("summary shows objections", () => {
    const s = fold([
      created(2), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1, { reasoning: "слишком дорого" }),
      fin("no_consensus", [{ participantId: "p2", reasoning: "слишком дорого" }]),
    ]);
    const h = html(s, item("no_consensus"));
    expect(h).toContain("Возражают");
    expect(h).toContain("слишком дорого");
  });
});

describe("SessionScreen: date in the summary", () => {
  it("the date in the summary header is taken from item.createdAt", () => {
    const h = html(finished, { ...item("consensus"), createdAt: "2026-01-01T09:05:00Z" } as HistoryItem);
    expect(h).toMatch(/<span class="result-hero__when mono">[^<]+<\/span>/);
    expect(html(finished, null)).not.toContain("result-hero__when");
  });
});

describe("SessionScreen: version comparison", () => {
  it("a session from history opens with the summary", () => {
    const h = html(finished, item("consensus"));
    expect(h).toContain("Итоговое решение");
    expect(h).not.toContain("Показать изменения");
  });
  it("viewing the comparison changes nothing in the state", () => {
    const old = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2)]);
    const before = JSON.stringify(old);
    const h = renderToStaticMarkup(<SolutionPanelView state={old} selected={null} onSelect={noop} diff />);
    expect(h).toContain("Изменения: версия 2 против 1");
    expect(JSON.stringify(old)).toBe(before);
  });
});

describe("SessionScreen: rerun", () => {
  it("the summary screen has «Run again» and «Discuss further»", () => {
    const h = html(finished);
    expect(h).toContain("Запустить заново");
    expect(h).toContain("Обсудить дальше");
  });
  it("the feed of an in-progress session has none of them", () => {
    expect(html(midway)).not.toContain("Запустить заново");
  });
});

describe("SessionScreen: continuation", () => {
  const stopped = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), { type: "session_finished", status: "stopped", version: 1, agreed: [], objectors: [] } as unknown as Body]);
  const cliStopped = fold([created(3, "Цена", "cli"), { type: "session_finished", status: "stopped", version: null, agreed: [], objectors: [] } as unknown as Body]);
  const rv = { allowed: true, reason: null, blocked: null, rounds: { min: 1, max: 20, remaining: 1, initial: 1 }, participants: [], replaceable: [], replacements: [], providers: [], agreementReset: false, tokenCap: { cap: null, spent: 0, exhausted: false }, draftCalls: 0 } as ResumeView;

  it("the button is present for a stopped session, including one from the terminal (cli)", () => {
    expect(html(stopped)).toContain("Продолжить обсуждение");
    expect(html(cliStopped)).toContain("Продолжить обсуждение");
    expect(html(finished)).not.toContain("Продолжить обсуждение");
  });
  it("a click calls resumeOptions(id)", async () => {
    const calls: string[] = [];
    const r = await openResume(async (id) => { calls.push(id); return rv; }, "s1", { current: false });
    expect(calls).toEqual(["s1"]);
    expect(r).toEqual({ ok: true, value: rv });
  });
  it("resumeOptions error — text for the notice; the guard is released", async () => {
    const guard = { current: false };
    expect(await openResume(async () => { throw new Error("Нет доступа"); }, "s1", guard)).toEqual({ ok: false, error: "Нет доступа" });
    expect(guard.current).toBe(false);
  });
  it("«Continue» with a double click calls resumeSession once", async () => {
    const calls: [string, number][] = [];
    let release!: () => void;
    const call = (id: string, rounds: number) => new Promise<{ droppedOwnerRequests: string[] }>((res) => { calls.push([id, rounds]); release = () => res({ droppedOwnerRequests: ["а"] }); });
    const guard = { current: false };
    const first = submitResume(call, "s1", 2, guard);
    expect(await submitResume(call, "s1", 2, guard)).toBeNull();
    release();
    expect(await first).toEqual({ ok: true, value: ["а"] });
    expect(calls).toEqual([["s1", 2]]);
    expect(await submitResume(call, "s1", 2, guard)).toBeNull(); // after success there is no retry
  });
  it("engine refusal: reason, and a retry is possible", async () => {
    const guard = { current: false };
    expect(await submitResume(async () => { throw new Error("Сессия идёт: исполнитель ещё работает."); }, "s1", 1, guard)).toEqual({ ok: false, error: "Сессия идёт: исполнитель ещё работает." });
    expect(guard.current).toBe(false);
  });
  it("success returns the texts of deleted requests; empty list — empty array", async () => {
    expect(await submitResume(async () => ({ droppedOwnerRequests: [] }), "s1", 1, { current: false })).toEqual({ ok: true, value: [] });
  });
});

describe("SessionScreen: owner choice", () => {
  const sel = { version: 2, statusAtSelection: "no_consensus", note: null, ts: "2026-01-01T00:00:00Z" } as const;
  it("success: bridge arguments and result; an empty note goes as undefined", async () => {
    const calls: unknown[][] = [];
    const call = async (...a: [string, number, string?]) => { calls.push(a); return sel; };
    expect(await submitChoice(call, "s1", 2, "  ", { current: false })).toEqual({ ok: true, value: sel });
    expect(await submitChoice(call, "s1", 2, "заметка", { current: false })).toEqual({ ok: true, value: sel });
    expect(calls).toEqual([["s1", 2, undefined], ["s1", 2, "заметка"]]);
  });
  it("refusal: reason, guard free — a retry is possible", async () => {
    const guard = { current: false };
    expect(await submitChoice(async () => { throw new Error("Сессия идёт."); }, "s1", 1, "x", guard)).toEqual({ ok: false, error: "Сессия идёт." });
    expect(guard.current).toBe(false);
  });
  it("double click gives one call", async () => {
    let n = 0;
    let release!: () => void;
    const call = () => new Promise<typeof sel>((res) => { n++; release = () => res(sel); });
    const guard = { current: false };
    const first = submitChoice(call, "s1", 2, "", guard);
    expect(await submitChoice(call, "s1", 2, "", guard)).toBeNull();
    release();
    expect(await first).toEqual({ ok: true, value: sel });
    expect(n).toBe(1);
  });
});

describe("SessionScreen: independent drafts", () => {
  it("in-progress phase: section in the feed, «drafts» counter, the bridge is not needed for output", () => {
    const c = created() as Extract<Body, { type: "session_created" }>;
    const s = fold([{ ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId: "p2" } } }, { type: "draft_attempt_started", draftId: "d1", participantId: "p1", attempt: 1 }]);
    const h = html(s, item("running"));
    expect(h).toContain("Независимые черновики");
    expect(h).toContain("пишет черновик");
    expect(h).toContain('<span>принято черновиков</span><span class="mono session-meter__count">0 из 3</span>');
  });
});

describe("SessionScreen: reopening the continuation panel", () => {
  // The screen cannot be mounted without the DOM: the pure part is checked — the new view and a new number (panel key) on each opening.
  it("the second opening gives a fresh view and another number", () => {
    const v1 = { allowed: true } as ResumeView, v2 = { allowed: false } as ResumeView;
    const a = openedPanel(null, v1);
    const b = openedPanel(a, v2);
    expect(a).toEqual({ view: v1, n: 1 });
    expect(b.view).toBe(v2);
    expect(b.n).not.toBe(a.n);
  });
});

describe("SessionScreen: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  it("loading: label and heading without a session", () => {
    setProcessLanguage("en");
    const h = html(fold([]), item("running"));
    expect(h).toContain("Loading…");
    expect(h).toContain("Цена из истории");
    expect(html(fold([]))).toContain(">Session</h1>");
  });
  it("language from the context when the process language is ru", () => {
    const ctx = (language: Language) => renderToStaticMarkup(
      <LanguageProvider initial={{ language, source: "file", locked: false }}>
        <SessionScreen id="s1" item={null} state={fold([])} live={null} onNew={noop} onError={noop} />
      </LanguageProvider>);
    expect(ctx("en")).toContain(">Session</h1>");
    expect(ctx("en")).toContain("Loading…");
    expect(ctx("ru")).toContain(">Сессия</h1>");
    expect(ctx("ru")).toContain("Загрузка…");
  });
  it("the loading state does not depend on the language", () => {
    const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]).join(",");
    setProcessLanguage("en");
    const e = html(fold([]), item("running"));
    setProcessLanguage("ru");
    expect(tags(e)).toBe(tags(html(fold([]), item("running"))));
  });
  it("notifications: decision copied and file saved", () => {
    expect(panels("en").copiedNotice(3)).toBe("Version 3 (discussion result) copied to the clipboard");
    expect(panels("en").copiedChoiceNotice(1)).toBe("Version 1 (your choice) copied to the clipboard");
    expect(panels("en").fileSaved("/tmp/a.md")).toBe("File saved: /tmp/a.md");
    expect(panels("ru").copiedNotice(3)).toBe("Версия 3 (итог обсуждения) скопирована в буфер обмена");
    expect(panels("ru").copiedChoiceNotice(1)).toBe("Версия 1 (ваш выбор) скопирована в буфер обмена");
    expect(panels("ru").fileSaved("/tmp/a.md")).toBe("Файл сохранён: /tmp/a.md");
  });
});

describe("SessionScreen: journal read only partially", () => {
  afterEach(() => setProcessLanguage("ru"));
  const part = (status: string, reason: "newer_version" | "corrupted", lastEvent: number) =>
    ({ status, topic: "Цена", partial: { reason, lastEvent } }) as unknown as HistoryItem;
  it("newer_version: message with number N, without «Discussion interrupted» and «Session runner stopped working»", () => {
    for (const st of ["interrupted", "running"]) {
      const h = html(midway, part(st, "newer_version", 42));
      expect(h).toContain("Сессия записана более новой версией приложения. Показано начало журнала до события №42.");
      expect(h).not.toContain("Обсуждение прервано");
      expect(h).not.toContain("Исполнитель сессии перестал работать");
      expect(h).toContain("нужна новая версия");
      expect(h).not.toContain("прервана");
    }
  });
  it("corrupted: «Journal damaged: showing the start up to event No. N»", () => {
    expect(html(midway, part("interrupted", "corrupted", 7))).toContain("Журнал повреждён: показано начало до события №7");
  });
  it("without partial there is no message", () => {
    const h = html(midway, item("interrupted"));
    expect(h).toContain("Обсуждение прервано");
    expect(h).not.toContain("более новой версией");
    expect(h).not.toContain("Журнал повреждён");
  });
  it("en", () => {
    setProcessLanguage("en");
    const h = html(midway, part("interrupted", "newer_version", 5));
    expect(h).toContain("The session was written by a newer version of the app.");
    expect(h).not.toContain("Discussion interrupted");
  });
});

describe("Session stop: flags belong to the segment", () => {
  const run = (acts: StopAction[]): StopMarks => acts.reduce(stopMarks, noStop);
  const resumed = (s: SessionState, n = 1): SessionState => ({ ...s, resumes: Array.from({ length: n }, () => s.resumes[0] ?? ({} as SessionState["resumes"][number])) });
  const discussion = (s: SessionState, m: StopMarks) => renderToStaticMarkup(
    <Discussion state={s} status="running" live={null} {...stopFlags(m, s.resumes.length)} id="s1"
      onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} onResult={noop} />,
  );
  const stopButton = (h: string) => h.match(/<button[^>]*class="btn btn--danger"[^>]*>.*?<\/button>/)![0];

  it("stop in segment 0, after continuation — «Stop» is available", () => {
    const m = run([{ type: "ask", segment: 0 }, { type: "confirm", segment: 0 }]);
    expect(stopFlags(m, 0)).toEqual({ confirming: false, stopping: true });
    expect(stopFlags(m, 1)).toEqual({ confirming: false, stopping: false });
    const b = stopButton(discussion(resumed(midway), m));
    expect(b).not.toContain("disabled");
    expect(b).toContain("Остановить");
    expect(b).not.toContain("Останавливаю…");
  });
  it("until stopSession has answered in the current segment the button is inactive «Stopping…»", () => {
    const b = stopButton(discussion(resumed(midway), run([{ type: "confirm", segment: 1 }])));
    expect(b).toContain('disabled=""');
    expect(b).toContain("Останавливаю…");
  });
  it("a confirmation that survived completion is closed after continuation", () => {
    const m = run([{ type: "ask", segment: 0 }]);
    expect(stopFlags(m, 0).confirming).toBe(true);
    expect(stopFlags(m, 1).confirming).toBe(false);
    expect(discussion(resumed(midway), m)).not.toContain("Остановить обсуждение?");
    expect(discussion(midway, m)).toContain("Остановить обсуждение?");
  });
  it("a stopSession refusal returns the button; a late refusal of the previous segment does not clear the new stop", () => {
    expect(stopFlags(run([{ type: "confirm", segment: 0 }, { type: "failed", segment: 0 }]), 0).stopping).toBe(false);
    expect(stopFlags(run([{ type: "confirm", segment: 0 }, { type: "confirm", segment: 1 }, { type: "failed", segment: 0 }]), 1).stopping).toBe(true);
  });
  it("cancel closes the confirmation", () => {
    expect(stopFlags(run([{ type: "ask", segment: 2 }, { type: "cancel", segment: 2 }]), 2).confirming).toBe(false);
  });
  it("wait panel of the continued session: «Continue», «Add reply», «Finish» are available", () => {
    const m = run([{ type: "ask", segment: 0 }, { type: "confirm", segment: 0 }]);
    const s: SessionState = { ...resumed(midway), waiting: { waitId: "w2", reasons: ["round_boundary"], questionIds: [], afterTurn: 2, startedAt: "2026-01-01T00:00:00Z", deadline: "2026-01-01T00:05:00Z" } };
    const h = renderToStaticMarkup(<WaitPanelView state={s} now={Date.parse("2026-01-01T00:01:00Z")} sending={false} error={null} {...stopFlags(m, 1)}
      onContinue={noop} onReply={noop} onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} />);
    const buttons = h.match(/<button[^>]*>[^<]*<\/button>/g)!;
    for (const word of ["Продолжить", "Добавить реплику", "Завершить"]) {
      const b = buttons.find((x) => x.includes(`>${word}<`))!;
      expect(b).toBeDefined();
      expect(b).not.toContain("disabled");
    }
    const old = renderToStaticMarkup(<WaitPanelView state={s} now={Date.parse("2026-01-01T00:01:00Z")} sending={false} error={null} {...stopFlags(m, 0)}
      onContinue={noop} onReply={noop} onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} />);
    for (const b of old.match(/<button[^>]*>/g)!) expect(b).toContain('disabled=""');
  });
});
