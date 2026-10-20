import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
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
import type { StoredStatus } from "@model-council/core";
import { Discussion } from "./Discussion.tsx";
import { saveDraft } from "./OwnerComposer.tsx";

const view = (state: SessionState, o: { status?: StoredStatus; confirming?: boolean; stopping?: boolean } = {}) =>
  renderToStaticMarkup(
    <Discussion state={state} status={o.status ?? "running"} live={null} confirming={o.confirming ?? false} stopping={o.stopping ?? false}
      onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} onResult={noop} />,
  );
const at = (h: string, s: string) => { const i = h.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
const fin = (status: "consensus" | "failed" | "stopped", reason?: string): Body =>
  ({ type: "session_finished", status, version: 1, agreed: ["p1"], objectors: [], ...(reason ? { reason } : {}) }) as Body;
const running = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2")]);

describe("Discussion: session in progress", () => {
  it("button, round counter, status, three sections", () => {
    const h = view(running);
    expect(h).toContain("Остановить");
    expect(h).toContain("круг 1 из 3");
    expect(h).toContain("идёт");
    for (const l of ["Участники", "Лента ходов", "Панель решения"]) expect(h).toContain(`aria-label="${l}"`);
    expect(h.match(/К итогу/g)).toHaveLength(1);
  });
  it("stop confirmation", () => {
    const h = view(running, { confirming: true });
    expect(h).toContain("Остановить обсуждение?");
    expect(h).toContain(">Остановить</button>");
    expect(h).toContain(">Продолжить</button>");
  });
  it("stop in progress: button unavailable", () => {
    const h = view(running, { stopping: true });
    expect(h).toContain("Останавливаю…");
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>.*Останавливаю…/);
  });
  it("long topic: full title", () => {
    const topic = "Очень длинная тема ".repeat(15).trim();
    expect(view(fold([created(3, topic)]))).toContain(`title="${topic}"`);
  });
  it("session of another process: «thinking» without a caption about the text stream", () => {
    const h = view(fold([created(3, "Цена", "cli"), started(1, "p1")]));
    expect(h).toContain("думает");
    expect(h).not.toContain("текст хода приходит по мере ответа");
  });
});

describe("Discussion: solution panel view per osen mockup — upper panel", () => {
  const btn = (h: string, label: string): string => h.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`))![0];
  it("in progress: «To summary» inactive, no primary, with a hint; «Stop» without btn--sm", () => {
    const h = view(running);
    const b = btn(h, "К итогу");
    expect(b).toContain("disabled");
    expect(b).toContain('title="итог появится после завершения"');
    expect(b).not.toContain("btn--primary");
    expect(b).not.toContain("data-tone");
    expect(btn(h, "Остановить")).toContain("btn btn--danger");
    expect(btn(h, "Остановить")).not.toContain("btn--sm");
    expect(h.indexOf("К итогу")).toBeLessThan(h.indexOf("Остановить"));
  });
  it("confirmation: «To summary» stays, buttons without btn--sm", () => {
    const h = view(running, { confirming: true });
    expect(btn(h, "К итогу")).toContain("disabled");
    const top = h.slice(h.indexOf("<header"), h.indexOf("</header>"));
    expect(top).not.toContain("btn--sm");
  });
  it("finished: «To summary» primary without btn--sm, active", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), fin("consensus")]);
    const top = (h => h.slice(h.indexOf("<header"), h.indexOf("</header>")))(view(s, { status: "consensus" }));
    expect(top).toContain('<button type="button" class="btn btn--primary">');
    expect(top).not.toContain("disabled");
  });
  it("en: hint in English", () => {
    setProcessLanguage("en");
    try { expect(view(running)).toContain('title="the result appears after the discussion ends"'); } finally { setProcessLanguage("ru"); }
  });
});

describe("Discussion: final status (feed after returning)", () => {
  it("agreement: «To summary» in the panel and an alert at the end of the feed, without «Stop»", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), fin("consensus")]);
    const h = view(s, { status: "consensus" });
    expect(h).not.toContain("Остановить");
    expect(h).toContain("согласие достигнуто");
    expect(h.match(/К итогу/g)).toHaveLength(2);
    expect(h).toContain('<div class="alert__title">Согласие достигнуто</div>');
    expect(h).toContain('<div class="alert" data-tone="info">');
    expect(h.match(/<button[^>]*btn--primary[^>]*>/g)!.filter((b) => b.includes("data-tone"))).toEqual([]);
    expect(h).not.toContain('data-tone="ok"');
    expect(h).toContain("приняли версию 1, открытых вопросов нет.");
    expect(at(h, "аргумент 1")).toBeLessThan(at(h, "alert__title"));
  });
  it("failure: reason in the alert", () => {
    const h = view(fold([created(), started(1, "p1"), fin("failed", "сломалось")]), { status: "failed" });
    expect(h).toContain("сломалось");
    expect(h).toContain('<div class="alert__title">Сбой</div>');
  });
  it("stopped: alert without text", () => {
    const h = view(fold([created(), fin("stopped")]), { status: "stopped" });
    expect(h).toContain('<div class="alert__title">Обсуждение остановлено</div>');
    expect(h).not.toContain("alert__text");
  });
});

describe("Discussion: viewing a session (from the old view)", () => {
  it("turns in order, position words, version", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1), started(3, "p3"), done(3, "p3", "agree", 1)]);
    const h = view(s);
    expect(at(h, "ход 1")).toBeLessThan(at(h, "ход 2"));
    expect(at(h, "ход 2")).toBeLessThan(at(h, "ход 3"));
    for (const w of ["правит", "согласен"]) expect(h).toContain(w);
    expect(h).toContain("версия 1");
    expect(h).toContain("текст v1");
  });
  it("departed participant", () => {
    const h = view(fold([created(), { type: "participant_dropped", participantId: "p3", reason: "таймаут" } as Body]));
    expect(h).toContain("participant--off");
    expect(h).toContain("таймаут");
  });
  it("question and answer", () => {
    const h = view(fold([
      created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p2", text: "Сколько?" }] }),
      started(2, "p2"), done(2, "p2", "agree", 1, { answers: [{ questionId: "q1", text: "Сто" }] }),
    ]));
    expect(h).toContain("вопрос q1 →");
    expect(h).toContain("Сколько?");
    expect(h).toContain("Сто");
  });
  it("escapes markup", () => {
    const h = view(fold([created(), started(1, "p1"), done(1, "p1", "agree", 1, { reasoning: "<script>alert(1)</script>" })]));
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain("<script>");
  });
});

describe("Discussion: version comparison", () => {
  const two = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2), started(3, "p3")]);
  const panel = (h: string) => h.slice(h.indexOf('<section class="session-col" aria-label="Панель решения"'));
  const toggleOff = /<input type="checkbox"(?![^>]*checked)(?![^>]*disabled)/;
  it("session in progress: switch is off", () => {
    expect(panel(view(two))).toMatch(toggleOff);
  });
  it("streaming text does not change the solution panel and is not marked up", () => {
    const withLive = (text: string) => renderToStaticMarkup(
      <Discussion state={two} status="running" live={{ turn: 3, attempt: 1, text }} confirming={false} stopping={false}
        onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} onResult={noop} />,
    );
    const hs = ["", "Пишу", "Пишу длиннее и ещё"].map(withLive);
    expect(new Set(hs.map(panel)).size).toBe(1);
    for (const h of hs) { expect(h).not.toContain("diff-add"); expect(h).not.toContain("diff-del"); }
  });
  it("completed session: switch is present and off", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2), fin("consensus")]);
    const h = panel(view(s, { status: "consensus" }));
    expect(h).toContain("Показать изменения");
    expect(h).toMatch(toggleOff);
  });
});

describe("Discussion: owner replies", () => {
  const owner = (text = "Уточняю", afterTurn = 2): Body => ({ type: "owner_message", id: "o1", text, afterTurn, requestId: "r1" } as unknown as Body);
  const ask = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "owner", text: "Формат?" }] }), started(2, "p2")]);
  const viewId = (state: SessionState, status: StoredStatus = "running", pending?: { requestId: string; text: string; answerTo: string | null }[]) =>
    renderToStaticMarkup(
      <Discussion state={state} status={status} live={null} confirming={false} stopping={false} id="s1" pending={pending}
        onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} onResult={noop} />,
    );
  it("in progress with an id: field, hint, pending items in the feed", () => {
    const h = viewId(running, "running", [{ requestId: "r9", text: "Жду применения", answerTo: null }]);
    expect(h).toContain("<textarea");
    expect(h).toContain("После реплики все участники подтверждают согласие заново");
    expect(h).toContain("Жду применения");
    expect(h).not.toContain("Сессия завершена: реплики");
  });
  it("a session from the terminal: the same", () => {
    const h = viewId(fold([created(3, "Цена", "cli"), started(1, "p1")]));
    expect(h).toContain("Реплика владельца");
  });
  it("without an id there is no field", () => expect(view(running)).not.toContain("session-composer"));
  it("open question to the owner: «Questions to you» block", () => {
    const h = viewId(ask);
    expect(h).toContain("Вопросы к вам");
    expect(h).toContain("Формат?");
    expect(h).toContain(">Ответить<");
    expect(h).toContain("ждёт ответа");
  });
  it("the answer to q1 is pending: the question is gone from the block, the second open one remains", () => {
    const two = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "owner", text: "Формат?" }, { id: "q2", to: "owner", text: "Срок?" }] }), started(2, "p2")]);
    const box = (h: string) => h.slice(h.indexOf("session-owner-box"));
    const h = box(viewId(two, "running", [{ requestId: "r9", text: "Таблица", answerTo: "q1" }]));
    expect(h).toContain("Вопросы к вам");
    expect(h).not.toContain("Формат?");
    expect(h).toContain("Срок?");
    expect(h.match(/>Ответить</g)).toHaveLength(1);
    expect(box(viewId(ask, "running", [{ requestId: "r9", text: "Таблица", answerTo: "q1" }]))).not.toContain("Вопросы к вам");
  });
  it("a pending reply without an answer does not change the block", () => {
    const h = viewId(ask, "running", [{ requestId: "r9", text: "Просто реплика", answerTo: null }]);
    expect(h).toContain("Вопросы к вам");
    expect(h).toContain(">Ответить<");
  });
  it("completed with a reply: caption, no field, questions and pending items", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), owner(), fin("stopped")]);
    const h = viewId(s, "stopped", [{ requestId: "r9", text: "Ожидающая", answerTo: null }]);
    expect(h).toContain("Сессия завершена: реплики и ответы не принимаются");
    expect(h).not.toContain("<textarea");
    expect(h).not.toContain(">Ответить<");
    expect(h).not.toContain("Ожидающая");
  });
  it("interrupted with an open question: no field, caption present", () => {
    const h = viewId(ask, "interrupted");
    expect(h).not.toContain("<textarea");
    expect(h).not.toContain("Вопросы к вам");
    expect(h).toContain("Сессия завершена: реплики и ответы не принимаются");
  });
  it("completed without replies and questions: no blocks, markup same as without an id", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), fin("consensus")]);
    const h = viewId(s, "consensus");
    expect(h).not.toContain("session-owner-box");
    expect(h).not.toContain("session-composer");
    expect(h).toBe(view(s, { status: "consensus" }));
  });
});

describe("Discussion: owner wait", () => {
  const waiting: SessionState = { ...running, waiting: {
    waitId: "w1", reasons: ["round_boundary", "owner_question"], questionIds: ["q3"], afterTurn: 7,
    deadline: "2026-10-09T07:46:32Z", startedAt: "2026-10-09T07:42:00Z",
  } };
  const html = (state: SessionState, status: StoredStatus = "running", id: string | undefined = "s1") => renderToStaticMarkup(
    <Discussion state={state} id={id} status={status} live={null} confirming={false} stopping={false}
      onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} onResult={noop} />,
  );
  it("in progress with a wait: panel above the reply field", () => {
    const h = html(waiting);
    expect(h).toContain('aria-label="Ожидание владельца"');
    expect(h).toContain("Ждём владельца");
    expect(h).toContain("Реплика владельца");
    expect(h).toContain("<textarea");
    expect(at(h, 'class="session-wait"')).toBeLessThan(at(h, 'class="session-owner-box"'));
  });
  it("stop confirmation during a wait asks only the panel", () => {
    const h = renderToStaticMarkup(
      <Discussion state={waiting} id="s1" status="running" live={null} confirming stopping={false}
        onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} onResult={noop} />,
    );
    expect(h).toContain("Завершить обсуждение?");
    expect(h).not.toContain("Остановить обсуждение?");
    expect(h.match(/>Продолжить</g)).toHaveLength(1); // only clearing the wait, without the «Continue» of cancelling the stop
  });
  it("without a wait the footer is as before; without an id the panel is not shown", () => {
    expect(html(running)).not.toContain('class="session-wait"');
    expect(html(running)).toContain("<textarea");
    expect(view(waiting)).not.toContain('class="session-wait"');
  });
  it("interrupted with a wait: reference block without wait actions and field", () => {
    const h = html(waiting, "interrupted");
    expect(h).toContain("Прервано во время ожидания владельца");
    expect(h).not.toContain("<textarea");
    for (const text of ["Продолжить", "Добавить реплику", "Завершить"]) expect(h).not.toMatch(new RegExp(`>${text}</button>`));
    expect(h).not.toContain('class="session-wait"');
  });
  it("reference block above the caption about a completed session, without a wait there is no block", () => {
    const s = { ...waiting, questions: [{ id: "q3", from: "p1", to: "owner", text: "Формат?", turn: 7, status: "open" as const, answer: null }] };
    const h = html(s, "interrupted");
    expect(at(h, "Прервано во время ожидания владельца")).toBeLessThan(at(h, "Сессия завершена: реплики"));
    expect(html({ ...s, waiting: null }, "interrupted")).not.toContain("Прервано во время ожидания владельца");
  });
});

describe("Discussion: deleted reply requests", () => {
  const withDropped = (dropped: string[] | null, state = running) =>
    renderToStaticMarkup(
      <Discussion state={state} status="running" live={null} confirming={false} stopping={false}
        onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} onResult={noop} dropped={dropped} onDroppedClose={noop} />,
    );
  it("message above the feed: after the column heading, before the turn list", () => {
    const h = withDropped(["уточнение: экспорт идёт в 03:00"]);
    expect(h).toContain("Удалён 1 запрос реплики");
    expect(h).toContain("уточнение: экспорт идёт в 03:00");
    expect(at(h, "Лента ходов")).toBeLessThan(at(h, "feed-dropped"));
    expect(at(h, "feed-dropped")).toBeLessThan(at(h, "session-feed"));
  });
  it("empty list or null — no message", () => {
    expect(withDropped([])).not.toContain("feed-dropped");
    expect(withDropped(null)).not.toContain("feed-dropped");
  });
});

const capCreated = (cap?: number): Body => {
  const c = created() as Extract<Body, { type: "session_created" }>;
  return cap === undefined ? c : { ...c, session: { ...c.session, limits: { ...c.session.limits, maxTotalTokens: cap } } };
};
const tok = (turn: number, id: string, usage: { inputTokens?: number; outputTokens?: number }): Body =>
  ({ ...done(turn, id, "amend", turn), usage }) as Body;

describe("Discussion: token ceiling", () => {
  const stopped = (usage: { inputTokens?: number }, extra: Body[] = []) =>
    fold([capCreated(1200), started(1, "p1"), tok(1, "p1", usage), ...extra, fin("stopped", "token_cap")]);
  it("stop by the ceiling: badge, alert and «To summary»", () => {
    const h = view(stopped({ inputTokens: 1500 }), { status: "stopped" });
    expect(h).toContain("остановлена · потолок токенов");
    expect(h).toContain('<div class="alert__title">Остановлена · потолок токенов</div>');
    expect(h).toContain("Израсходовано 1500 из 1200 токенов.");
    expect(h).not.toContain("Учёт неполный.");
    expect(h).toContain('data-tone="warn"');
    expect(h).toContain("К итогу");
  });
  it("«of CAP» inflects by the ceiling: «Used 21 of 21 tokens.»", () => {
    const h = view(fold([capCreated(21), started(1, "p1"), tok(1, "p1", { inputTokens: 21 }), fin("stopped", "token_cap")]), { status: "stopped" });
    expect(h).toContain("Израсходовано 21 из 21 токена.");
  });
  it("incomplete accounting", () => {
    const h = view(stopped({ inputTokens: 1500 }, [started(2, "p2"), done(2, "p2", "amend", 2)]), { status: "stopped" });
    expect(h).toContain("Израсходовано 1500 из 1200 токенов. Учёт неполный.");
  });
  it("stop by the owner: no words about the ceiling", () => {
    const h = view(fold([capCreated(1200), started(1, "p1"), tok(1, "p1", { inputTokens: 5 }), fin("stopped")]), { status: "stopped" });
    expect(h).toContain("остановлена");
    expect(h).toContain('<div class="alert__title">Обсуждение остановлено</div>');
    expect(h).not.toContain("потолок");
  });
  it("session in progress with a ceiling: bar present, no alert", () => {
    const h = view(fold([capCreated(1200), started(1, "p1"), tok(1, "p1", { inputTokens: 500 })]));
    expect(h).toContain('<span class="mono">500 из 1200</span> токенов');
    expect(h).not.toContain("alert__title");
  });
});

describe("Discussion: draft phase failure", () => {
  const c = created() as Extract<Body, { type: "session_created" }>;
  const head: Body = { ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId: "p2" } } };
  it("synthesizer_unavailable: synthesizer name, without code", () => {
    const h = view(fold([head, fin("failed", "synthesizer_unavailable")]), { status: "failed" });
    expect(h).toContain("Синтезатор «Имя2» выбыл, не создав версию 1.");
    expect(h).not.toContain("synthesizer_unavailable");
  });
  it("draft_context_limit: text about the context limit", () => {
    const h = view(fold([head, fin("failed", "draft_context_limit")]), { status: "failed" });
    expect(h).toContain("превысил лимит контекста");
    expect(h).not.toContain("draft_context_limit");
  });
});

describe("Discussion: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = <T,>(f: () => T): T => { setProcessLanguage("en"); return f(); };
  const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]).join(",");
  const fin2 = (status: string): Body => ({ type: "session_finished", status, version: 1, agreed: ["p1"], objectors: [] }) as unknown as Body;
  const base = [created(), started(1, "p1"), done(1, "p1", "amend", 1)];

  it("in progress: button, confirmation, stop", () => {
    const h = en(() => view(running));
    expect(h).toContain(">Stop<");
    expect(h).toContain("round 1 of 3");
    expect(h).not.toContain("К итогу");
    const c = en(() => view(running, { confirming: true }));
    expect(c).toContain("Stop the discussion?");
    expect(c).toContain(">Stop</button>");
    expect(c).toContain(">Continue</button>");
    expect(en(() => view(running, { stopping: true }))).toContain("Stopping…");
  });
  it("five statuses: alert heading and «To summary»", () => {
    const titles: [string, string][] = [["consensus", "Consensus reached"], ["no_consensus", "No consensus"], ["stopped", "Discussion stopped"], ["failed", "Failure"], ["interrupted", "Discussion interrupted"]];
    for (const [st, title] of titles) {
      const h = en(() => view(fold([...base, fin2(st)]), { status: st as never }));
      expect(h).toContain(`<div class="alert__title">${title}</div>`);
      expect(h.match(/To the result/g)).toHaveLength(2);
    }
    expect(en(() => view(fold([...base, fin2("consensus")]), { status: "consensus" }))).toContain("All active participants accepted version 1; there are no open questions.");
    expect(en(() => view(fold([...base, fin("failed", "сломалось")]), { status: "failed" }))).toContain("сломалось");
  });
  it("token ceiling: heading, text, incomplete accounting", () => {
    const cc = (cap: number): Body => { const c = created() as Extract<Body, { type: "session_created" }>; return { ...c, session: { ...c.session, limits: { ...c.session.limits, maxTotalTokens: cap } } }; };
    const tk = (usage: { inputTokens?: number }): Body => ({ ...done(1, "p1", "amend", 1), usage }) as Body;
    const h = en(() => view(fold([cc(1200), started(1, "p1"), tk({ inputTokens: 1500 }), fin("stopped", "token_cap")]), { status: "stopped" }));
    expect(h).toContain('<div class="alert__title">Stopped · token cap</div>');
    expect(h).toContain("1500 of 1200 tokens spent.");
    expect(h).toContain("stopped · token cap");
    const inc = en(() => view(fold([cc(1200), started(1, "p1"), tk({ inputTokens: 1500 }), started(2, "p2"), done(2, "p2", "amend", 2), fin("stopped", "token_cap")]), { status: "stopped" }));
    expect(inc).toContain("1500 of 1200 tokens spent. The count is incomplete.");
  });
  it("completed with replies: caption about the closed session", () => {
    const own = { type: "owner_message", id: "o1", text: "Р", afterTurn: 1, requestId: "r1" } as unknown as Body;
    const h = en(() => view(fold([...base, own, fin2("stopped")]), { status: "stopped" }));
    expect(h).toContain("The session has ended: messages and answers are not accepted");
  });
  it("the lineup does not depend on the language", () => {
    const cases: [SessionState, Parameters<typeof view>[1]][] = [
      [running, {}], [running, { confirming: true }], [running, { stopping: true }],
      [fold([...base, fin2("consensus")]), { status: "consensus" }],
      [fold([...base, fin("failed", "x")]), { status: "failed" }],
    ];
    for (const [s, o] of cases) {
      const e = en(() => view(s, o));
      setProcessLanguage("ru");
      expect(tags(e)).toBe(tags(view(s, o)));
    }
  });
});

describe("Discussion: journal read only partially", () => {
  const partial = { reason: "newer_version" as const, lastEvent: 9 };
  const html = (state: SessionState, p: typeof partial | null, status: StoredStatus = "running") => renderToStaticMarkup(
    <Discussion state={state} id="s1" status={status} partial={p} live={null} confirming={false} stopping={false}
      onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} onResult={noop} />);
  it("reply field inactive with a reason, «Stop» active", () => {
    const h = html(running, partial);
    expect(h).toContain("до события №9");
    expect(h).toMatch(/<textarea[^>]*disabled/);
    expect(h).toMatch(/<button type="submit"[^>]*disabled/);
    expect(h).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Остановить/);
    expect(h).toContain("Остановить");
  });
  it("without partial the field is active", () => {
    const h = html(running, null);
    expect(h).not.toMatch(/<textarea[^>]*disabled/);
    expect(h).not.toContain("до события");
  });
  it("interrupted with a wait: no wait note and «Discussion interrupted», without partial the note is present", () => {
    const waiting: SessionState = { ...running, waiting: { waitId: "w1", reasons: ["round_boundary"], questionIds: [], afterTurn: 7, deadline: "2026-10-09T07:46:32Z", startedAt: "2026-10-09T07:42:00Z" } };
    const h = html(waiting, partial, "interrupted");
    expect(h).not.toContain("Прервано во время ожидания владельца");
    expect(h).not.toContain("Обсуждение прервано");
    expect(h).toContain('role="status"');
    expect(html(waiting, null, "interrupted")).toContain("Прервано во время ожидания владельца");
  });
});

describe("Discussion: finished session with an unfinished owner message", () => {
  const draftId = "s1";
  afterEach(() => saveDraft(draftId, null));
  const finishedView = (s: SessionState, status: StoredStatus = "consensus") => renderToStaticMarkup(
    <Discussion state={s} status={status} live={null} confirming={false} stopping={false} id={draftId}
      onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} onResult={noop} />,
  );
  const ended = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), fin("consensus")]);
  const ownerMsg: Body = { type: "owner_message", id: "o1", text: "Уточняю", afterTurn: 2, requestId: "r1" } as unknown as Body;
  const endedWithReply = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), ownerMsg, fin("consensus")]);

  it("draft field instead of the caption; the tail with the result button stays", () => {
    saveDraft(draftId, { text: "Ещё учтите бюджет", answerTo: null });
    const h = finishedView(endedWithReply);
    expect(h).toContain(">Ещё учтите бюджет</textarea>");
    expect(h).not.toContain("Сессия завершена: реплики");
    expect(h).not.toContain(">Отправить<");
    expect(h).toContain("К итогу");
  });
  it("blank draft: the old behaviour, caption only with owner messages", () => {
    saveDraft(draftId, { text: "   ", answerTo: null });
    expect(finishedView(endedWithReply)).toContain("Сессия завершена: реплики");
    expect(finishedView(endedWithReply)).not.toContain("<textarea");
    expect(finishedView(ended)).not.toContain("<textarea");
  });
});
