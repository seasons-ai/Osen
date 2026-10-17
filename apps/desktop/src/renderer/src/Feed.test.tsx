import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { feed } from "../../shared/messages/session-feed.ts";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent, SessionState } from "@model-council/core/protocol";
import { DroppedNotice, FeedView, ResumedMark, isAtBottom, liveReasoning, liveTextFor } from "./Feed.tsx";
import type { LiveText } from "../../shared/bridge.ts";
import { formatWhen } from "./History.tsx";
import type { WaitExpiry } from "../../shared/timeline.ts";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const mk = (bodies: Body[]): SessionEvent[] => bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);

const created = (n = 3): Body => ({
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Цена", templateId: null, framing: "",
    participants: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Имя${i + 1}`, providerId: "scripted", model: `мод${i + 1}`, role: null })),
    limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 },
  },
});
const started = (turn: number, participantId: string, round = 1): Body => ({ type: "turn_started", turn, round, participantId });
const done = (
  turn: number, participantId: string, stance: "amend" | "agree" | "object", version: number,
  extra: { round?: number; reasoning?: string; questions?: { id: string; to: string; text: string }[]; answers?: { questionId: string; text: string }[] } = {},
): Body => ({
  type: "turn_completed", turn, round: extra.round ?? 1, participantId, stance, normalized: false, reasoning: extra.reasoning ?? `аргумент ${turn}`,
  solution: stance === "amend" ? `текст v${version}` : null, version,
  questions: extra.questions ?? [], answers: extra.answers ?? [], attempts: 1, usage: {}, durationMs: 5,
});
const failed = (turn: number, participantId: string, attempt: number, kind: "timeout" | "call_error" | "invalid_response", message: string): Body =>
  ({ type: "turn_failed", turn, round: 1, participantId, attempt, kind, message });
const drop = (id: string): Body => ({ type: "participant_dropped", participantId: id, reason: "таймаут ответа" });

const fold = (bodies: Body[]) => foldEvents(mk(bodies));
const view = (s: SessionState, o: { running?: boolean; live?: LiveText | null; unseen?: number; tail?: React.ReactNode; pending?: { requestId: string; text: string; answerTo: string | null }[]; footer?: React.ReactNode; expired?: readonly WaitExpiry[] } = {}) =>
  renderToStaticMarkup(<FeedView state={s} running={o.running ?? true} live={o.live ?? null} unseen={o.unseen ?? 0} onJump={() => {}} tail={o.tail} pending={o.pending} footer={o.footer} expired={o.expired} />);

describe("FeedView: files read", () => {
  const withFiles = (names: string[] | undefined): Body[] => {
    const d = done(1, "p1", "amend", 1);
    return [created(), started(1, "p1"), names ? { ...d, filesRead: names.map((name) => ({ name, chars: 100, shown: 100 })) } as Body : d];
  };
  it("monospace line «read: …» under the text, no counter chip in the header", () => {
    const h = view(fold(withFiles(["proj/src/a.ts", "proj/docs/b.md"])), { running: false });
    expect(h).not.toContain("прочитал файлов");
    expect(h).toContain('<span class="mono muted session-turn__read">прочитал: proj/src/a.ts, proj/docs/b.md</span>');
    expect(h.indexOf("аргумент 1")).toBeLessThan(h.indexOf("прочитал:"));
  });
  it("without filesRead there is nothing", () => {
    const h = view(fold(withFiles(undefined)), { running: false });
    expect(h).not.toContain("прочитал файлов");
    expect(h).not.toContain("прочитал:");
  });
  it("the file name is escaped", () => {
    const h = view(fold(withFiles(["<script>x</script>"])), { running: false });
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;x");
  });
});

describe("FeedView: turns", () => {
  it("amend: arguments and «version 2», order as in the turns", () => {
    const h = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2, { reasoning: "правлю" })]), { running: false });
    expect(h).toContain("версия 2");
    expect(h).toContain("правит");
    expect(h).toContain("правлю");
    expect(h.indexOf("аргумент 1")).toBeLessThan(h.indexOf("правлю"));
    expect(h.indexOf("ход 1")).toBeLessThan(h.indexOf("ход 2"));
  });
  it("question: awaits an answer, then the quote and answer, «answered»", () => {
    const q = { id: "q1", to: "p2", text: "Сколько стоит?" };
    const open = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [q] })]), { running: false });
    expect(open).toContain('<div class="session-question"><div class="session-question__head"><span class="mono">вопрос q1 →</span><span class="session-who"><span class="avatar avatar--sm">2</span> Имя2</span>');
    expect(open).not.toContain('<svg class="icon"><use href="#i-question"');
    expect(open).toContain("ждёт ответа");
    const ans = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [q] }), started(2, "p2"), done(2, "p2", "agree", 1, { answers: [{ questionId: "q1", text: "Тысяча" }] }), { type: "question_closed", questionId: "q1", reason: "answered" }]), { running: false });
    expect(ans).toContain('<div class="session-answer"><div class="session-quote"><span class="mono">ответ на q1</span><span class="session-who"><span class="avatar avatar--sm">1</span> Имя1</span><span>Сколько стоит?</span></div>');
    expect(ans).not.toContain("#i-reply");
    expect(ans).toContain("Тысяча");
    expect(ans).toMatch(/data-tone="info"><svg[^>]*><use href="#i-check"[^]*?отвечен/);
    expect(ans).not.toContain('data-tone="ok"');
    expect(ans).not.toContain("ждёт ответа");
  });
  it("question without an answer", () => {
    const h = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p3", text: "?" }] }), { type: "question_closed", questionId: "q1", reason: "unanswered" }]), { running: false });
    expect(h).toContain("остался без ответа");
  });
});

describe("FeedView: failures", () => {
  it("timeout and retry, then the turn", () => {
    const h = view(fold([created(), started(1, "p1"), failed(1, "p1", 1, "timeout", "300 с"), done(1, "p1", "amend", 1)]), { running: false });
    expect(h).toContain('data-tone="warn"><svg');
    expect(h).toContain("Ход 1 · Имя1 · попытка 1 — таймаут: 300 с. Повтор.");
    expect(h.indexOf("попытка 1")).toBeLessThan(h.indexOf('class="session-turn"'));
  });
  it("two failures and a departure in one .session-fails", () => {
    const h = view(fold([created(), started(1, "p1"), failed(1, "p1", 1, "timeout", "300 с."), failed(1, "p1", 2, "timeout", "300 с."), drop("p1")]), { running: false });
    expect(h.split('class="session-fails"').length).toBe(2);
    const rows = h.split('class="session-fail" ').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('data-tone="warn"');
    expect(rows[0]).toContain("300 с. Повтор.");
    expect(rows[1]).toContain('data-tone="danger"');
    expect(rows[2]).toContain("Имя1 выбыл: таймаут ответа");
  });
});

describe("FeedView: turn in preparation", () => {
  const s = fold([created(), started(1, "p1")]);
  const live = { turn: 1, attempt: 1, text: '{"stance":"amend","reasoning":"думаю вслух' };
  it("with text from reasoning", () => {
    const h = view(s, { live });
    expect(h).toContain("session-turn--live");
    expect(h).toContain("думает");
    expect(h).toContain("думаю вслух");
    expect(h).not.toContain("stance");
    expect(h).toContain("текст хода приходит по мере ответа");
  });
  it("without text — header and cursor, without a caption", () => {
    const h = view(s);
    expect(h).toContain("думает");
    expect(h).not.toContain("приходит по мере");
    expect(h).toContain('<p class="session-turn__text session-view__text"><span class="session-cursor" aria-hidden="true">▍</span></p>');
  });
  it("cursor ▍ at the end of the text of a turn being typed", () => {
    const h = view(s, { live });
    expect(h).toContain('думаю вслух<span class="session-cursor" aria-hidden="true">▍</span></p>');
    expect(h.match(/session-cursor/g)).toHaveLength(1);
  });
  it("not running: no turn", () => {
    expect(view(s, { running: false, live })).not.toContain("session-turn--live");
  });
});

describe("FeedView: other", () => {
  const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1)]);
  it("new turns pointer", () => {
    expect(view(s, { unseen: 2 })).toContain("новые ходы: 2");
    expect(view(s, { unseen: 0 })).not.toContain("session-more");
  });
  it("round separators", () => {
    const h = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1), started(3, "p1", 2), done(3, "p1", "agree", 1, { round: 2 })]), { running: false });
    expect(h.match(/session-round/g)).toHaveLength(2);
    expect(h).toContain('<div class="session-round">круг 1</div>');
    expect(h).toContain('<div class="session-round">круг 2</div>');
    expect(h).not.toContain("Круг ");
  });
  it("empty feed and tail", () => {
    const e = fold([created()]);
    expect(view(e, { running: false })).toContain("Ходов пока нет");
    const h = view(s, { tail: <div className="my-tail">хвост</div> });
    expect(h).toContain("my-tail");
    expect(h.indexOf("my-tail")).toBeGreaterThan(h.indexOf("ход 1"));
    expect(view(e, { tail: <i>x</i> })).not.toContain("Ходов пока нет");
  });
  it("without a session nothing", () => {
    expect(view(fold([]))).toBe("");
  });
});

describe("isAtBottom", () => {
  it("24 px bounds", () => {
    expect(isAtBottom({ scrollTop: 500, clientHeight: 500, scrollHeight: 1000 })).toBe(true);
    expect(isAtBottom({ scrollTop: 476, clientHeight: 500, scrollHeight: 1000 })).toBe(true);
    expect(isAtBottom({ scrollTop: 475, clientHeight: 500, scrollHeight: 1000 })).toBe(false);
  });
});

describe("liveReasoning", () => {
  it("the key is not there yet", () => expect(liveReasoning('{"stan')).toBe(""));
  it("the line is cut off", () => expect(liveReasoning('{"stance":"amend","reasoning": "Начн')).toBe("Начн"));
  it("the line is closed", () => expect(liveReasoning('{"reasoning":"Итог.","solution":"не это"}')).toBe("Итог."));
  it("escaping", () => expect(liveReasoning('{"reasoning":"a\\"b\\nc\\\\d \\u0416')).toBe('a"b\nc\\d Ж'));
  it("break on \\ and \\u04", () => {
    expect(liveReasoning('{"reasoning":"ab\\')).toBe("ab");
    expect(liveReasoning('{"reasoning":"ab\\u04')).toBe("ab");
  });
  it("garbage", () => {
    expect(liveReasoning("")).toBe("");
    expect(liveReasoning("}{ \\ \"reasoning\"")).toBe("");
    expect(liveReasoning('"reasoning":"\\u00zz')).toBe("");
  });
});

describe("liveTextFor", () => {
  const s = fold([created(), started(1, "p1")]);
  const text = '{"reasoning":"привет';
  it("a foreign turn number", () => expect(liveTextFor(s, { turn: 2, attempt: 1, text })).toBeNull());
  it("the attempt is already a failure", () => {
    const f = fold([created(), started(1, "p1"), failed(1, "p1", 1, "timeout", "x"), started(1, "p1")]);
    expect(liveTextFor(f, { turn: 1, attempt: 1, text })).toBeNull();
    expect(liveTextFor(f, { turn: 1, attempt: 2, text })).toBe("привет");
  });
  it("match and empty result", () => {
    expect(liveTextFor(s, { turn: 1, attempt: 1, text })).toBe("привет");
    expect(liveTextFor(s, { turn: 1, attempt: 1, text: "{" })).toBeNull();
    expect(liveTextFor(s, null)).toBeNull();
  });
});

describe("FeedView: owner", () => {
  const say = (id: string, afterTurn: number, text: string, extra: { requestId?: string; answers?: { questionId: string; text: string }[] } = {}): Body =>
    ({ type: "owner_message", id, text, afterTurn, requestId: extra.requestId ?? `r${id}`, ...(extra.answers ? { answers: extra.answers } : {}) });
  const ask = { id: "q3", to: "owner", text: "Какой бюджет?" };
  const base: Body[] = [created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [ask] })];

  it("owner's entry between turns, link and escaping", () => {
    const h = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), say("o1", 1, "см. https://a.ru/x и <b>x</b>"), started(2, "p2", 1), done(2, "p2", "agree", 1)]), { running: false });
    expect(h).toContain('class="session-turn session-owner"');
    expect(h).toContain("Владелец");
    expect(h).toContain(">o1<");
    expect(h).toContain('<a href="https://a.ru/x"');
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(h.indexOf("ход 1")).toBeLessThan(h.indexOf("session-owner"));
    expect(h.indexOf("session-owner")).toBeLessThan(h.indexOf("ход 2"));
  });
  it("reply with an answer: quote of the question, without a duplicate paragraph", () => {
    const h = view(fold([...base, say("o1", 1, "Миллион", { answers: [{ questionId: "q3", text: "Миллион" }] })]), { running: false });
    const owner = h.slice(h.indexOf("session-owner"));
    expect(owner).toContain("session-answer");
    expect(owner).toContain("Какой бюджет?");
    expect(owner).toContain('<p class="session-answer__text">Миллион</p>');
    expect(owner).not.toContain("session-turn__text");
  });
  it("reply with an answer and separate text — both", () => {
    const h = view(fold([...base, say("o1", 1, "И ещё срок", { answers: [{ questionId: "q3", text: "Миллион" }] })]), { running: false });
    expect(h).toContain("Миллион");
    expect(h).toContain("И ещё срок");
  });
  it("pending after an in-progress turn, in order, the chip only on the answer", () => {
    const s = fold([...base, started(2, "p2")]);
    const h = view(s, { pending: [{ requestId: "a", text: "первая", answerTo: "q3" }, { requestId: "b", text: "вторая", answerTo: null }], tail: <i>ТАЙЛ</i> });
    expect(h).toContain("session-owner--pending");
    expect(h).toContain("ожидает конца хода");
    expect(h.match(/ответ на q3/g)).toHaveLength(1);
    expect(h.indexOf("session-turn--live")).toBeLessThan(h.indexOf("первая"));
    expect(h.indexOf("первая")).toBeLessThan(h.indexOf("вторая"));
    expect(h.indexOf("вторая")).toBeLessThan(h.indexOf("ТАЙЛ"));
  });
  it("pending items are not shown with running: false and if the requestId is already applied", () => {
    const s = fold([...base, say("o1", 1, "применена", { requestId: "a" })]);
    expect(view(s, { running: false, pending: [{ requestId: "z", text: "ожидаю", answerTo: null }] })).not.toContain("ожидаю");
    const h = view(s, { pending: [{ requestId: "a", text: "дубль-ожидающая", answerTo: null }] });
    expect(h).not.toContain("дубль-ожидающая");
    expect(h).not.toContain("session-owner--pending");
  });
  it("question with a pending answer: «answer sent», without «awaiting answer»", () => {
    const s = fold([...base, started(2, "p2")]);
    const sent = view(s, { pending: [{ requestId: "a", text: "Миллион", answerTo: "q3" }] });
    expect(sent).toContain("ответ отправлен");
    expect(sent).not.toContain("ждёт ответа");
    expect(view(s, { pending: [{ requestId: "b", text: "просто реплика", answerTo: null }] })).toContain("ждёт ответа");
    const applied = view(fold([...base, started(2, "p2"), { type: "question_closed", questionId: "q3", reason: "answered" }]), { pending: [{ requestId: "a", text: "Миллион", answerTo: "q3" }] });
    expect(applied).toContain("отвечен");
    expect(applied).not.toContain("ответ отправлен");
  });
  it("turn with a question to the owner: badge, addressee, statuses", () => {
    const open = view(fold(base), { running: false });
    expect(open).toContain("вопрос владельцу · q3");
    expect(open).toContain("session-owner__who");
    expect(open).toContain("ждёт ответа");
    const ans = view(fold([...base, { type: "question_closed", questionId: "q3", reason: "answered" }]), { running: false });
    expect(ans).toContain("отвечен");
    const closed = view(fold([...base, { type: "question_closed", questionId: "q3", reason: "unanswered" }]), { running: false });
    expect(closed).toContain("закрыт без ответа");
    expect(closed).not.toContain("остался без ответа");
  });
  it("question to a participant without an answer — «left without answer», no owner badge", () => {
    const h = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p3", text: "?" }] }), { type: "question_closed", questionId: "q1", reason: "unanswered" }]), { running: false });
    expect(h).toContain("остался без ответа");
    expect(h).not.toContain("вопрос владельцу");
  });
  it("footer after the feed and with an empty feed", () => {
    const h = view(fold([created()]), { footer: <b>ФУТЕР</b> });
    expect(h).toContain("Ходов пока нет");
    expect(h.indexOf("Ходов пока нет")).toBeLessThan(h.indexOf("ФУТЕР"));
    const m = view(fold(base), { running: false, unseen: 2, footer: <b>ФУТЕР</b> });
    expect(m.indexOf("session-more")).toBeLessThan(m.indexOf("ФУТЕР"));
    expect(m.endsWith("<b>ФУТЕР</b></section>")).toBe(true);
  });
  it("without replies the markup with the new default props equals the old one", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2")]);
    expect(view(s)).toBe(renderToStaticMarkup(<FeedView state={s} running live={null} unseen={0} onJump={() => {}} pending={[]} footer={undefined} />));
  });
  it("rounds do not shift because of an owner entry", () => {
    const b = [created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2", 2), done(2, "p2", "agree", 1, { round: 2 })];
    const withOwner = fold([...b.slice(0, 3), say("o1", 1, "реплика"), ...b.slice(3)]);
    const rounds = (h: string) => h.match(/Круг \d/g);
    expect(rounds(view(withOwner, { running: false }))).toEqual(rounds(view(fold(b), { running: false })));
  });
});

describe("FeedView: «Continued» separator", () => {
  const base = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1), started(3, "p3"), done(3, "p3", "agree", 1)]);
  const ts = "2026-01-02T10:42:00Z";
  const mark = (beforeTurn: number, addedRounds: number) => ({ ts, maxRounds: 5, addedRounds, beforeTurn });
  it("icon, text with the round count in the right form, date; between the old and new turns", () => {
    const h = view({ ...base, resumes: [mark(3, 2)] }, { running: false });
    expect(h).toContain('role="separator"');
    expect(h).toMatch(/class="feed-resumed"[^>]*><svg[^>]*><use href="#i-play"/);
    expect(h).toContain("Продолжено · 2 круга");
    expect(h).toContain(`feed-resumed__when mono">${formatWhen(ts, new Date())}<`);
    expect(h.indexOf("ход 2")).toBeLessThan(h.indexOf("feed-resumed"));
    expect(h.indexOf("feed-resumed")).toBeLessThan(h.indexOf("ход 3"));
  });
  it.each<[number, string]>([[1, "1 круг"], [2, "2 круга"], [5, "5 кругов"], [11, "11 кругов"], [21, "21 круг"]])("form for %i", (n, word) => {
    expect(view({ ...base, resumes: [mark(3, n)] }, { running: false })).toContain(`Продолжено · ${word}<`);
  });
  it("two continuations — two separators", () => {
    const h = view({ ...base, resumes: [mark(2, 1), mark(3, 2)] }, { running: false });
    expect(h.match(/class="feed-resumed"/g)).toHaveLength(2);
    expect(h.indexOf("1 круг<")).toBeLessThan(h.indexOf("2 круга<"));
  });
  it("without continuations there is no separator", () => {
    expect(view(base, { running: false })).not.toContain("feed-resumed");
  });
});

describe("FeedView: owner wait expiry", () => {
  const base = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), failed(2, "p2", 1, "timeout", "долго"), drop("p2"), started(3, "p3"), done(3, "p3", "agree", 1)]);
  const mark: WaitExpiry = { waitId: "w1", afterTurn: 2, at: "2026-01-02T10:42:00Z" };
  it("after an unsuccessful turn the text, clock icon and time are visible, before the next turn", () => {
    const h = view(base, { expired: [mark], running: false });
    expect(h).toContain('role="separator"');
    expect(h).toMatch(/class="feed-resumed"[^>]*><svg[^>]*><use href="#i-clock"/);
    expect(h).toContain("Время ожидания истекло · обсуждение продолжилось само");
    expect(h).toContain(`feed-resumed__when mono">${formatWhen(mark.at, new Date())}<`);
    expect(h.indexOf("выбыл")).toBeLessThan(h.indexOf("Время ожидания истекло"));
    expect(h.indexOf("Время ожидания истекло")).toBeLessThan(h.indexOf("ход 3"));
  });
  it("without the prop there is no mark", () => {
    expect(view(base, { running: false })).not.toContain("Время ожидания истекло");
  });
});

describe("DroppedNotice", () => {
  const html = (texts: string[]) => renderToStaticMarkup(<DroppedNotice texts={texts} onClose={() => {}} />);
  it("one request: heading, text as a list, explanation, close button", () => {
    const h = html(["экспорт идёт в 03:00"]);
    expect(h).toContain("Удалён 1 запрос реплики");
    expect(h).toContain("<li>экспорт идёт в 03:00</li>");
    expect(h).toContain("Реплика не была применена до продолжения. Отправьте её заново.");
    expect(h).toContain('aria-label="Закрыть сообщение"');
    expect(h).toContain('role="status"');
  });
  it.each<[number, string]>([[2, "Удалено 2 запроса реплик"], [5, "Удалено 5 запросов реплик"], [11, "Удалено 11 запросов реплик"], [21, "Удалён 21 запрос реплики"]])("number %i", (n, title) => {
    expect(html(Array.from({ length: n }, (_, i) => `т${i}`))).toContain(title);
  });
  it("close calls the handler", () => {
    let closed = 0;
    let el!: { props: { children: { props: { onClick?: () => void } }[] } };
    const Probe = () => { el = DroppedNotice({ texts: ["а"], onClose: () => { closed++; } }) as unknown as typeof el; return null; }; // hooks — only inside rendering
    renderToStaticMarkup(<Probe />);
    el.props.children.find((c) => c?.props?.onClick)!.props.onClick!();
    expect(closed).toBe(1);
  });
});

describe("FeedView: independent drafts", () => {
  const withDrafts = (synth = "p2"): Body => {
    const c = created() as Extract<Body, { type: "session_created" }>;
    return { ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId: synth } } };
  };
  const dst = (d: string, p: string): Body => ({ type: "draft_attempt_started", draftId: d, participantId: p, attempt: 1 });
  const dok = (d: string, p: string): Body => ({ type: "draft_completed", draftId: d, participantId: p, attempts: 1, durationMs: 1, usage: {}, chars: 11, sha256: "a".repeat(64), reasoning: "обоснование первого" });
  const accepted = [withDrafts(), dst("d1", "p1"), dok("d1", "p1")];
  const text = (draftId: string, t: string | null, error: string | null = null) => ({
    byId: new Map([[draftId, { draftId, participantId: "p1", attempts: 1, chars: 11, reasoning: "x", text: t, error }]]), error: null as string | null,
  });
  const dview = (s: SessionState, drafts: { byId: ReadonlyMap<string, never>; error: string | null } | undefined, running = true) =>
    renderToStaticMarkup(<FeedView state={s} running={running} live={null} unseen={0} onJump={() => {}} drafts={drafts as never} />);

  it("card: author, «draft», text; without turn, version and position", () => {
    const h = dview(fold(accepted), text("d1", "Текст первого") as never);
    expect(h).toContain("Независимые черновики");
    expect(h).toContain("Имя1");
    expect(h).toContain("черновик");
    expect(h).toContain("Текст первого");
    expect(h).toContain("обоснование первого");
    expect(h).toContain("11 знаков");
    expect(h).toContain("<details");
    for (const w of ["версия", "ход ", "согласен", "правит", "возражает"]) expect(h).not.toContain(w);
  });
  it("text: null — reason", () => {
    expect(dview(fold(accepted), text("d1", null, "снимок черновика d1 изменён") as never)).toContain("Текст недоступен: снимок черновика d1 изменён");
  });
  it("no entry: bridge error or «loading»", () => {
    expect(dview(fold(accepted), { byId: new Map(), error: "мост упал" } as never)).toContain("Текст недоступен: мост упал");
    expect(dview(fold(accepted), { byId: new Map(), error: null } as never)).toContain("Текст черновика загружается…");
    expect(dview(fold(accepted), undefined)).toContain("Текст черновика загружается…");
  });
  it("the discussion start line with the synthesizer", () => {
    const h = dview(fold([...accepted, { type: "drafts_finished" }]), undefined);
    expect(h).toContain("Обсуждение начато · синтезатор 2 · Имя2");
  });
  it("slot in work while running — «writing a draft»; without running there is none", () => {
    const s = fold([...accepted, dst("d2", "p2")]);
    expect(dview(s, undefined, true)).toContain("пишет черновик");
    expect(dview(s, undefined, false)).not.toContain("пишет черновик");
  });
  it("failures and departures in the phase", () => {
    const s = fold([...accepted, dst("d2", "p2"), { type: "draft_attempt_failed", draftId: "d2", participantId: "p2", attempt: 1, kind: "timeout", message: "долго" }, drop("p2")]);
    const h = dview(s, undefined);
    expect(h).toContain("черновик · Имя2 · попытка 1 — таймаут: долго");
    expect(h).toContain("Имя2 выбыл: таймаут ответа");
  });
  it("a departed one with a lost attempt is not «writing a draft»", () => {
    const at = (a: number): Body => ({ type: "draft_attempt_started", draftId: "d2", participantId: "p2", attempt: a });
    const af = (a: number): Body => ({ type: "draft_attempt_failed", draftId: "d2", participantId: "p2", attempt: a, kind: "timeout", message: "долго" });
    const s = fold([...accepted, at(1), at(2), af(2), at(3), af(3), drop("p2"), dst("d3", "p3")]);
    const h = dview(s, undefined);
    expect(h.split("пишет черновик")).toHaveLength(2);
    expect(h).toContain("Имя2 выбыл");
  });
  it("a session without a phase: no words about drafts", () => {
    expect(view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1)]))).not.toContain("Независимые черновики");
  });
});

const newbie = { id: "p4", name: "Новый", providerId: "scripted", model: "m", role: null };
const finishedFail: Body = { type: "session_finished", status: "failed", version: 1, agreed: [], objectors: [] } as Body;
const resumeWith = (old?: string): Body =>
  ({ type: "session_resumed", pid: 2, maxRounds: 5, ...(old ? { replacements: [{ oldParticipantId: old, participant: newbie }] } : {}) }) as Body;

describe("FeedView: participant replacement", () => {
  const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  const dropped = [created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1), drop("p2"), finishedFail];
  it("replacement of a departed one: both names, departure reason and reset of agreements under the separator", () => {
    const h = view(fold([...dropped, resumeWith("p2")]), { running: false });
    expect(h).toContain("feed-replaced");
    expect(h.indexOf("Продолжено")).toBeLessThan(h.indexOf("feed-replaced"));
    expect(text(h)).toContain("Заменён: 2 Имя2 → 4 Новый · выбыл: таймаут ответа");
    expect(text(h)).toContain("Согласия сброшены: участники подтверждают версию заново");
  });
  it("replacement of an active one: «was unavailable»", () => {
    const h = text(view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), finishedFail, resumeWith("p3")]), { running: false }));
    expect(h).toContain("Заменён: 3 Имя3 → 4 Новый · был недоступен");
    expect(h).not.toContain("выбыл:");
  });
  it("a mark without replacements: markup as before", () => {
    const s = fold([...dropped, resumeWith()]);
    const mark = s.resumes[0]!;
    expect(renderToStaticMarkup(<ResumedMark mark={mark} state={s} />)).toBe(renderToStaticMarkup(<ResumedMark mark={mark} />));
    expect(view(s, { running: false })).not.toContain("feed-replaced");
    expect(view(s, { running: false })).toContain("Продолжено");
  });
  it("question to the replaced one: «closed: participant replaced»", () => {
    const h = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "p2", text: "?" }] }), finishedFail, resumeWith("p2")]), { running: false });
    expect(h).toContain("закрыт: участник заменён");
  });
  it("turns: the previous author is kept, after continuation — the new one", () => {
    const h = text(view(fold([...dropped, resumeWith("p2"), started(3, "p4"), done(3, "p4", "agree", 1)]), { running: false }));
    expect(h).toContain("2 Имя2");
    expect(h.indexOf("Новый", h.indexOf("Продолжено") + 40)).toBeGreaterThan(-1);
    const turn3 = view(fold([...dropped, resumeWith("p2"), started(3, "p4"), done(3, "p4", "agree", 1)]), { running: false });
    expect(turn3).toMatch(/session-turn" data-p="4"><header[^>]*><span class="avatar" data-p="4">4<\/span><span class="session-turn__name">Новый/);
  });
});

describe("FeedView: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = <T,>(f: () => T): T => { setProcessLanguage("en"); return f(); };
  const cyr = /[А-Яа-яЁё]/;
  const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]).join(",");
  const strip = (h: string) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

  it("in-progress turn and turn text", () => {
    const s = fold([created(), started(1, "p1")]);
    const h = en(() => view(s, { live: { turn: 1, attempt: 1, text: '{"reasoning":"abc' } }));
    for (const t of ["thinking", "the turn text arrives as the model responds", "turn 1"]) expect(h).toContain(t);
    expect(h).not.toMatch(/думает|ход 1|хода приходит/);
  });
  it("three positions, version, files, rounds, pointer", () => {
    const d1 = { ...done(1, "p1", "amend", 1), filesRead: [{ name: "a.ts", chars: 1, shown: 1 }] } as Body;
    const s = fold([created(), started(1, "p1"), d1, started(2, "p2"), done(2, "p2", "agree", 1), started(3, "p3", 2), done(3, "p3", "object", 1, { round: 2 })]);
    const h = en(() => view(s, { running: false, unseen: 3 }));
    for (const t of ["amends", "agrees", "objects", "version 1", '<span class="chip mono">version 1</span>', 'session-turn__read">read: a.ts<', 'session-round">round 1<', 'session-round">round 2<', "turn 3", "new turns: 3", 'aria-label="Turn feed"', ">Turn feed<"]) expect(h).toContain(t);
  });
  it("questions in all statuses", () => {
    const ask = (to: string): Body => done(1, "p1", "amend", 1, { questions: [{ id: "q1", to, text: "?" }] });
    const st = (bodies: Body[], o = {}) => en(() => view(fold(bodies), { running: false, ...o }));
    const base = (to: string) => [created(), started(1, "p1"), ask(to)];
    expect(st(base("p2"))).toContain("awaiting answer");
    expect(st(base("p2"))).toContain('<span class="mono">question q1 →</span>');
    expect(st([...base("p2"), { type: "question_closed", questionId: "q1", reason: "answered" }])).toContain("answered");
    expect(st([...base("p3"), { type: "question_closed", questionId: "q1", reason: "unanswered" }])).toContain("left unanswered");
    expect(st([...base("owner"), { type: "question_closed", questionId: "q1", reason: "unanswered" }])).toContain("closed without answer");
    expect(st(base("owner"))).toContain("question for the owner · q1");
    expect(en(() => view(fold(base("owner")), { pending: [{ requestId: "a", text: "x", answerTo: "q1" }] }))).toContain("answer sent");
    expect(en(() => view(fold([...base("p2"), finishedFail, resumeWith("p2")]), { running: false }))).toContain("closed: participant replaced");
  });
  it("owner reply and a pending one", () => {
    const base = [created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q3", to: "owner", text: "Бюджет?" }] })];
    const own = en(() => view(fold([...base, { type: "owner_message", id: "o1", text: "Реплика", afterTurn: 1, requestId: "r1" } as Body]), { running: false }));
    expect(own).toContain(">Owner<");
    expect(own).toContain("Реплика");
    const s = fold([...base, started(2, "p2")]);
    const h = en(() => view(s, { pending: [{ requestId: "a", text: "ждёт", answerTo: "q3" }] }));
    expect(h).toContain("waits for the turn to end");
    expect(h).toContain("answer to q3");
  });
  it("attempt failure with and without a retry, departure", () => {
    const h = en(() => view(fold([created(), started(1, "p1"), failed(1, "p1", 1, "timeout", "300 с"), failed(1, "p1", 2, "call_error", "упало."), failed(1, "p1", 3, "invalid_response", "x"), drop("p1")]), { running: false }));
    const t = strip(h);
    expect(t).toContain("Turn 1 · Имя1 · attempt 1 — timeout: 300 с. Retried.");
    expect(t).toContain("attempt 2 — call error: упало. Retried.");
    expect(t).toContain("attempt 3 — invalid response: x");
    expect(t).toContain("Имя1 dropped out: таймаут ответа");
    expect(t).not.toContain("attempt 3 — invalid response: x. Retried");
  });
  it("«Continued», «Replaced», agreement reset", () => {
    const dropped = [created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1), drop("p2"), finishedFail];
    const t = strip(en(() => view(fold([...dropped, resumeWith("p2")]), { running: false })));
    expect(t).toContain("Resumed · 5 rounds");
    expect(t).toContain("Replaced: 2 Имя2 → 4 Новый · dropped out: таймаут ответа");
    expect(t).toContain("Agreements reset: participants confirm the version again");
    const u = strip(en(() => view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), finishedFail, resumeWith("p3")]), { running: false })));
    expect(u).toContain("Replaced: 3 Имя3 → 4 Новый · was unavailable");
  });
  it("expired wait", () => {
    const base = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1)]);
    expect(en(() => view(base, { running: false, expired: [{ waitId: "w", afterTurn: 1, at: "2026-01-02T10:42:00Z" }] }))).toContain("Wait time expired · the discussion continued on its own");
  });
  it("empty feed", () => {
    expect(en(() => view(fold([created()]), { running: false }))).toContain("No turns yet");
  });
  it("drafts: start, accepted, in progress, unavailable, loading, attempts", () => {
    const c = created() as Extract<Body, { type: "session_created" }>;
    const wd: Body = { ...c, session: { ...c.session, drafts: { enabled: true, synthesizerId: "p2" } } };
    const dst = (d: string, p: string, a = 1): Body => ({ type: "draft_attempt_started", draftId: d, participantId: p, attempt: a });
    const dok: Body = { type: "draft_completed", draftId: "d1", participantId: "p1", attempts: 2, durationMs: 1, usage: {}, chars: 1, sha256: "a".repeat(64), reasoning: "обоснование" };
    const s = fold([wd, dst("d1", "p1"), dok, dst("d2", "p2"), { type: "draft_attempt_failed", draftId: "d2", participantId: "p2", attempt: 1, kind: "timeout", message: "долго" }, dst("d2", "p2", 2), { type: "drafts_finished" } as Body]);
    const r = (drafts: unknown) => en(() => renderToStaticMarkup(<FeedView state={s} running live={null} unseen={0} onJump={() => {}} drafts={drafts as never} />));
    const h = r(undefined);
    for (const t of ["Independent drafts", "participants write their versions without seeing the others", "> draft<", "attempts: 2", "1 character", "Draft text", "Loading draft text…", "Discussion started · synthesizer 2 · Имя2"]) expect(h).toContain(t);
    expect(strip(h)).toContain("draft · Имя2 · attempt 1 — timeout: долго");
    const w = en(() => renderToStaticMarkup(<FeedView state={fold([wd, dst("d2", "p2")])} running live={null} unseen={0} onJump={() => {}} />));
    expect(w).toContain("writing a draft");
    const un = r({ byId: new Map([["d1", { draftId: "d1", participantId: "p1", attempts: 2, chars: 1, reasoning: "x", text: null, error: "снимок изменён" }]]), error: null });
    expect(strip(un)).toContain("Text unavailable: снимок изменён");
    expect(strip(r({ byId: new Map(), error: null }))).toContain("Loading draft text…");
    expect(strip(un)).toContain("Text unavailable: ");
    const none = r({ byId: new Map([["d1", { draftId: "d1", participantId: "p1", attempts: 2, chars: 1, reasoning: "x", text: null, error: null }]]), error: null });
    expect(strip(none)).toContain(`Text unavailable: ${feed("en").reasonMissing}`);
    expect(strip(none)).toContain("no reason given");
  });
  it("no Russian labels: only what was recorded", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1)]);
    expect(en(() => view(s, { running: false })).replace(/Имя\d|аргумент \d|текст v\d|Цена/g, "")).not.toMatch(cyr);
  });
  it("what was recorded is not translated", () => {
    const s = fold([created(), started(1, "p1"), failed(1, "p1", 1, "timeout", "сервис ответил: «нет»"), drop("p1")]);
    const t = strip(en(() => view(s, { running: false })));
    expect(t).toContain("Имя1 dropped out: таймаут ответа");
    expect(t).toContain("сервис ответил: «нет»");
  });
  it("the lineup does not depend on the language", () => {
    const dropped = [created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [{ id: "q1", to: "owner", text: "?" }] }), started(2, "p2"), failed(2, "p2", 1, "timeout", "x"), drop("p2"), finishedFail];
    const states: [SessionState, Parameters<typeof view>[1]][] = [
      [fold([created()]), { running: false }],
      [fold(dropped), { running: false, unseen: 2 }],
      [fold([...dropped, resumeWith("p2")]), { running: false, expired: [{ waitId: "w", afterTurn: 1, at: "2026-01-02T10:42:00Z" }] }],
      [fold([created(), started(1, "p1")]), { pending: [{ requestId: "a", text: "x", answerTo: "q1" }] }],
    ];
    for (const [s, o] of states) {
      const e = en(() => view(s, o));
      setProcessLanguage("ru");
      expect(tags(e)).toBe(tags(view(s, o)));
    }
  });
  it.each<[number, string, string]>([[1, "1 round", "1 круг"], [2, "2 rounds", "2 круга"], [5, "5 rounds", "5 кругов"], [11, "11 rounds", "11 кругов"], [21, "21 rounds", "21 круг"]])("rounds(%i)", (n, e, r) => {
    expect(feed("en").rounds(n)).toBe(e);
    expect(feed("ru").rounds(n)).toBe(r);
  });
  it.each<[number, string, string]>([[1, "1 message request removed", "Удалён 1 запрос реплики"], [2, "2 message requests removed", "Удалено 2 запроса реплик"], [5, "5 message requests removed", "Удалено 5 запросов реплик"], [11, "11 message requests removed", "Удалено 11 запросов реплик"], [21, "21 message requests removed", "Удалён 21 запрос реплики"]])("removedRequests(%i)", (n, e, r) => {
    expect(feed("en").removedRequests(n)).toBe(e);
    expect(feed("ru").removedRequests(n)).toBe(r);
  });
  it("DroppedNotice in en", () => {
    const h = en(() => renderToStaticMarkup(<DroppedNotice texts={["экспорт", "ещё"]} onClose={() => {}} />));
    expect(h).toContain("2 message requests removed");
    expect(h).toContain("<li>экспорт</li>");
    expect(h).toContain("The message was not applied before the session resumed. Send it again.");
    expect(h).toContain('aria-label="Dismiss message"');
  });
});

describe("FeedView: osen look (89)", () => {
  afterEach(() => setProcessLanguage("ru"));
  it("name in the turn header without model, the #N tail stays; version — mono chip", () => {
    const c = created(2) as Extract<Body, { type: "session_created" }>;
    const s = fold([{ ...c, session: { ...c.session, participants: [{ id: "p1", name: "Codex (gpt-5.6-luna)", providerId: "codex", model: "gpt-5.6-luna", role: null }, { id: "p2", name: "Codex (gpt-5.6-luna) #2", providerId: "codex", model: "gpt-5.6-luna", role: null }] } }, started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2)]);
    const h = view(s, { running: false });
    expect(h).toContain('<span class="session-turn__name">Codex</span><span class="mono muted">ход 1</span>');
    expect(h).toContain('<span class="session-turn__name">Codex #2</span><span class="mono muted">ход 2</span>');
    expect(h).toContain('<span class="chip mono">версия 2</span>');
    expect(h).not.toContain("Codex (gpt-5.6-luna)</span>");
  });
  it("round separator in lowercase in en", () => {
    setProcessLanguage("en");
    const h = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1)]), { running: false });
    expect(h).toContain('<div class="session-round">round 1</div>');
    expect(h).not.toContain("Round 1");
  });
  it("«✓ answered» chip with info tone in the question header", () => {
    const q = { id: "q1", to: "p2", text: "?" };
    const h = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1, { questions: [q] }), started(2, "p2"), done(2, "p2", "agree", 1, { answers: [{ questionId: "q1", text: "Да" }] }), { type: "question_closed", questionId: "q1", reason: "answered" }]), { running: false });
    expect(h).toMatch(/session-question__head"><span class="mono">вопрос q1 →<\/span><span class="session-who">[^]*?<span class="badge" data-tone="info"><svg[^>]*><use href="#i-check"><\/use><\/svg> отвечен<\/span>/);
  });
  it("discussion start line — alert with info tone, synthesizer name without model", () => {
    const c = created(2) as Extract<Body, { type: "session_created" }>;
    const s = fold([{ ...c, session: { ...c.session, participants: [{ id: "p1", name: "Имя1", providerId: "scripted", model: "m", role: null }, { id: "p2", name: "Codex (gpt)", providerId: "codex", model: "gpt", role: null }], drafts: { enabled: true, synthesizerId: "p2" } } },
      { type: "draft_attempt_started", draftId: "d1", participantId: "p1", attempt: 1 }, { type: "draft_completed", draftId: "d1", participantId: "p1", attempts: 1, durationMs: 1, usage: {}, chars: 3, sha256: "a".repeat(64), reasoning: "r" },
      { type: "draft_attempt_started", draftId: "d2", participantId: "p2", attempt: 1 }, { type: "draft_completed", draftId: "d2", participantId: "p2", attempts: 1, durationMs: 1, usage: {}, chars: 3, sha256: "a".repeat(64), reasoning: "r" }, { type: "drafts_finished" }]);
    const h = view(s, { running: false });
    expect(h).toContain('<div class="alert feed-start" data-tone="info" role="separator"><svg class="icon"><use href="#i-play"></use></svg><div class="alert__text">Обсуждение начато · синтезатор 2 · Codex</div></div>');
  });
});
