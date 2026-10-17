import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent, SessionState } from "@model-council/core/protocol";
import type { ReactElement, ReactNode } from "react";
import type { ResumeView } from "../../shared/bridge.ts";
import type { ProviderOption } from "../../shared/setup.ts";
import { spend } from "./session-ui.tsx";
import { tokenUsage } from "@model-council/core/protocol";
import { chosenVersion } from "../../shared/final-version.ts";
import { OwnerChoiceView, Result, ResumePanelView, defaultChoice, finalVersion, formatDuration, parseRounds, pruneChoices, refreshResume, resultStats, resumeCap, submitResume } from "./Result.tsx";
import type { OwnerChoiceViewProps, ResultProps, ResultStatus, ResumePanelViewProps } from "./Result.tsx";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const mk = (bodies: Body[]): SessionEvent[] => bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);

const created = (topic = "Цена"): Body => ({
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic, templateId: null, framing: "",
    participants: [1, 2, 3].map((i) => ({ id: `p${i}`, name: `Имя${i}`, providerId: "scripted", model: `мод${i}`, role: null })),
    limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 },
  },
});
const started = (turn: number, participantId: string): Body => ({ type: "turn_started", turn, round: 1, participantId });
const done = (turn: number, participantId: string, stance: "amend" | "agree" | "object", version: number, usage: object = {}, reasoning = `аргумент ${turn}`): Body => ({
  type: "turn_completed", turn, round: 1, participantId, stance, normalized: false, reasoning,
  solution: stance === "amend" ? `текст v${version}` : null, version, questions: [], answers: [], attempts: 1, usage, durationMs: 1500,
});
const fin = (status: "consensus" | "no_consensus" | "stopped" | "failed", version: number | null, agreed: string[], objectors: { participantId: string; reasoning: string | null }[] = [], reason: string | null = null): Body =>
  ({ type: "session_finished", status, version, agreed, objectors, reason }) as Body;

const fold = (b: Body[]): SessionState => foldEvents(mk(b));
const noop = () => {};
const view = (state: SessionState, status: ResultStatus, notice: ResultProps["notice"] = null) =>
  renderToStaticMarkup(<Result state={state} status={status} notice={notice} onCopy={noop} onExport={noop} onFeed={noop} onNew={noop} />);

const agreed3 = fold([
  created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2), started(3, "p3"), done(3, "p3", "amend", 3),
  started(4, "p1"), done(4, "p1", "agree", 3), started(5, "p2"), done(5, "p2", "agree", 3), started(6, "p3"), done(6, "p3", "agree", 3),
  fin("consensus", 3, ["p1", "p2", "p3"]),
]);

describe("Result: status", () => {
  const cases: [ResultStatus, string, string, string][] = [
    ["consensus", "Согласие достигнуто", "info", "i-check"],
    ["no_consensus", "Согласия нет", "warn", "i-alert"],
    ["stopped", "Обсуждение остановлено", "muted", "i-stop"],
    ["failed", "Сбой", "danger", "i-x"],
    ["interrupted", "Обсуждение прервано", "muted", "i-alert"],
  ];
  it.each(cases)("%s", (status, title, tone, icon) => {
    const h = view(agreed3, status);
    const hero = h.slice(h.indexOf("result-hero"));
    expect(hero).toContain(`data-tone="${tone}"`);
    expect(hero).toContain(`#${icon}`);
    expect(hero).toContain(`>${title}<`);
  });
  it("«agreed» badge in «Positions» — info", () => {
    const h = view(agreed3, "consensus");
    const side = h.slice(h.indexOf("result-side"));
    expect(side.match(/data-tone="info"><svg[^>]*><use href="#i-check"[^]*?согласен/g)).toHaveLength(3);
    expect(side).not.toContain('data-tone="ok"');
  });
  it("rounds agree with the number", () => {
    expect(view(agreed3, "no_consensus")).toContain("Пройдено 1 круг из 4.");
  });
});

describe("Result: session interrupted while waiting", () => {
  const waiting: SessionState = { ...agreed3, waiting: {
    waitId: "w1", reasons: ["round_boundary", "owner_question"], questionIds: ["q3"], afterTurn: 7,
    deadline: "2026-10-09T07:46:32Z", startedAt: "2026-10-09T07:42:00Z",
  } };
  it("reference block under the header, before the notice and the continuation panel; continuation button in place", () => {
    const h = renderToStaticMarkup(<Result state={waiting} status="interrupted" notice={{ tone: "ok", text: "Уведомление" }}
      panel={<div>Панель продолжения</div>} onCopy={noop} onExport={noop} onFeed={noop} onNew={noop} />);
    expect(h).toContain("Продолжить обсуждение</button>");
    expect(h).toContain("Пауза после круга 1; Ждём ваш ответ на вопрос q3");
    const note = h.indexOf("Прервано во время ожидания владельца");
    expect(note).toBeGreaterThan(h.indexOf("result-hero"));
    expect(note).toBeLessThan(h.indexOf("Уведомление"));
    expect(note).toBeLessThan(h.indexOf("Панель продолжения"));
    expect(h).not.toContain('class="session-wait"');
  });
  it("without a wait there is no reference block; other statuses do not show the residual wait", () => {
    expect(view(agreed3, "interrupted")).not.toContain("Прервано во время ожидания владельца");
    expect(view(agreed3, "interrupted")).toContain("Продолжить обсуждение</button>");
    expect(view(waiting, "stopped")).not.toContain("Прервано во время ожидания владельца");
  });
});

describe("Result: decision and positions", () => {
  it("agreement on version 3", () => {
    const h = view(agreed3, "consensus");
    expect(h).toContain("текст v3");
    expect(h).toContain("версия 3");
    expect(h).toContain("Все активные участники приняли версию 3");
    expect(h).toContain('class="result-author"');
    expect(h).toContain("Согласны");
    expect(h.match(/>согласен</g)).toHaveLength(3);
    expect(h).not.toContain("Возражают");
  });
  it("no_consensus: p3 objects with its last argument", () => {
    const s = fold([
      created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "agree", 1), started(3, "p3"), done(3, "p3", "object", 1, {}, "нет данных"),
      fin("no_consensus", 1, ["p1", "p2"], [{ participantId: "p3", reasoning: "нет данных" }]),
    ]);
    const h = view(s, "no_consensus");
    expect(h.match(/>согласен</g)).toHaveLength(2);
    expect(h).toContain("Возражают");
    expect(h).toContain('<blockquote class="result-quote">нет данных</blockquote>');
  });
  it("interrupted: the last completed version", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2), started(3, "p3"), done(3, "p3", "object", 2), started(4, "p1")]);
    const h = view(s, "interrupted");
    expect(h).toContain("Обсуждение прервано");
    expect(h).toContain("текст v2");
    expect(h).toContain("Возражают");
    expect(finalVersion(s)?.number).toBe(2);
  });
  it("failed before the first version", () => {
    const s = fold([created(), fin("failed", null, [], [], "нет ключа")]);
    const h = view(s, "failed");
    expect(h).toContain("нет ключа");
    expect(h).toContain("Решения нет");
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>.*?Скопировать/);
    expect(finalVersion(s)).toBeNull();
  });
  it("departed participant", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), { type: "participant_dropped", participantId: "p3", reason: "таймаут" } as Body, fin("stopped", 1, ["p1"])]);
    const h = view(s, "stopped");
    expect(h).toContain("Выбыли");
    expect(h).toContain('<p class="result-off-reason muted">таймаут</p>');
    expect(h).toContain("avatar--off");
  });
});

describe("Result: statistics", () => {
  const withUsage = (u: [object, object, object]) => fold([
    created(), started(1, "p1"), done(1, "p1", "amend", 1, u[0]), started(2, "p2"), done(2, "p2", "agree", 1, u[1]), started(3, "p3"), done(3, "p3", "agree", 1, u[2]),
  ]);
  it("only p1 reported the cost", () => {
    const s = withUsage([{ costUsd: 0.5 }, {}, {}]);
    const h = view(s, "stopped");
    expect(h).toContain("0,5 $");
    expect(h).toContain("Стоимость неполная: расход сообщили только: Имя1");
    expect(resultStats(s)).toMatchObject({ costUsd: 0.5, costFrom: ["p1"], costPartial: true, tokens: null });
    expect(h).not.toContain("токенов");
  });
  describe("statistics with independent drafts", () => {
    const dstart = (participantId: string, draftId: string): Body => ({ type: "draft_attempt_started", draftId, participantId, attempt: 1 }) as Body;
    const dfail = (participantId: string, draftId: string, usage: object): Body => ({ type: "draft_attempt_failed", draftId, participantId, attempt: 1, kind: "invalid", message: "x", usage }) as unknown as Body;
    const ddone = (participantId: string, draftId: string, usage: object, durationMs: number, extra: object = {}): Body =>
      ({ type: "draft_completed", draftId, participantId, attempts: 1, durationMs, usage, chars: 5, sha256: "a".repeat(64), reasoning: "r", ...extra }) as Body;
    const turn1 = (usage: object): Body[] => [started(1, "p1"), { ...done(1, "p1", "amend", 1, usage), durationMs: 1000 } as Body];
    it("an accepted draft is included in tokens and duration, turns count only regular ones", () => {
      const s = fold([created(), dstart("p1", "d1"), ddone("p1", "d1", { inputTokens: 60, outputTokens: 40 }, 2000), { type: "drafts_finished" } as Body, ...turn1({ outputTokens: 50 })]);
      expect(resultStats(s)).toMatchObject({ tokens: 150, turns: 1, durationMs: 3000, tokensPartial: false });
    });
    it("only the draft reported the cost: sum and author, incomplete mark", () => {
      const s = fold([created(), dstart("p1", "d1"), ddone("p1", "d1", { costUsd: 0.25 }, 10), { type: "drafts_finished" } as Body, ...turn1({})]);
      expect(resultStats(s)).toMatchObject({ costUsd: 0.25, costFrom: ["p1"], costPartial: true });
    });
    it("usageIncomplete makes tokens incomplete", () => {
      const s = fold([created(), dstart("p1", "d1"), ddone("p1", "d1", { inputTokens: 5 }, 10, { usageIncomplete: true }), { type: "drafts_finished" } as Body]);
      expect(resultStats(s)).toMatchObject({ tokens: 5, tokensPartial: true });
    });
    it("a slot without an accepted draft: the spending of a failed attempt is included in the sum, as in the core", () => {
      const s = fold([created(), dstart("p1", "d1"), dfail("p1", "d1", { inputTokens: 999, costUsd: 9 }), ...turn1({ outputTokens: 50 })]);
      expect(resultStats(s)).toMatchObject({ tokens: 1049, costUsd: 9, costPartial: true, durationMs: 1000 });
      expect(resultStats(s).tokens).toBe(tokenUsage(s).total);
      expect(resultStats(s).tokensFrom).toContain("p1");
    });
  });
  it("nobody reported: no block and no mark", () => {
    const h = view(withUsage([{}, {}, {}]), "stopped");
    expect(h).not.toContain("стоимость");
    expect(h).not.toContain("неполная");
  });
  it("everyone reported: no mark, tokens are summed", () => {
    const s = withUsage([{ costUsd: 1, inputTokens: 1000, outputTokens: 234 }, { costUsd: 1, inputTokens: 1 }, { costUsd: 1, outputTokens: 5 }]);
    const h = view(s, "stopped");
    expect(h).not.toContain("неполная");
    expect(resultStats(s)).toMatchObject({ tokens: 1240, tokensPartial: false, costUsd: 3, turns: 3, durationMs: 4500 });
    expect(h).toContain("токенов");
  });
  it("only p2 reported tokens", () => {
    const h = view(withUsage([{}, { inputTokens: 10 }, {}]), "stopped");
    expect(h).toContain("Токены неполные: расход сообщили только: Имя2");
  });
  it("formatDuration", () => {
    expect(formatDuration(45_000)).toBe("45 с");
    expect(formatDuration(372_000)).toBe("6 мин 12 с");
    expect(formatDuration(3_900_000)).toBe("1 ч 5 мин");
    expect(formatDuration(400)).toBe("0 с");
  });
});

describe("Result: notice and topic", () => {
  it("notice ok and danger", () => {
    expect(view(agreed3, "consensus", { tone: "ok", text: "Скопировано" })).toMatch(/class="alert" data-tone="ok" role="status".*Скопировано/);
    expect(view(agreed3, "consensus", { tone: "danger", text: "Не вышло" })).toMatch(/data-tone="danger" role="status".*Не вышло/);
  });
  it("notice null: no alert", () => {
    expect(view(agreed3, "consensus")).not.toContain('class="alert"');
  });
  it("long topic: title with the full topic", () => {
    const topic = "Очень длинная тема ".repeat(20).trim();
    const h = view(fold([created(topic)]), "failed");
    expect(h).toContain(`title="${topic}"`);
  });
  it("without a session empty", () => {
    expect(view(fold([]), "failed")).toBe("");
  });
});

describe("Result: objecting outside no_consensus", () => {
  it("stopped: only p2, p3 did not take a turn", () => {
    const s = fold([
      created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1, {}, "дорого"),
      fin("stopped", 1, [], [{ participantId: "p2", reasoning: "дорого" }, { participantId: "p3", reasoning: null }]),
    ]);
    const h = view(s, "stopped");
    expect(h).toContain("Возражают");
    expect(h.match(/>возражает</g)).toHaveLength(1);
    expect(h).toContain('<blockquote class="result-quote">дорого</blockquote>');
    expect(h).not.toContain("аргумент не записан");
  });
  it("failed: synthesizer departed — name instead of the reason code", () => {
    const c = created() as any; c.session.drafts = { synthesizerId: "p2" };
    const h = view(fold([c, fin("failed", null, [], [], "synthesizer_unavailable")]), "failed");
    expect(h).toContain("Синтезатор «Имя2»");
    expect(h).not.toContain("synthesizer_unavailable");
  });
  it("failed before the first version: no group", () => {
    const s = fold([created(), fin("failed", null, [], [{ participantId: "p2", reasoning: null }], "сбой")]);
    expect(view(s, "failed")).not.toContain("Возражают");
  });
});

describe("Result: materials", () => {
  const base = created() as Extract<Body, { type: "session_created" }>;
  const withMats = fold([{ ...base, session: { ...base.session, materials: [{ id: "m1", name: "one.txt", chars: 5, sha256: "a".repeat(64) }, { id: "m2", name: "two.md", chars: 7, sha256: "b".repeat(64) }] } }, fin("stopped", null, [])]);
  it("two materials: after the topic", () => {
    const h = view(withMats, "stopped");
    const i = h.indexOf("result-topic");
    expect(h.indexOf('<summary>материалы: <span class="mono">2</span></summary>')).toBeGreaterThan(i);
    expect(h.indexOf("one.txt")).toBeGreaterThan(i);
    expect(h.indexOf("two.md")).toBeGreaterThan(i);
  });
  it("without materials there is no row", () => {
    expect(view(agreed3, "consensus")).not.toContain("session-materials");
  });
});

describe("Result: rerun and continuation", () => {
  const btns = (h: string) => [...h.matchAll(/<button[^>]*>.*?<\/button>/g)].map((m) => m[0]);
  const find = (h: string, label: string) => btns(h).find((b) => b.includes(label))!;
  it.each(["consensus", "no_consensus", "stopped", "failed", "interrupted"] as ResultStatus[])("both buttons present: %s", (status) => {
    const h = view(agreed3, status);
    expect(find(h, "Запустить заново")).not.toContain("disabled");
    expect(find(h, "Обсудить дальше")).not.toContain("disabled");
    expect(h).not.toContain("result-rerun-note");
  });
  it("order of the buttons in the header", () => {
    const h = view(agreed3, "consensus");
    const order = ["К ленте", "Скопировать", "Экспорт в Markdown", "Запустить заново", "Обсудить дальше", "Новое обсуждение"].map((l) => h.indexOf(l));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i > 0)).toBe(true);
  });
  it("without versions: «Discuss further» unavailable, explanation before result-hero", () => {
    const h = view(fold([created(), fin("failed", null, [], [], "Сбой")]), "failed");
    expect(find(h, "Обсудить дальше")).toContain("disabled");
    expect(find(h, "Запустить заново")).not.toContain("disabled");
    expect(h).toContain("«Обсудить дальше» недоступно: у сессии нет ни одной версии решения");
    expect(h.indexOf("result-rerun-note")).toBeLessThan(h.indexOf("result-hero"));
    expect(h.indexOf('<main class="content">')).toBeLessThan(h.indexOf("result-rerun-note"));
  });
  it("rerunBusy blocks both buttons", () => {
    const h = renderToStaticMarkup(<Result state={agreed3} status="consensus" notice={null} onCopy={noop} onExport={noop} onFeed={noop} onNew={noop} rerunBusy />);
    expect(find(h, "Запустить заново")).toContain("disabled");
    expect(find(h, "Обсудить дальше")).toContain("disabled");
  });
});

describe("Result: continuation button", () => {
  const btn = (h: string) => h.includes("Продолжить обсуждение</button>");
  it.each<[ResultStatus, boolean]>([["no_consensus", true], ["stopped", true], ["interrupted", true], ["consensus", false], ["failed", false]])("%s: button %s", (status, has) => {
    const h = view(agreed3, status);
    expect(btn(h)).toBe(has);
    if (has) expect(h).toContain("result-resume-btn");
  });
  it("button inside result-hero after the text; busy while parameters are requested", () => {
    const h = view(agreed3, "stopped");
    expect(h.indexOf("result-hero__text")).toBeLessThan(h.indexOf("result-resume-btn"));
    expect(h.indexOf("result-resume-btn")).toBeLessThan(h.indexOf("result-cols"));
    expect(h).not.toMatch(/result-resume-btn"[^>]*disabled/);
    const busy = renderToStaticMarkup(<Result state={agreed3} status="stopped" notice={null} onCopy={noop} onExport={noop} onFeed={noop} onNew={noop} resuming />);
    expect(busy).toMatch(/result-resume-btn"[^>]*disabled/);
  });
  it("the panel stands between the header and the columns", () => {
    const h = renderToStaticMarkup(<Result state={agreed3} status="stopped" notice={null} onCopy={noop} onExport={noop} onFeed={noop} onNew={noop} panel={<section className="result-resume" />} />);
    expect(h.indexOf("result-hero")).toBeLessThan(h.indexOf("result-resume\""));
    expect(h.indexOf("result-resume\"")).toBeLessThan(h.indexOf("result-cols"));
  });
});

// Tree of elements with expanded components without hooks: find the node and call its handler.
type Props = Record<string, unknown> & { children?: ReactNode };
function find(n: ReactNode, pred: (p: Props) => boolean, out: Props[] = []): Props[] {
  if (Array.isArray(n)) n.forEach((c) => find(c, pred, out));
  else if (n && typeof n === "object" && "type" in n) {
    const el = n as ReactElement<Props>;
    if (pred(el.props)) out.push(el.props);
    find(el.props.children, pred, out);
  }
  return out;
}
const button = (t: ReactNode, word: string) => find(t, (p) => p.children === word)[0]!;

const person = (n: number, billing: ResumeView["participants"][number]["billing"], o: Partial<ResumeView["participants"][number]> = {}) =>
  ({ id: `p${n}`, name: `Имя${n} (м${n})`, billing, available: true, reason: null, ...o });
const rview = (o: Partial<ResumeView> = {}): ResumeView => ({
  allowed: true, reason: null, blocked: null,
  rounds: { min: 1, max: 20, remaining: 1, initial: 1 },
  participants: [person(1, "subscription"), person(2, "paid"), person(3, "free")],
  replaceable: [], replacements: [], providers: [], agreementReset: false,
  tokenCap: { cap: null, spent: 0, exhausted: false }, draftCalls: 0,
  ...o,
});
const spy = { submit: 0, cancel: 0 };
const panelProps = (o: Partial<ResumePanelViewProps> = {}): ResumePanelViewProps => ({
  session: agreed3.session, view: rview(), text: "1", error: null, busy: false,
  capText: "", uncap: false, choices: {}, refreshing: false, refreshError: null,
  onReplace: () => {}, onKeep: () => {}, onProvider: () => {}, onModel: () => {}, onText: noop, onCapText: noop, onUncap: noop, onSubmit: () => { spy.submit++; }, onCancel: () => { spy.cancel++; }, ...o,
});
const panel = (o: Partial<ResumePanelViewProps> = {}) => renderToStaticMarkup(<ResumePanelView {...panelProps(o)} />);
const goBtn = (h: string) => h.match(/<button type="button" class="btn"[^>]*>/)![0];

describe("Result: continuation panel", () => {
  it("rounds remainder: value, call bound, spending marks", () => {
    const h = panel();
    expect(h).toContain('value="1"');
    expect(h).toContain('min="1" max="20"');
    expect(h).toContain("от 1 до 20; остаток прежнего лимита — 1");
    expect(h).toContain("не более 9 вызовов моделей · 3 участника × 1 круг × 3");
    expect(h).toMatch(/#i-coins"[^>]*><\/use><\/svg> расходует подписку/);
    expect(h).toContain("оплата по вызовам");
    expect(h).toMatch(/#i-check"[^>]*><\/use><\/svg> бесплатно/);
    expect(h).toContain("Имя1 (м1) расходует подписку; Имя2 (м2) оплачивается по тарифу провайдера");
    expect(goBtn(h)).not.toContain("disabled");
  });
  it("drafts: the bound includes the remaining calls of the phase, caption with a tail", () => {
    const h = panel({ view: rview({ draftCalls: 5 }), text: "2" });
    expect(h).toContain("не более 23 вызовов");
    expect(h).toContain("3 участника × 2 круга × 3 + 5 на незавершённые черновики");
  });
  it("without drafts: the estimate is as before", () => {
    const h = panel({ view: rview({ draftCalls: 0 }), text: "1" });
    expect(h).toContain("не более 9 вызовов");
    expect(h).not.toContain("черновики");
  });
  it("no remainder: value from the view, recalculated when the field changes", () => {
    const v = rview({ rounds: { min: 1, max: 20, remaining: null, initial: 3 } });
    const h = panel({ view: v, text: "3" });
    expect(h).toContain('value="3"');
    expect(h).not.toContain("остаток прежнего");
    expect(h).toContain("не более 27 вызовов моделей · 3 участника × 3 круга × 3");
    expect(panel({ view: v, text: "5" })).toContain("не более 45 вызовов моделей · 3 участника × 5 кругов × 3");
  });
  it("the field reports input outward", () => {
    const got: string[] = [];
    const input = find(ResumePanelView(panelProps({ onText: (t) => got.push(t) })), (p) => p.type === "number")[0]!;
    (input.onChange as (e: unknown) => void)({ target: { value: "4" } });
    expect(got).toEqual(["4"]);
  });
  it.each(["0", "", "21", "1.5", "-1", "abc"])("value «%s» not accepted: bounds, «Continue» unavailable", (text) => {
    const h = panel({ text });
    expect(h).toContain("Введите целое число от 1 до 20");
    expect(goBtn(h)).toContain('disabled=""');
    expect(parseRounds(text, { min: 1, max: 20 })).toBeNull();
  });
  it("bounds are included", () => {
    expect(parseRounds("1", { min: 1, max: 20 })).toBe(1);
    expect(parseRounds(" 20 ", { min: 1, max: 20 })).toBe(20);
  });
  it("«Continue» calls the handler, «Cancel» closes without a call", () => {
    spy.submit = 0; spy.cancel = 0;
    const t = ResumePanelView(panelProps());
    (button(t, "Отмена").onClick as () => void)();
    expect(spy).toEqual({ submit: 0, cancel: 1 });
    (button(t, "Продолжить").onClick as () => void)();
    expect(spy).toEqual({ submit: 1, cancel: 1 });
  });
  it("unavailable provider: caption with the participant and reason, button unavailable", () => {
    const v = rview({ participants: [person(1, "subscription"), person(2, "paid", { available: false, reason: "команда codex не найдена" }), person(3, "free")] });
    const h = panel({ view: v });
    expect(h).toContain("result-resume__why");
    expect(h).toContain("Имя2 (м2) недоступен: команда codex не найдена.");
    expect(h).toMatch(/result-resume__note"[^>]*><svg[^>]*><use href="#i-alert"/);
    expect(goBtn(h)).toContain('disabled=""');
  });
  it("allowed === false: reason as an alert block, no fields or list, «Cancel» works", () => {
    spy.cancel = 0;
    const v = rview({ allowed: false, reason: "Сессия идёт: исполнитель ещё работает." });
    const h = panel({ view: v });
    expect(h).toMatch(/class="alert" data-tone="danger" role="alert"/);
    expect(h).toContain("Сессия идёт: исполнитель ещё работает.");
    expect(h).not.toContain("Ещё кругов");
    expect(h).not.toContain("result-resume__people");
    expect(goBtn(h)).toContain('disabled=""');
    (button(ResumePanelView(panelProps({ view: v })), "Отмена").onClick as () => void)();
    expect(spy.cancel).toBe(1);
  });
  it("refusal after a click: reason on the panel, fields kept", () => {
    const h = panel({ error: "Снимок материала изменён." });
    expect(h).toContain('role="alert"');
    expect(h).toContain("Снимок материала изменён.");
    expect(h).toContain("Ещё кругов");
  });
  it("waiting for the answer: «Continue» is busy", () => {
    expect(goBtn(panel({ busy: true }))).toContain('disabled=""');
  });
});

const usage500 = { inputTokens: 300, outputTokens: 200 };
const capCreated = (): Body => { const c = created() as any; c.session.limits.maxTotalTokens = 1200; return c; };
const capStopped = (usages: object[]) => fold([
  capCreated(), ...usages.flatMap((u, i) => [started(i + 1, `p${i + 1}`), done(i + 1, `p${i + 1}`, i === 0 ? "amend" : "object", 1, u)]),
  fin("stopped", 1, [], [{ participantId: "p2", reasoning: "не согласен" }], "token_cap"),
]);

describe("Result: stop by the token ceiling", () => {
  const full = capStopped([usage500, usage500, usage500]);
  it("caption, numbers, icon and badge", () => {
    const h = view(full, "stopped");
    expect(h).toContain("остановлена · потолок токенов");
    const hero = h.slice(h.indexOf("result-hero"));
    expect(hero).toContain('data-tone="warn"');
    expect(hero).toContain("#i-coins");
    expect(hero).toContain(">Остановлена · потолок токенов<");
    expect(hero).toContain("Израсходовано 1500 из 1200 токенов.");
    expect(hero).toContain("Последняя версия не согласована.");
    expect(h).toContain("текст v1");
    expect(h).toContain("не согласен");
    for (const w of ["К ленте", "Скопировать", "Экспорт в Markdown", "Запустить заново", "Обсудить дальше", "Новое обсуждение", "Продолжить обсуждение"]) expect(h).toContain(w);
  });
  it("the incomplete-accounting mark only when incomplete", () => {
    expect(view(capStopped([usage500, {}, usage500]), "stopped")).toContain("Расход посчитан не полностью");
    expect(view(full, "stopped")).not.toContain("Расход посчитан не полностью");
  });
  it("a session with a ceiling without a stop: incomplete accounting is marked, without a ceiling there is no mark", () => {
    const turns = [started(1, "p1"), done(1, "p1", "amend", 1), fin("no_consensus", 1, [])];
    expect(view(fold([capCreated(), ...turns]), "no_consensus")).toContain("Расход посчитан не полностью");
    expect(view(fold([created(), ...turns]), "no_consensus")).not.toContain("Расход посчитан не полностью");
  });
  it("stop by the owner without words about the ceiling", () => {
    const h = view(fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), fin("stopped", 1, [])]), "stopped");
    expect(h).toContain(">Обсуждение остановлено<");
    expect(h).toContain("остановлена");
    expect(h).not.toContain("отолок");
  });
});

describe("Result: ceiling during continuation", () => {
  const ex = { cap: 1200, spent: 1500, exhausted: true };
  it("resumeCap: six cases", () => {
    expect(resumeCap({ cap: 5000, spent: 1500, exhausted: false }, "", false)).toEqual({ value: undefined, ok: true, why: null });
    expect(resumeCap(ex, "abc", true)).toEqual({ value: null, ok: true, why: null });
    expect(resumeCap(ex, "", false)).toEqual({ value: undefined, ok: false, why: null });
    expect(resumeCap(ex, "2500", false)).toEqual({ value: 2500, ok: true, why: null });
    expect(resumeCap(ex, "1500", false)).toEqual({ value: undefined, ok: false, why: "Нужно больше 1500" });
    for (const t of ["много", "1,5"]) expect(resumeCap(ex, t, false)).toEqual({ value: undefined, ok: false, why: "Нужно целое число больше 1500" });
  });
  it("panel when the ceiling is exhausted", () => {
    const v = rview({ tokenCap: ex });
    const h = panel({ view: v });
    expect(h).toContain("Потолок 1200, израсходовано 1500 токенов");
    expect(h).toContain("Новый потолок");
    expect(h).toContain('placeholder="больше 1500"');
    expect(h).toContain("Снять потолок");
    expect(goBtn(h)).toContain('disabled=""');
    expect(h.indexOf("Ещё кругов")).toBeLessThan(h.indexOf("result-resume__cap"));
    expect(h.indexOf("result-resume__cap")).toBeLessThan(h.indexOf("result-resume__people"));
    const low = panel({ view: v, capText: "1500" });
    expect(low).toContain("Нужно больше 1500");
    expect(goBtn(low)).toContain('disabled=""');
    const ok = panel({ view: v, capText: "2500" });
    expect(ok).not.toContain("result-resume__why");
    expect(goBtn(ok)).not.toContain("disabled");
    const off = panel({ view: v, uncap: true });
    expect(off.match(/<input class="input" inputMode[^>]*>/)![0]).toContain('disabled=""');
    expect(goBtn(off)).not.toContain("disabled");
  });
  it("ceiling not exhausted: no block", () => {
    const h = panel({ view: rview({ tokenCap: { cap: 5000, spent: 1500, exhausted: false } }) });
    expect(h).not.toContain("result-resume__cap");
    expect(goBtn(h)).not.toContain("disabled");
  });
  it("submitResume passes the ceiling", async () => {
    const calls: unknown[][] = [];
    const call = async (...a: unknown[]) => { calls.push(a); return { droppedOwnerRequests: [] }; };
    await submitResume(call, "s1", 2, { current: false }, 2500);
    await submitResume(call, "s1", 2, { current: false }, null);
    await submitResume(call, "s1", 2, { current: false });
    expect(calls).toEqual([["s1", 2, 2500], ["s1", 2, null], ["s1", 2]]);
  });
});

// Owner choice: three versions, the final one is third, p3 objects.
const select = (version: number, note?: string): Body => ({ type: "owner_selected_version", version, statusAtSelection: "no_consensus", ...(note ? { note } : {}) }) as Body;
const resumed: Body = { type: "session_resumed", pid: 2, maxRounds: 6 };
const three: Body[] = [
  created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "amend", 2), started(3, "p3"), done(3, "p3", "amend", 3),
  started(4, "p1"), done(4, "p1", "agree", 3), started(5, "p2"), done(5, "p2", "agree", 3), started(6, "p3"), done(6, "p3", "object", 3, {}, "возражение к трём"),
  fin("no_consensus", 3, ["p1", "p2"], [{ participantId: "p3", reasoning: "возражение к трём" }]),
];
// Event times grow with the number: the order "choice / continuation" is distinguishable.
const foldTs = (b: Body[]): SessionState => foldEvents(b.map((x, i) => ({ ...x, seq: i + 1, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }) as SessionEvent));
const noChoice = fold(three);
const chosen1 = foldTs([...three, select(1, "моя заметка")]);
const choiceCard = (h: string) => h.slice(h.indexOf("result-choice"), h.indexOf("result-choice") + 6000);

describe("Result: owner choice", () => {
  it("without a choice: card after the final decision, select with three versions, final one selected", () => {
    const h = view(noChoice, "no_consensus");
    expect(h.indexOf("Итоговое решение")).toBeLessThan(h.indexOf("result-choice"));
    expect(h.indexOf("result-choice")).toBeLessThan(h.indexOf(">Тема<"));
    const c = choiceCard(h);
    expect(c).toContain(">Выбор владельца<");
    expect(c).toMatch(/<option value="1"[^>]*>Версия 1 · Имя1<\/option>/);
    expect(c).toContain("Версия 2 · Имя2");
    expect(c).toMatch(/<option value="3" selected=""[^>]*>Версия 3 · Имя3/);
    expect(c).toContain('maxLength="2000"');
    expect(c).toContain("Заметка (необязательно)");
    expect(c).toContain("Принять версию");
    expect(c).not.toContain("Это ваш выбор");
  });
  it("saved choice of version 1 with final 3: nothing from the summary is replaced", () => {
    const h = view(chosen1, "no_consensus");
    const c = choiceCard(h).slice(0, choiceCard(h).indexOf("result-cols") < 0 ? undefined : undefined);
    expect(c).toContain("Версия 1 · автор Имя1");
    expect(c).toContain("статус на момент выбора: согласия нет");
    expect(c).toContain("Это ваш выбор, а не согласие моделей.");
    expect(c).toContain("Возражения относятся к итоговой версии 3, а не к выбранной.");
    expect(c).toContain("Заметка: моя заметка");
    expect(c).toContain("текст v1");
    expect(c).toMatch(/<option value="1" selected=""/);
    expect(c).toContain(">моя заметка</textarea>");
    expect(c).not.toContain("до продолжения");
    const main = h.slice(h.indexOf("Итоговое решение"), h.indexOf("result-choice"));
    expect(main).toContain("версия 3");
    expect(main).toContain("текст v3");
    expect(main).not.toContain("текст v1");
    expect(h).toContain(">Согласия нет<");
    expect(h).toContain("возражение к трём");
    expect(h).toContain("возражает");
  });
  it("final version selected: no line about objections", () => {
    const h = view(foldTs([...three, select(3)]), "no_consensus");
    expect(h).toContain("Это ваш выбор, а не согласие моделей.");
    expect(h).not.toContain("Возражения относятся");
    expect(h).not.toContain("Заметка: ");
  });
  it("choice before continuation: line present; without continuation or with a choice after it — none", () => {
    const after: Body[] = [started(7, "p1"), done(7, "p1", "agree", 3), fin("no_consensus", 3, ["p1"], [{ participantId: "p3", reasoning: "в" }])];
    const before = view(foldTs([...three, select(1), resumed, ...after]), "no_consensus");
    expect(before).toContain("Выбор сделан до продолжения обсуждения и не является его результатом.");
    expect(view(chosen1, "no_consensus")).not.toContain("до продолжения");
    expect(view(foldTs([...three, resumed, ...after, select(1)]), "no_consensus")).not.toContain("до продолжения");
  });
  it("failure without versions: reason, no form, no button", () => {
    const failed = fold([created(), fin("failed", null, [], [], "сломалось")]);
    const c = choiceCard(view(failed, "failed"));
    expect(c).toContain("Принять версию нельзя: в сессии нет ни одной версии решения.");
    expect(c).not.toContain("<select");
    expect(c).not.toContain(">Принять версию<");
  });
  it("session without a summary: reason, no form", () => {
    const open = fold(three.slice(0, 7));
    const c = choiceCard(view(open, "interrupted"));
    expect(c).toContain("Принять версию можно после завершения сессии.");
    expect(c).not.toContain("<select");
  });
  it("journal read only partially, no summary: reason — a partial-read message, not «after completion»", () => {
    const blocked = "Сессия записана более новой версией приложения. Показано начало журнала до события №5. Обновите приложение, чтобы увидеть её целиком.";
    const h = renderToStaticMarkup(<OwnerChoiceView state={fold(three.slice(0, 7))} version={null} note="" error={null} busy={false} saved={false} blocked={blocked} onVersion={noop} onNote={noop} onSubmit={noop} />);
    expect(h).toContain(blocked);
    expect(h).not.toContain("Принять версию можно после завершения сессии.");
  });
  const props =(o: Partial<OwnerChoiceViewProps> = {}): OwnerChoiceViewProps => ({
    state: noChoice, version: 3, note: "", error: null, busy: false, saved: false, onVersion: noop, onNote: noop, onSubmit: noop, ...o,
  });
  const html = (o: Partial<OwnerChoiceViewProps> = {}) => renderToStaticMarkup(<OwnerChoiceView {...props(o)} />);
  it("save error: in an alert, typed text in place; no «Choice saved»", () => {
    const h = html({ error: "Сессию s1 сейчас продолжает другой процесс: выбор не записан.", note: "введено", saved: true });
    expect(h).toMatch(/class="alert" data-tone="danger" role="alert"/);
    expect(h).toContain("выбор не записан.");
    expect(h).toContain(">введено</textarea>");
    expect(h).not.toContain("Выбор сохранён.");
  });
  it("success: «Choice saved.»; the button is unavailable during saving", () => {
    expect(html({ saved: true })).toContain("Выбор сохранён.");
    expect(html()).not.toMatch(/class="btn"[^>]*disabled/);
    expect(html({ busy: true })).toMatch(/class="btn"[^>]*disabled/);
  });
  it("select, note and button report outward", () => {
    const got: unknown[] = [];
    const t = OwnerChoiceView(props({ onVersion: (n) => got.push(n), onNote: (x) => got.push(x), onSubmit: () => got.push("go") }));
    (find(t, (p) => p.value === 3 && "onChange" in p)[0]!.onChange as (e: unknown) => void)({ target: { value: "2" } });
    (find(t, (p) => p.maxLength === 2000)[0]!.onChange as (e: unknown) => void)({ target: { value: "т" } });
    (button(t, "Принять версию").onClick as () => void)();
    expect(got).toEqual([2, "т", "go"]);
  });
  it("chosenVersion: the text of the chosen version, not the final one; without a choice and with a foreign number — null", () => {
    expect(chosenVersion(chosen1)!.text).toBe("текст v1");
    expect(chosenVersion(chosen1)!.text).not.toBe(finalVersion(chosen1)!.text);
    expect(chosenVersion(noChoice)).toBeNull();
    expect(chosenVersion(foldTs([...three, select(9)]))).toBeNull();
  });
  it("copying: «Copy summary» at the top; «Copy choice» only with a choice, only calls onCopyChoice", () => {
    expect(view(noChoice, "no_consensus")).toContain("Скопировать итог");
    setProcessLanguage("en");
    try { expect(view(noChoice, "no_consensus")).toContain("Copy result"); } finally { setProcessLanguage("ru"); }
    expect(html({})).not.toContain("Скопировать выбор");
    const withSel = props({ state: chosen1, version: 1 });
    expect(renderToStaticMarkup(<OwnerChoiceView {...withSel} />)).toContain("Скопировать выбор");
    expect(renderToStaticMarkup(<OwnerChoiceView {...withSel} language="en" />)).toContain("Copy choice");
    let n = 0;
    const t = OwnerChoiceView({ ...withSel, onCopyChoice: () => { n++; } });
    (find(t, (p) => typeof p.className === "string" && p.className.includes("result-choice__copy"))[0]!.onClick as () => void)();
    expect(n).toBe(1);
    expect(finalVersion(chosen1)!.number).toBe(3);
  });
});

// Participant replacement on continuation.
const prov = (id: string, o: Partial<ProviderOption> = {}): ProviderOption =>
  ({ id, kind: "cli", label: `Пров ${id}`, available: true, reason: null, models: ["m1", "m2"], defaultModel: "m1", billing: "free", ...o });
const replaceable = (o: Partial<ResumeView["replaceable"][number]> = {}) => ({ id: "p2", name: "Имя2 (м2)", why: "dropped" as const, reason: "таймаут", required: false, ...o });
const rv = (o: Partial<ResumeView> = {}) => rview({ replaceable: [replaceable()], providers: [prov("a"), prov("b", { available: false })], ...o });

describe("Result: continuation after a failure due to lack of participants", () => {
  const failedState = (code: string | null) => fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), { ...fin("failed", 1, [], [], "мало"), reasonCode: code } as Body]);
  it("button only with reasonCode insufficient_active_participants", () => {
    expect(view(failedState("insufficient_active_participants"), "failed")).toContain("Продолжить обсуждение</button>");
    expect(view(failedState(null), "failed")).not.toContain("Продолжить обсуждение</button>");
    expect(view(failedState("other"), "failed")).not.toContain("Продолжить обсуждение</button>");
    expect(view(agreed3, "consensus")).not.toContain("Продолжить обсуждение</button>");
  });
});

describe("Result: replacement section in the panel", () => {
  it("rows: departed and unavailable, «replacement needed», «Replace» button calls the handler", () => {
    const got: string[] = [];
    const v = rv({ replaceable: [replaceable(), replaceable({ id: "p3", name: "Имя3 (м3)", why: "unavailable", reason: "нет ключа", required: true })] });
    const h = panel({ view: v });
    expect(h).toContain("Замена участников");
    expect(h).toContain("выбыл: таймаут");
    expect(h).toContain("недоступен: нет ключа · нужна замена, чтобы продолжить");
    expect(h.indexOf("Ещё кругов")).toBeLessThan(h.indexOf("result-replace"));
    expect(h.indexOf("result-replace")).toBeLessThan(h.indexOf("result-resume__people"));
    expect(find(ResumePanelView(panelProps({ view: v, onReplace: (i) => got.push(i) })), (p) => p.children === "Заменить").length).toBe(2);
    (button(ResumePanelView(panelProps({ view: v, onReplace: (i) => got.push(i) })), "Заменить").onClick as () => void)();
    expect(got).toEqual(["p2"]);
  });
  it("no available providers: button disabled with a hint; without a replaceable there is no section", () => {
    const h = panel({ view: rv({ providers: [prov("b", { available: false }), prov("c", { models: [] })] }) });
    expect(h).toContain("нет доступных провайдеров");
    expect(h).toMatch(/<button type="button" class="btn btn--sm" disabled=""[^>]*>Заменить/);
    expect(panel()).not.toContain("result-replace");
  });
  it("a choice made: two lists from the catalog and «Do not replace»", () => {
    const h = panel({ view: rv(), choices: { p2: { providerId: "a", model: "m2" } } });
    expect(h).toContain('aria-label="Провайдер замены: Имя2 (м2)"');
    expect(h).toContain('aria-label="Модель замены: Имя2 (м2)"');
    expect(h).toContain("Пров b — недоступен");
    expect(h).toContain(">по умолчанию</option>");
    expect(h).toContain(">m2</option>");
    expect(h).toContain("Не заменять");
    expect(h).not.toMatch(/>Заменить<\/button>/);
  });
  it("defaultChoice: the first available provider with models", () => {
    expect(defaultChoice([prov("b", { available: false }), prov("c", { models: [] }), prov("a")])).toEqual({ providerId: "a", model: "m1" });
    expect(defaultChoice([prov("b", { available: false })])).toBeNull();
  });
  it("a change of provider and model reaches the handlers", () => {
    const got: unknown[] = [];
    const t = ResumePanelView(panelProps({ view: rv(), choices: { p2: { providerId: "a", model: "m1" } }, onProvider: (i, x) => got.push(["p", i, x]), onModel: (i, x) => got.push(["m", i, x]) }));
    (find(t, (p) => p["aria-label"] === "Провайдер замены: Имя2 (м2)")[0]!.onChange as (e: unknown) => void)({ target: { value: "b" } });
    (find(t, (p) => p["aria-label"] === "Модель замены: Имя2 (м2)")[0]!.onChange as (e: unknown) => void)({ target: { value: "m2" } });
    expect(got).toEqual([["p", "p2", "b"], ["m", "p2", "m2"]]);
  });
  it("a refusal of recalculation is visible in the replacement section", () => {
    expect(panel({ view: rv(), refreshError: "Модель недоступна" })).toContain("Модель недоступна");
  });
});

describe("Result: participant list, notes, spending", () => {
  it("chip of the replacing participant with the number and color by identifier; for a known id the number from the session", () => {
    const v = rview({ participants: [person(1, "free"), person(3, "free", { id: "p9", name: "Новый", replaces: "p2" })] });
    const h = panel({ view: v });
    expect(h).toContain("p9 · вместо p2 «Имя2»");
    expect(h).toContain('class="result-resume__person" data-p="1"');
    expect(h).toMatch(/result-resume__person" data-p="1"[^]*<span class="avatar" data-p="1">9<\/span>/);
  });
  it("blocked: alarm line, «Continue» disabled", () => {
    const h = panel({ view: rview({ blocked: "Активных участников меньше двух." }) });
    expect(h).toMatch(/result-resume__note" data-tone="danger"><svg[^>]*><use href="#i-alert"[^]*Активных участников меньше двух\./);
    expect(goBtn(h)).toContain('disabled=""');
  });
  it("agreementReset: warning", () => {
    expect(panel({ view: rview({ agreementReset: true }) })).toContain("После замены все согласия сбрасываются: каждый активный участник подтверждает текущую версию заново");
    expect(panel()).not.toContain("согласия сбрасываются");
  });
  it("the line of an unavailable participant offers a replacement", () => {
    const v = rview({ participants: [person(1, "free", { available: false, reason: "нет ключа" })] });
    expect(panel({ view: v })).toContain("Имя1 (м1) недоступен: нет ключа. Замените участника или исправьте настройку провайдера и откройте панель заново.");
  });
  it("tokens spent: with a ceiling and without", () => {
    expect(panel({ view: rview({ tokenCap: { cap: 5000, spent: 1500, exhausted: false } }) })).toContain("Израсходовано 1500 токенов, потолок 5000");
    expect(panel()).toContain("Израсходовано 0 токенов, потолка нет");
    expect(panel({ view: rview({ tokenCap: { cap: 1000, spent: 11, exhausted: false } }) })).toContain("Израсходовано 11 токенов, потолок 1000");
    expect(panel({ view: rview({ tokenCap: { cap: 21, spent: 1, exhausted: false } }) })).toContain("Израсходовано 1 токен, потолок 21");
    expect(panel({ view: rview({ tokenCap: { cap: 1, spent: 1, exhausted: true } }) })).toContain("Потолок 1, израсходовано 1 токен: ");
  });
  it("«Continue» disabled: recalculation in progress, recalculation failed, replacement with an empty model", () => {
    expect(goBtn(panel({ refreshing: true }))).toContain('disabled=""');
    expect(goBtn(panel({ refreshError: "сбой" }))).toContain('disabled=""');
    expect(goBtn(panel({ view: rv(), choices: { p2: { providerId: "a", model: "" } } }))).toContain('disabled=""');
    expect(goBtn(panel({ view: rv(), choices: { p2: { providerId: "a", model: "m1" } } }))).not.toContain("disabled");
  });
});

describe("Result: recalculation and submission with replacements", () => {
  const v1 = rview({ rounds: { min: 1, max: 20, remaining: 1, initial: 1 } });
  const v2 = rview({ rounds: { min: 1, max: 20, remaining: 1, initial: 2 } });
  const ch = { p2: { providerId: "a", model: "m1" } };
  it("without a choice a call of resumeOptions(id), with a choice — with the map", async () => {
    const calls: unknown[][] = [];
    const call = async (...a: unknown[]) => { calls.push(a); return v1; };
    await refreshResume(call, "s1", {}, { current: 0 });
    await refreshResume(call, "s1", ch, { current: 0 });
    expect(calls).toEqual([["s1"], ["s1", [{ participantId: "p2", providerId: "a", model: "m1" }]]]);
  });
  it("only the response to the last request is applied", async () => {
    const seq = { current: 0 };
    let late!: (v: ResumeView) => void;
    const first = refreshResume(() => new Promise<ResumeView>((r) => { late = r; }), "s1", ch, seq);
    const second = await refreshResume(async () => v2, "s1", {}, seq);
    late(v1);
    expect(await first).toBeNull();
    expect(second).toEqual({ ok: true, value: v2 });
  });
  it("a refusal returns the error text", async () => {
    expect(await refreshResume(async () => { throw new Error("карта отклонена"); }, "s1", ch, { current: 0 })).toEqual({ ok: false, error: "карта отклонена" });
  });
  it("submitResume: replacements as the fourth argument, without replacements the old call forms", async () => {
    const calls: unknown[][] = [];
    const call = async (...a: unknown[]) => { calls.push(a); return { droppedOwnerRequests: [] }; };
    const reps = [{ participantId: "p2", providerId: "a", model: "m1" }];
    await submitResume(call, "s1", 2, { current: false }, undefined, reps);
    await submitResume(call, "s1", 2, { current: false }, 3000, reps);
    await submitResume(call, "s1", 2, { current: false }, undefined, []);
    expect(calls).toEqual([["s1", 2, undefined, reps], ["s1", 2, 3000, reps], ["s1", 2]]);
  });
  it("a refusal of submission leaves the form available (guard free)", async () => {
    const guard = { current: false };
    expect(await submitResume(async () => { throw new Error("нет"); }, "s1", 2, guard, undefined, [{ participantId: "p2", providerId: "a", model: "m1" }])).toEqual({ ok: false, error: "нет" });
    expect(guard.current).toBe(false);
  });
});

describe("Result: «Departed» after replacement", () => {
  const person = (n: number) => ({ id: `p${n}`, name: `Имя${n}`, providerId: "scripted", model: "м", role: null });
  const base = (drop: boolean): Body[] => [
    created(), started(1, "p1"), done(1, "p1", "amend", 1),
    ...(drop ? [{ type: "participant_dropped", participantId: "p2", reason: "таймаут" } as Body] : []),
    fin("no_consensus", 1, []),
    { type: "session_resumed", pid: 7, maxRounds: 5, replacements: [{ oldParticipantId: "p2", participant: { ...person(4), replaces: "p2" } }] } as Body,
  ];
  it("replaced after departure: «replaced» badge and both reasons", () => {
    const h = view(fold(base(true)), "no_consensus");
    expect(h).toContain("заменён участником p4 «Имя4»; выбыл: таймаут");
    expect(h).toMatch(/i-user-off"[^]*?<\/svg>заменён</);
  });
  it("replaced active one: without a departure reason and without «reason not given»", () => {
    const h = view(fold(base(false)), "no_consensus");
    expect(h).toContain("заменён участником p4 «Имя4»<");
    expect(h).not.toContain("причина не указана");
  });
});

describe("Result: replacement choice does not get stuck, providers without models", () => {
  it("pruneChoices keeps only those in replaceable", () => {
    const c = { p2: { providerId: "a", model: "m1" }, p3: { providerId: "a", model: "m2" } };
    expect(pruneChoices(c, { replaceable: [replaceable()] })).toEqual({ kept: { p2: c.p2 }, dropped: ["p3"] });
    expect(pruneChoices(c, { replaceable: [] })).toEqual({ kept: {}, dropped: ["p2", "p3"] });
    expect(pruneChoices({}, { replaceable: [] })).toEqual({ kept: {}, dropped: [] });
  });
  it("a provider without models is not offered in the replacement list", () => {
    const h = panel({ view: rv({ providers: [prov("a"), prov("empty", { models: [] })] }), choices: { p2: { providerId: "a", model: "m1" } } });
    expect(h).toContain("Пров a");
    expect(h).not.toContain("Пров empty");
  });
});

// English: process language (as without a language provider) or the language property of the views.
describe("Result: screen in English", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = <T,>(fn: () => T): T => { setProcessLanguage("en"); try { return fn(); } finally { setProcessLanguage("ru"); } };
  const props = (o: Partial<OwnerChoiceViewProps> = {}): OwnerChoiceViewProps => ({
    state: noChoice, version: 3, note: "", error: null, busy: false, saved: false, onVersion: noop, onNote: noop, onSubmit: noop, ...o,
  });
  const CYR = /[А-Яа-яЁё]/;

  // Data without Cyrillic: neither topic, names nor texts bring it into the markup.
  const lcreated: Body = {
    type: "session_created", pid: 1,
    session: {
      id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Price", templateId: null, framing: "",
      participants: [1, 2].map((i) => ({ id: `p${i}`, name: `Ann${i}`, providerId: "scripted", model: `m${i}`, role: null })),
      limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 },
    },
  };
  const ldone = (turn: number, participantId: string, stance: "amend" | "agree" | "object", version: number, usage: object = {}): Body => ({
    type: "turn_completed", turn, round: 1, participantId, stance, normalized: false, reasoning: "arg",
    solution: stance === "amend" ? `text v${version}` : null, version, questions: [], answers: [], attempts: 1, usage, durationMs: 1500,
  });
  const latinConsensus = foldTs([lcreated, started(1, "p1"), ldone(1, "p1", "amend", 1, { inputTokens: 100, costUsd: 0.5 }), started(2, "p2"), ldone(2, "p2", "agree", 1), fin("consensus", 1, ["p1", "p2"])]);
  const latinObjection = foldTs([lcreated, started(1, "p1"), ldone(1, "p1", "amend", 1), started(2, "p2"), ldone(2, "p2", "object", 1),
    fin("no_consensus", 1, ["p1"], [{ participantId: "p2", reasoning: "arg" }]), select(1, "my note")]);
  const lview = (o: Partial<ResumeView> = {}) => rview({
    participants: [person(1, "subscription", { name: "Ann1 (m1)" }), person(2, "paid", { name: "Ann2 (m2)" })],
    replaceable: [{ id: "p2", name: "Ann2 (m2)", why: "dropped" as const, reason: "timeout", required: true }],
    providers: [prov("a", { label: "Prov a" }), prov("b", { label: "Prov b", available: false })], ...o,
  });

  it("summary with agreement: heading, explanation, positions, statistics and button labels", () => {
    const h = en(() => view(agreed3, "consensus"));
    for (const w of ["Consensus reached", "All active participants accepted version 3. There are no open questions.", "Participant positions", "Agree", "agrees", "Final solution", "Topic",
      ">rounds<", ">turns<", ">duration<", "To the feed", "Copy", "Export to Markdown", "Run again", "Discuss further", "New discussion", "version 3"]) expect(h).toContain(w);
    expect(h).toContain("текст v3");
    expect(h).toContain("Цена");
    for (const w of ["Согласие достигнуто", "Позиции участников", "К ленте", "Скопировать", "кругов"]) expect(h).not.toContain(w);
  });
  it("failure with reasonCode: reason by code in English; without a code — the journal text as recorded", () => {
    const failedWith = (code: string | null) => fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), { ...fin("failed", 1, [], [], "мало участников"), reasonCode: code } as Body]);
    const coded = en(() => view(failedWith("insufficient_active_participants"), "failed"));
    expect(coded).toContain("Fewer than two active participants remain.");
    expect(coded).not.toContain("мало участников");
    expect(coded).toContain("Continue discussion");
    const plain = en(() => view(failedWith(null), "failed"));
    expect(plain).toContain("мало участников");
    expect(plain).toContain(">Failure<");
  });
  it("switching language on the same state: labels change, recorded texts stay the same", () => {
    const ru = view(agreed3, "consensus");
    const eng = en(() => view(agreed3, "consensus"));
    expect(ru).toContain("Позиции участников");
    expect(eng).toContain("Participant positions");
    expect(ru).not.toContain("Participant positions");
    for (const h of [ru, eng]) { expect(h).toContain("текст v3"); expect(h).toContain("Имя1"); expect(h).toContain("Цена"); }
  });
  it("numbers and inflection by language", () => {
    const s = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1, { inputTokens: 12000, outputTokens: 345, costUsd: 0.5 }), started(2, "p2"), done(2, "p2", "agree", 1), started(3, "p3"), done(3, "p3", "agree", 1)]);
    const eng = en(() => view(s, "stopped"));
    expect(eng).toContain("12,345");
    expect(eng).toContain("0.5 $");
    const ru = view(s, "stopped");
    expect(ru).toContain("12 345");
    expect(ru).toContain("0,5 $");
    const sess = fold([created(), started(1, "p1"), done(1, "p1", "amend", 1), { type: "turn_started", turn: 2, round: 2, participantId: "p2" } as Body, { ...done(2, "p2", "agree", 1), round: 2 } as Body, fin("no_consensus", 1, ["p2"])]);
    expect(sess.round).toBe(2);
    expect(en(() => view(sess, "no_consensus"))).toContain("2 rounds of 4 completed.");
    expect(view(sess, "no_consensus")).toContain("Пройдено 2 круга из 4.");
  });
  it("continuation panel: replacement, agreement reset, estimate, spending, blocking", () => {
    const got: string[] = [];
    const v = lview({ agreementReset: true, tokenCap: { cap: 5000, spent: 1, exhausted: false }, participants: [person(1, "subscription", { name: "Ann1 (m1)" }), person(2, "paid", { name: "Ann2 (m2)", available: false, reason: "no key" })] });
    const props = panelProps({ language: "en", view: v, text: "2", onReplace: (i) => got.push(`r${i}`), onKeep: (i) => got.push(`k${i}`), onSubmit: () => got.push("go") });
    const h = renderToStaticMarkup(<ResumePanelView {...props} />);
    for (const w of ["Participant replacement", "dropped out: timeout · a replacement is required to continue", ">Replace<", "After a replacement all agreements are reset",
      "at most 12 calls to models · 2 participants × 2 rounds × 3", "1 token spent, cap 5000", "Ann2 (m2) is unavailable: no key. Replace the participant", "More rounds", "uses subscription", "billed per call", ">Cancel<"]) expect(h).toContain(w);
    expect(h).toContain("Continue</button>");
    expect(h.match(/<button type="button" class="btn"[^>]*>/)![0]).toContain('disabled=""');
    (button(ResumePanelView(props), "Replace").onClick as () => void)();
    const chosenProps = { ...props, choices: { p2: { providerId: "a", model: "m1" } }, onKeep: (i: string) => got.push(`k${i}`) };
    const c = renderToStaticMarkup(<ResumePanelView {...chosenProps} />);
    expect(c).toContain('aria-label="Replacement provider: Ann2 (m2)"');
    expect(c).toContain('aria-label="Replacement model: Ann2 (m2)"');
    expect(c).toContain("Prov b — unavailable");
    expect(c).toContain(">default</option>");
    (button(ResumePanelView(chosenProps), "Keep").onClick as () => void)();
    const ok = panelProps({ language: "en", view: lview(), text: "2", onSubmit: () => got.push("go") });
    (button(ResumePanelView(ok), "Continue").onClick as () => void)();
    expect(got).toEqual(["rp2", "kp2", "go"]);
  });
  it("panel: departure reason from the journal as recorded; no providers; ceiling", () => {
    const h = renderToStaticMarkup(<ResumePanelView {...panelProps({ language: "en", view: lview({ replaceable: [{ id: "p2", name: "Ann2 (m2)", why: "dropped", reason: "таймаут", required: false }], providers: [], tokenCap: { cap: 1200, spent: 1500, exhausted: true } }), capText: "1500" })} />);
    expect(h).toContain("dropped out: таймаут");
    expect(h).toContain("no available providers");
    expect(h).toContain("Cap 1200, 1500 tokens spent: to continue, set a new cap or remove it");
    expect(h).toContain('placeholder="above 1500"');
    expect(h).toContain("Remove the cap");
    expect(h).toContain("Must be above 1500");
  });
  it("owner choice: labels and summary in English, note as typed; refusal with Russian text", () => {
    const sel = renderToStaticMarkup(<OwnerChoiceView {...props({ language: "en", state: chosen1 })} />);
    for (const w of ["Owner&#x27;s choice", "Version 1 · author Имя1", "status at the time of the choice: no consensus", "This is your choice, not the models&#x27; consensus.", "The objections refer to the final version 3, not to the chosen one.", "Note: моя заметка", "Version 3 · Имя3", "Note (optional)", "Accept version"]) expect(sel).toContain(w);
    const err = renderToStaticMarkup(<OwnerChoiceView {...props({ language: "en", note: "введено", error: "Отказ записи", saved: true })} />);
    expect(err).toContain(">введено</textarea>");
    expect(err).toContain("Отказ записи");
    expect(err).toContain("Accept version");
    expect(err).not.toContain("Choice saved.");
    expect(renderToStaticMarkup(<OwnerChoiceView {...props({ language: "en", saved: true })} />)).toContain("Choice saved.");
    expect(renderToStaticMarkup(<OwnerChoiceView {...props({ language: "en", state: fold([created()]) })} />)).toContain("A version can be accepted after the session ends.");
  });
  it("formatDuration and resumeCap in English", () => {
    expect(formatDuration(45_000, "en")).toBe("45 s");
    expect(formatDuration(372_000, "en")).toBe("6 min 12 s");
    expect(formatDuration(3_900_000, "en")).toBe("1 h 5 min");
    const ex = { cap: 1200, spent: 1500, exhausted: true };
    expect(resumeCap(ex, "1500", false, "en").why).toBe("Must be above 1500");
    expect(resumeCap(ex, "x", false, "en").why).toBe("An integer above 1500 is required");
  });
  it("English markup without Cyrillic when the data has no Cyrillic", () => {
    const html = en(() => [
      view(latinConsensus, "consensus"), view(latinObjection, "no_consensus"),
      renderToStaticMarkup(<ResumePanelView {...panelProps({ language: "en", view: lview({ agreementReset: true, blocked: null, tokenCap: { cap: 10, spent: 20, exhausted: true } }), session: latinConsensus.session })} />),
      renderToStaticMarkup(<ResumePanelView {...panelProps({ language: "en", view: lview({ allowed: false, reason: null }), session: latinConsensus.session })} />),
      renderToStaticMarkup(<OwnerChoiceView {...props({ language: "en", state: latinObjection })} />),
    ]);
    html.forEach((h) => expect(h).not.toMatch(CYR));
  });
});

describe("Result: journal read only partially", () => {
  const part = { reason: "newer_version" as const, lastEvent: 12 };
  const msg = "Сессия записана более новой версией приложения. Показано начало журнала до события №12.";
  const withPartial = (p: typeof part | null) => renderToStaticMarkup(
    <Result id="s1" state={noChoice} status="interrupted" notice={null} partial={p} onCopy={noop} onExport={noop} onFeed={noop} onNew={noop} onResume={noop} />);
  const btn = (h: string, word: string) => h.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${word}`))![0];
  it("«Continue discussion» and «Accept version» are inactive with a reason; «new version needed» badge", () => {
    const h = withPartial(part);
    expect(h).toContain(msg);
    expect(btn(h, "Продолжить обсуждение")).toContain("disabled");
    expect(btn(h, "Принять версию")).toContain("disabled");
    expect(choiceCard(h)).toContain(msg);
    expect(h).toContain("нужна новая версия");
    expect(h).not.toContain(">Обсуждение прервано<");
    expect(h).not.toContain("прервана");
  });
  it("Copy, export, «Discuss further» and «Retry» work", () => {
    const h = withPartial(part);
    for (const w of ["Скопировать итог", "Экспорт в Markdown", "Обсудить дальше", "Запустить заново"]) expect(btn(h, w)).not.toContain("disabled");
  });
  it("interrupted with an open wait: no wait note, with partial it is present", () => {
    const waiting: SessionState = { ...noChoice, waiting: { waitId: "w1", reasons: ["round_boundary"], questionIds: [], afterTurn: 7, deadline: "2026-10-09T07:46:32Z", startedAt: "2026-10-09T07:42:00Z" } };
    const r = (p: typeof part | null) => renderToStaticMarkup(
      <Result id="s1" state={waiting} status="interrupted" notice={null} partial={p} onCopy={noop} onExport={noop} onFeed={noop} onNew={noop} />);
    expect(r(part)).not.toContain("Прервано во время ожидания владельца");
    expect(r(part)).not.toContain("Обсуждение прервано");
    expect(r(null)).toContain("Прервано во время ожидания владельца");
  });
  it("without partial the buttons are as before", () => {
    const h = withPartial(null);
    expect(btn(h, "Продолжить обсуждение")).not.toContain("disabled");
    expect(btn(h, "Принять версию")).not.toContain("disabled");
    expect(h).toContain(">Обсуждение прервано<");
    expect(h).not.toContain("более новой версией");
  });
});

describe("Result: markup per osen mockup", () => {
  const statuses: ResultStatus[] = ["consensus", "no_consensus", "stopped", "failed", "interrupted"];
  const topbar = (h: string) => h.slice(h.indexOf("topbar__actions"), h.indexOf("</header>"));
  it.each(statuses)("%s: one primary button «Copy summary» in the upper panel, without btn--sm", (status) => {
    const t = topbar(view(agreed3, status));
    expect(t.match(/btn--primary/g)).toHaveLength(1);
    expect(t).toMatch(/btn btn--primary"[^>]*>(<svg[^]*?<\/svg>)?Скопировать итог/);
    expect(t).not.toContain("btn--sm");
    expect(t).toMatch(/class="btn btn--ghost"[^>]*>(<svg[^]*?<\/svg>)?К ленте/);
  });
  const whenView = (when?: string) => renderToStaticMarkup(<Result state={agreed3} status="consensus" notice={null} when={when} onCopy={noop} onExport={noop} onFeed={noop} onNew={noop} />);
  it("session date in the summary header only with when", () => {
    expect(whenView("2026-01-01T09:05:00Z")).toMatch(/<span class="result-hero__when mono">[^<]+<\/span>/);
    expect(whenView()).not.toContain("result-hero__when");
  });
  it("version — chip mono info; author: avatar, name without model, model as a tag", () => {
    const h = view(agreed3, "consensus");
    expect(h).toContain('class="chip mono" data-tone="info"');
    expect(h).toMatch(/<span class="result-author"><span class="avatar avatar--sm"[^>]*>3<\/span><span>Имя3<\/span><span class="tag">мод3<\/span><\/span>/);
    expect(h).not.toContain("Имя3 (мод3)");
    expect(h).toContain('<section class="card result-solution">');
  });
  it("model default is not shown as a tag", () => {
    const c = created() as any;
    c.session.participants = c.session.participants.map((p: any) => ({ ...p, model: "default" }));
    const s = fold([c, started(1, "p1"), done(1, "p1", "amend", 1), fin("stopped", 1, ["p1"])]);
    const h = view(s, "stopped");
    expect(h).not.toContain('class="tag"');
  });
  it("spending tiles without icons, label and value separately", () => {
    const h = view(agreed3, "consensus");
    const row = h.slice(h.indexOf('class="stat-row result-stats"'), h.indexOf("result-side") + 6000);
    const tiles = row.slice(0, row.indexOf("</aside>") < 0 ? undefined : row.indexOf("</aside>"));
    expect(h).toContain('<div class="stat-row result-stats">');
    expect(tiles).toContain('<div class="stat"><div class="stat__label">кругов</div><div class="stat__value mono">');
    expect(tiles).not.toContain("result-stat-head");
    expect(tiles.slice(0, tiles.indexOf("result-note") < 0 ? undefined : tiles.indexOf("result-note"))).not.toContain("<svg");
  });
  it("positions: name without model, model as a tag, quote without data-p", () => {
    const s = fold([
      created(), started(1, "p1"), done(1, "p1", "amend", 1), started(2, "p2"), done(2, "p2", "object", 1, {}, "дорого"),
      fin("no_consensus", 1, ["p1"], [{ participantId: "p2", reasoning: "дорого" }]),
    ]);
    const h = view(s, "no_consensus");
    const side = h.slice(h.indexOf("result-side"));
    expect(side).toMatch(/<span class="result-person__name">Имя2 <span class="tag">мод2<\/span><\/span>/); // the model is inside the name, as in the reference: the state chip stays in the row
    expect(side).not.toContain('result-person" data-p');
    expect(side).not.toContain("result-quote\" data-p");
    expect(side).toContain('<blockquote class="result-quote">дорого</blockquote>');
  });
  const solved = (text: string) => {
    const c = created();
    return fold([c, started(1, "p1"), { ...done(1, "p1", "amend", 1), solution: text } as Body, fin("stopped", 1, ["p1"])]);
  };
  it("numbered decision — ol.result-list without digits in the items", () => {
    const h = view(solved("1. a\n2. b\n3. c\n4. d"), "stopped");
    expect(h.match(/<li>/g)).toHaveLength(4);
    expect(h).toContain('<div class="prose result-prose"><ol class="result-list"><li>a</li><li>b</li><li>c</li><li>d</li></ol></div>');
  });
  it("plain text — paragraph without ol", () => {
    const h = view(solved("просто текст"), "stopped");
    expect(h).not.toContain("<ol");
    expect(h).toContain('<div class="prose result-prose session-view__text">просто текст</div>');
  });
  it("owner choice: fields in one row, note on one line, «Accept version» not primary", () => {
    const h = renderToStaticMarkup(<OwnerChoiceView state={noChoice} version={3} note="" error={null} busy={false} saved={false} onVersion={noop} onNote={noop} onSubmit={noop} />);
    const row = h.slice(h.indexOf("result-choice__row"), h.indexOf("result-choice__actions"));
    expect(row).toContain("<select");
    expect(row).toContain("<textarea");
    expect(row).toContain('rows="1"');
    expect(h).not.toContain("btn--primary");
    expect(h).toMatch(/class="btn"[^>]*>Принять версию/);
  });
  it("continuation panel: «Continue» not primary", () => {
    expect(panel()).not.toContain("btn--primary");
  });
});

describe("Result: statistics diverge from the core only on failures", () => {
  const failedTurn = (turn: number, participantId: string, attempt: number, usage: object): Body =>
    ({ type: "turn_failed", turn, round: 1, participantId, attempt, kind: "invalid_response", message: "x", usage }) as Body;
  it("p2 failures with spending are included in tokens, as in the session counter", () => {
    const s = fold([
      created(), started(1, "p1"), done(1, "p1", "amend", 1, { inputTokens: 5, outputTokens: 5 }),
      started(2, "p2"), failedTurn(2, "p2", 1, { inputTokens: 100, outputTokens: 20 }), failedTurn(2, "p2", 2, { inputTokens: 100, outputTokens: 20 }),
      { type: "participant_dropped", participantId: "p2", reason: "невалидные ответы" } as Body,
      started(3, "p3"), done(3, "p3", "agree", 1, { inputTokens: 3, outputTokens: 2 }),
    ]);
    const r = resultStats(s);
    expect(r.tokens).toBe(255);
    expect(r.tokens).toBe(tokenUsage(s).total);
    expect(r.tokens).toBe(spend(s).total);
    expect(r.tokensFrom).toContain("p2");
    expect(r.tokensFrom).toEqual(["p1", "p2", "p3"]);
  });
  it("without failures and with an accepted draft the sums are as before", () => {
    const s = fold([
      created(), { type: "draft_attempt_started", draftId: "d1", participantId: "p1", attempt: 1 } as Body,
      { type: "draft_completed", draftId: "d1", participantId: "p1", attempts: 1, durationMs: 10, usage: { inputTokens: 60, outputTokens: 40 }, chars: 5, sha256: "a".repeat(64), reasoning: "r" } as Body,
      { type: "drafts_finished" } as Body, started(1, "p1"), done(1, "p1", "amend", 1, { outputTokens: 50 }),
    ]);
    expect(resultStats(s)).toMatchObject({ tokens: 150, turns: 1, tokensPartial: false });
  });
});
