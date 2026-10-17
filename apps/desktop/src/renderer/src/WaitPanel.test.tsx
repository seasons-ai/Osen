import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { LanguageProvider } from "./language.tsx";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionState } from "@model-council/core/protocol";
import { formatWhen } from "./History.tsx";
import { WaitInterruptedNote, WaitPanelView, formatDeadline, formatLeft, submitWait, waitReasons } from "./WaitPanel.tsx";
import type { WaitPanelViewProps } from "./WaitPanel.tsx";

const now = Date.parse("2026-10-09T07:42:00Z");
const state = (o: Partial<NonNullable<SessionState["waiting"]>> = {}): SessionState => ({
  ...foldEvents([]), round: 2,
  waiting: { waitId: "w1", reasons: ["round_boundary", "owner_question"], questionIds: ["q3"], afterTurn: 7,
    startedAt: "2026-10-09T07:42:00Z", deadline: "2026-10-09T07:46:32Z", ...o },
});
const noop = () => {};
const props = (o: Partial<WaitPanelViewProps> = {}): WaitPanelViewProps => ({
  state: state(), now, sending: false, error: null, confirming: false, stopping: false,
  onContinue: noop, onReply: noop, onStopAsk: noop, onStopCancel: noop, onStopConfirm: noop, ...o,
});
const view = (o: Partial<WaitPanelViewProps> = {}) => renderToStaticMarkup(<WaitPanelView {...props(o)} />);
type Props = { children?: ReactNode; [key: string]: unknown };
function find(n: ReactNode, pred: (p: Props) => boolean, out: Props[] = []): Props[] {
  if (Array.isArray(n)) n.forEach((c) => find(c, pred, out));
  else if (n && typeof n === "object" && "type" in n) {
    const el = n as ReactElement<Props>;
    if (pred(el.props)) out.push(el.props);
    find(el.props.children, pred, out);
  }
  return out;
}
// The view calls language hooks: a direct function call is only possible inside rendering.
function inRender(f: () => ReactNode): ReactNode {
  let out: ReactNode = null;
  const Probe = (): null => { out = f(); return null; };
  renderToStaticMarkup(<Probe />);
  return out;
}
const button = (t: ReactNode, word: string) => find(t, (p) => p.children === word && "onClick" in p)[0]!;

describe("Wait reasons", () => {
  it("pause uses the round of the last started turn", () => {
    expect(waitReasons(state({ reasons: ["round_boundary"] }))).toEqual(["Пауза после круга 2"]);
  });
  it("one question and two questions", () => {
    expect(waitReasons(state({ reasons: ["owner_question"], questionIds: ["q1"] }))).toEqual(["Ждём ваш ответ на вопрос q1"]);
    expect(waitReasons(state({ reasons: ["owner_question"], questionIds: ["q1", "q2"] }))).toEqual(["Ждём ваши ответы на вопросы q1, q2"]);
  });
  it("two reasons keep their order, without a wait the list is empty", () => {
    expect(waitReasons(state())).toEqual(["Пауза после круга 2", "Ждём ваш ответ на вопрос q3"]);
    expect(waitReasons(state({ reasons: ["owner_question", "round_boundary"] }))).toEqual(["Ждём ваш ответ на вопрос q3", "Пауза после круга 2"]);
    expect(waitReasons({ ...state(), waiting: null })).toEqual([]);
  });
});

describe("Time remaining", () => {
  it.each([[0, "0:00"], [-1000, "0:00"], [59000, "0:59"], [272000, "4:32"], [3600000, "1:00:00"], [3932000, "1:05:32"], [1, "0:01"]])("%s ms → %s", (ms, text) => {
    expect(formatLeft(ms as number)).toBe(text);
  });
});

describe("formatDeadline", () => {
  it("today's deadline — time with seconds, another day — date and time as in «History»", () => {
    const today = new Date(2026, 9, 9, 10, 0, 0);
    expect(formatDeadline(new Date(2026, 9, 9, 17, 7, 3).toISOString(), today)).toBe("17:07:03");
    const next = new Date(2026, 9, 10, 0, 5, 0).toISOString();
    expect(formatDeadline(next, today)).toBe(formatWhen(next, today));
  });
});

describe("Wait panel", () => {
  it("heading, icon, reasons, timer, two explanations and three actions", () => {
    const h = view();
    expect(h).toContain('class="session-wait" aria-label="Ожидание владельца" data-tone="warn"');
    for (const text of ["Ждём владельца", "#i-clock", "Пауза после круга 2", "Ждём ваш ответ на вопрос q3", "Продолжить", "Добавить реплику", "Завершить"]) expect(h).toContain(text);
    expect(h).toContain('class="session-wait__left mono" role="timer">осталось 4:32');
    expect(h).toContain(`Участники не вызываются. Срок — до ${formatDeadline(state().waiting!.deadline, new Date(now))}: потом обсуждение продолжится само, вопросы без ответа останутся без ответа. Реплика обсуждение не возобновляет — для этого нажмите «Продолжить».`);
    expect(h.match(/<button /g)).toHaveLength(3);
  });
  it("only a question: no pause hint; deadline passed: remainder zero, the panel stays", () => {
    expect(view({ state: state({ reasons: ["owner_question"] }) })).not.toContain("Реплика обсуждение не возобновляет");
    const round = view({ state: state({ reasons: ["round_boundary"], questionIds: [] }) });
    expect(round).toContain("потом обсуждение продолжится само. Реплика обсуждение не возобновляет");
    expect(round).not.toContain("вопросы без ответа");
    expect(view({ now: now + 300000 })).toContain("осталось 0:00");
    expect(view({ state: { ...state(), waiting: null } })).toBe("");
  });
  it("request sent: «Continuing…» unavailable", () => {
    const h = view({ sending: true });
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>Продолжаю…<\/button>/);
    expect(button(inRender(() => WaitPanelView(props({ sending: true }))), "Добавить реплику").disabled).toBe(false);
  });
  it("refusal: ready text in an alert with danger tone and icon", () => {
    const h = view({ error: "Сессия s1: ожидание w1 уже снято, текущее — w2." });
    expect(h).toMatch(/class="session-wait__error" data-tone="danger" role="alert"><svg[^>]*><use href="#i-alert"/);
    expect(h).toContain("Сессия s1: ожидание w1 уже снято, текущее — w2.");
    expect(view({ error: "<b>ошибка</b>" })).toContain("&lt;b&gt;ошибка&lt;/b&gt;");
  });
  it("actions pass clicks to the existing handlers", () => {
    const onContinue = vi.fn(), onReply = vi.fn(), onStopAsk = vi.fn();
    const t = inRender(() => WaitPanelView(props({ onContinue, onReply, onStopAsk })));
    for (const word of ["Продолжить", "Добавить реплику", "Завершить"]) (button(t, word).onClick as () => void)();
    for (const call of [onContinue, onReply, onStopAsk]) expect(call).toHaveBeenCalledOnce();
  });
  it("confirmation: question, «Finish» and «Cancel» use the stop handlers", () => {
    const onStopConfirm = vi.fn(), onStopCancel = vi.fn(), onStopAsk = vi.fn();
    const t = inRender(() => WaitPanelView(props({ confirming: true, onStopConfirm, onStopCancel, onStopAsk })));
    expect(view({ confirming: true })).toContain("Завершить обсуждение?");
    expect(view({ confirming: true })).toContain("btn btn--ghost btn--sm");
    (button(t, "Завершить").onClick as () => void)();
    (button(t, "Отмена").onClick as () => void)();
    expect(onStopConfirm).toHaveBeenCalledOnce(); expect(onStopCancel).toHaveBeenCalledOnce(); expect(onStopAsk).not.toHaveBeenCalled();
  });
  it.each([false, true])("stop: all actions unavailable, confirmation %s", (confirming) => {
    const buttons = view({ stopping: true, confirming }).match(/<button[^>]*>/g)!;
    expect(buttons).toHaveLength(confirming ? 4 : 3);
    for (const b of buttons) expect(b).toContain('disabled=""');
  });
});

describe("One-time continuation of the wait", () => {
  it("double click and a retry after success give one call", async () => {
    let release!: (r: { requestId: string }) => void;
    const call = vi.fn(() => new Promise<{ requestId: string }>((resolve) => { release = resolve; }));
    const guard = { current: { waitId: "w1", sent: false } };
    const first = submitWait(call, "s1", "w1", guard);
    expect(await submitWait(call, "s1", "w1", guard)).toBeNull();
    release({ requestId: "r1" });
    expect(await first).toEqual({ ok: true });
    expect(await submitWait(call, "s1", "w1", guard)).toBeNull();
    expect(call).toHaveBeenCalledExactlyOnceWith("s1", "w1");
  });
  it("refusal returns the error text, a retry is possible", async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error("Ожидание w1 уже снято")).mockResolvedValue({ requestId: "r2" });
    const guard = { current: { waitId: "w1", sent: false } };
    expect(await submitWait(call, "s1", "w1", guard)).toEqual({ ok: false, error: "Ожидание w1 уже снято" });
    expect(guard.current.sent).toBe(false);
    expect(await submitWait(call, "s1", "w1", guard)).toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("a new waitId resets the lock, a late refusal of the old request does not clear it", async () => {
    let reject!: (e: Error) => void;
    const call = vi.fn().mockImplementationOnce(() => new Promise((_, no) => { reject = no; })).mockResolvedValue({ requestId: "r2" });
    const guard = { current: { waitId: "w1", sent: false } };
    const first = submitWait(call, "s1", "w1", guard);
    expect(await submitWait(call, "s1", "w2", guard)).toEqual({ ok: true });
    reject(new Error("Отказ старому запросу"));
    await first;
    expect(await submitWait(call, "s1", "w2", guard)).toBeNull();
    expect(call.mock.calls).toEqual([["s1", "w1"], ["s1", "w2"]]);
    expect(await submitWait(call, "s1", "w3", guard)).toEqual({ ok: true });
  });
});

describe("Interrupted during the wait", () => {
  it("reference block: reasons, previous deadline, without buttons and timer", () => {
    const s = state();
    const h = renderToStaticMarkup(<WaitInterruptedNote state={s} />);
    expect(h).toContain('class="alert" data-tone="muted"');
    expect(h).toContain("#i-clock");
    expect(h).toContain("Прервано во время ожидания владельца");
    expect(h).toContain("Пауза после круга 2; Ждём ваш ответ на вопрос q3");
    expect(h).toContain(`Срок ожидания — до ${formatDeadline(s.waiting!.deadline, new Date())}.`);
    expect(h).toContain("После «Продолжить обсуждение» ожидание продлится до того же срока, новый срок не начнётся.");
    expect(h).not.toContain("<button"); expect(h).not.toContain('role="timer"');
  });
  it("without a wait the block is not shown", () => {
    expect(renderToStaticMarkup(<WaitInterruptedNote state={{ ...state(), waiting: null }} />)).toBe("");
  });
});

describe("Wait panel: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = <T,>(f: () => T): T => { setProcessLanguage("en"); return f(); };
  const cyr = /[А-Яа-яЁё]/;

  it("wait reasons", () => {
    expect(en(() => waitReasons(state({ reasons: ["round_boundary"] }), "en"))).toEqual(["Pause after round 2"]);
    expect(waitReasons(state({ reasons: ["owner_question"], questionIds: ["q1"] }), "en")).toEqual(["Waiting for your answer to question q1"]);
    expect(waitReasons(state({ reasons: ["owner_question"], questionIds: ["q1", "q2"] }), "en")).toEqual(["Waiting for your answers to questions q1, q2"]);
    expect(waitReasons(state(), "en")).toEqual(["Pause after round 2", "Waiting for your answer to question q3"]);
    expect(waitReasons(state(), "ru")).toEqual(["Пауза после круга 2", "Ждём ваш ответ на вопрос q3"]);
  });
  it("panel: heading, remainder, both caveats, buttons", () => {
    const h = en(() => view());
    expect(h).toContain('aria-label="Waiting for the owner"');
    expect(h).toContain(">Waiting for the owner</h2>");
    expect(h).toContain('role="timer">4:32 left');
    expect(h).toContain(`Participants are not being called. The deadline is ${formatDeadline(state().waiting!.deadline, new Date(now), "en")}: after that the discussion continues on its own, and unanswered questions stay unanswered. A message does not resume the discussion — press “Continue” for that.`);
    for (const t of [">Continue<", ">Add a message<", ">End<"]) expect(h).toContain(t);
    expect(h).not.toMatch(cyr);
    const round = en(() => view({ state: state({ reasons: ["round_boundary"], questionIds: [] }) }));
    expect(round).toContain("on its own. A message does not resume");
    expect(round).not.toContain("unanswered");
    expect(en(() => view({ state: state({ reasons: ["owner_question"] }) }))).not.toContain("A message does not resume");
  });
  it("sending and confirming completion", () => {
    expect(en(() => view({ sending: true }))).toMatch(/<button[^>]*disabled=""[^>]*>Continuing…<\/button>/);
    const h = en(() => view({ confirming: true }));
    for (const t of ["End the discussion?", ">End<", ">Cancel<"]) expect(h).toContain(t);
    expect(h).not.toMatch(cyr);
  });
  it("block «Interrupted during the owner's wait»", () => {
    const s = state();
    const h = en(() => renderToStaticMarkup(<WaitInterruptedNote state={s} />));
    expect(h).toContain("Interrupted while waiting for the owner");
    expect(h).toContain(`Pause after round 2; Waiting for your answer to question q3. The wait deadline is ${formatDeadline(s.waiting!.deadline, new Date(), "en")}. After “Continue discussion” the wait runs until the same deadline; a new one does not start.`);
    expect(h).not.toMatch(cyr);
  });

  describe("deadline and remainder", () => {
    const today = new Date(2026, 9, 9, 10, 0, 0);
    it("today's deadline — time with seconds", () => {
      const iso = new Date(2026, 9, 9, 18, 3, 9).toISOString();
      expect(formatDeadline(iso, today, "ru")).toBe("18:03:09");
      expect(formatDeadline(iso, today, "en")).toBe("6:03:09 PM");
      const early = new Date(2026, 9, 9, 7, 7, 3).toISOString();
      expect(formatDeadline(early, today, "ru")).toBe("07:07:03");
      expect(formatDeadline(early, today, "en")).toBe("7:07:03 AM");
    });
    it.each(["en", "ru"] as Language[])("another day matches formatWhen (%s)", (language) => {
      const next = new Date(2026, 9, 10, 0, 5, 0).toISOString();
      expect(formatDeadline(next, today, language)).toBe(formatWhen(next, today, language));
    });
    it("remainder m:ss is the same in both languages", () => {
      for (const [ms, text] of [[0, "0:00"], [272000, "4:32"], [3932000, "1:05:32"]] as const) {
        const w = state({ deadline: new Date(now + ms).toISOString() });
        expect(en(() => view({ state: w }))).toContain(`${text} left`);
        setProcessLanguage("ru");
        expect(view({ state: w })).toContain(`осталось ${text}`);
      }
      expect(en(() => view({ now: now + 300000 }))).toContain("0:00 left");
    });
  });

  it("the same properties in two languages: the panel state is the same, labels differ", () => {
    const p = props({ error: "Отказ моста: ожидание w1 снято", confirming: true });
    const e = en(() => renderToStaticMarkup(<WaitPanelView {...p} />));
    setProcessLanguage("ru");
    const r = renderToStaticMarkup(<WaitPanelView {...p} />);
    for (const h of [e, r]) expect(h).toContain("Отказ моста: ожидание w1 снято");
    expect(e).toContain("End the discussion?"); expect(r).toContain("Завершить обсуждение?");
  });
  it("language from the context when the process language is ru", () => {
    const ctx = (language: Language) => renderToStaticMarkup(
      <LanguageProvider initial={{ language, source: "file", locked: false }}><WaitPanelView {...props()} /></LanguageProvider>,
    );
    expect(ctx("en")).toContain("Waiting for the owner");
    expect(ctx("en")).toContain("4:32 left");
    expect(ctx("ru")).toContain("Ждём владельца");
    expect(ctx("ru")).toContain("осталось 4:32");
    const note = (language: Language) => renderToStaticMarkup(
      <LanguageProvider initial={{ language, source: "file", locked: false }}><WaitInterruptedNote state={state()} /></LanguageProvider>,
    );
    expect(note("en")).toContain("Interrupted while waiting for the owner");
    expect(note("ru")).toContain("Прервано во время ожидания владельца");
  });
  it("the lineup does not depend on the language", () => {
    const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]).join(",");
    const variants = [props(), props({ confirming: true }), props({ sending: true, error: "x" }), props({ state: state({ reasons: ["round_boundary"], questionIds: [] }) })];
    for (const p of variants) {
      const e = en(() => renderToStaticMarkup(<WaitPanelView {...p} />));
      setProcessLanguage("ru");
      expect(tags(e)).toBe(tags(renderToStaticMarkup(<WaitPanelView {...p} />)));
    }
    const n = en(() => renderToStaticMarkup(<WaitInterruptedNote state={state()} />));
    setProcessLanguage("ru");
    expect(tags(n)).toBe(tags(renderToStaticMarkup(<WaitInterruptedNote state={state()} />)));
  });
});

describe("WaitPanelView: journal read only partially", () => {
  it("the wait cannot be cleared, the reason is the same; «Finish» is active", () => {
    const h = view({ blocked: "Журнал повреждён: показано начало до события №3" });
    expect(h).toContain("Журнал повреждён: показано начало до события №3");
    expect(h).toMatch(/<button[^>]*disabled[^>]*>Продолжить</);
    expect(h).toMatch(/<button[^>]*disabled[^>]*>Добавить реплику</);
    expect(h).not.toMatch(/<button[^>]*disabled[^>]*>Завершить</);
  });
  it("without a reason everything is available", () => {
    expect(view()).not.toMatch(/<button[^>]*disabled[^>]*>Продолжить</);
  });
});
