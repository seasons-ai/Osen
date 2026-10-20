import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { LanguageProvider } from "./language.tsx";
import { initialState } from "@model-council/core/protocol";
import type { QuestionState, Session } from "@model-council/core/protocol";
import { FinishedDraft, FinishedDraftView, OwnerComposer, OwnerComposerView, copyDraft, deleteFinishedDraft, hasOwnerDraft, readDraft, saveDraft, saveFinishedText, sendOwner } from "./OwnerComposer.tsx";
import type { OwnerComposerViewProps } from "./OwnerComposer.tsx";

const session = {
  id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Цена", templateId: null, framing: "",
  participants: [{ id: "p1", name: "Имя1", providerId: "scripted", model: "m", role: null }],
  limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
} as unknown as Session;
const q = (o: Partial<QuestionState> = {}): QuestionState => ({ id: "q3", from: "p1", to: "owner", text: "Какой формат?", turn: 1, status: "open", answer: null, ...o });
const view = (o: Partial<OwnerComposerViewProps> = {}) => renderToStaticMarkup(
  <OwnerComposerView session={session} questions={[]} text="" answerTo={null} error={null} sending={false}
    onText={() => {}} onAnswer={() => {}} onCancelAnswer={() => {}} onSubmit={() => {}} {...o} />,
);
const submitBtn = (h: string) => h.match(/<button type="submit"[^>]*>/)![0];

describe("OwnerComposerView", () => {
  it("textRef is passed to the existing textarea", () => {
    const textRef = { current: null };
    // The view calls language hooks: a direct function call is only possible inside rendering.
    let tree: ReactNode = null;
    const Probe = (): null => {
      tree = OwnerComposerView({ session, questions: [], text: "", answerTo: null, error: null, sending: false,
        onText: () => {}, onAnswer: () => {}, onCancelAnswer: () => {}, onSubmit: () => {}, textRef });
      return null;
    };
    renderToStaticMarkup(<Probe />);
    function textarea(n: ReactNode): ReactElement<{ ref?: unknown; children?: ReactNode }> | undefined {
      if (Array.isArray(n)) return n.map(textarea).find((el) => el !== undefined);
      if (n && typeof n === "object" && "type" in n) {
        const el = n as ReactElement<{ ref?: unknown; children?: ReactNode }>;
        return el.type === "textarea" ? el : textarea(el.props.children);
      }
      return undefined;
    }
    expect(textarea(tree)?.props.ref).toBe(textRef);
  });
  it("empty field: «Send» unavailable, hint present, no questions", () => {
    const h = view();
    expect(h).toContain("Реплика владельца");
    expect(h).toContain("После реплики все участники подтверждают согласие заново");
    expect(submitBtn(h)).toContain('disabled=""');
    expect(h).not.toContain("Вопросы к вам");
    expect(h).not.toContain("Отменить ответ");
    expect(h).not.toContain('role="alert"');
  });
  it("spaces — unavailable; text — available; sending — unavailable", () => {
    expect(submitBtn(view({ text: "  \n " }))).toContain('disabled=""');
    expect(submitBtn(view({ text: "Уточняю" }))).not.toContain("disabled");
    expect(submitBtn(view({ text: "Уточняю", sending: true }))).toContain('disabled=""');
  });
  it("open questions: id, author, text, «Reply»", () => {
    const h = view({ questions: [q(), q({ id: "q4", text: "Второй" })] });
    expect(h).toContain("Вопросы к вам");
    expect(h).toContain(">q3<");
    expect(h).toContain("Имя1");
    expect(h).toContain("Какой формат?");
    expect(h.match(/>Ответить</g)).toHaveLength(2);
    expect(h.indexOf("q3")).toBeLessThan(h.indexOf("q4"));
  });
  it("reply mode: label and «Cancel reply»", () => {
    const h = view({ answerTo: "q3" });
    expect(h).toContain("Ответ на вопрос q3");
    expect(h).toContain("Отменить ответ");
    expect(h).not.toContain("Реплика владельца");
  });
  it("error: alert, tone, icon, text preserved", () => {
    const h = view({ error: "Вопрос уже закрыт", text: "Мой ответ", answerTo: "q3" });
    expect(h).toMatch(/class="session-composer__error" data-tone="danger" role="alert"><svg[^>]*><use href="#i-alert"/);
    expect(h).toContain("Вопрос уже закрыт");
    expect(h).toContain(">Мой ответ</textarea>");
  });
  it("HTML in the question and reason is escaped", () => {
    const h = view({ questions: [q({ text: "<b>x</b>" })], error: "<i>y</i>" });
    expect(h).not.toContain("<b>x</b>");
    expect(h).not.toContain("<i>y</i>");
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(h).toContain("&lt;i&gt;y&lt;/i&gt;");
  });
});

describe("sendOwner", () => {
  it("success: id, text, undefined go to the bridge", async () => {
    const calls: unknown[][] = [];
    const r = await sendOwner(async (...a) => { calls.push(a); return { requestId: "r1" }; }, "s1", "текст", null);
    expect(r).toEqual({ ok: true, requestId: "r1" });
    expect(calls).toEqual([["s1", "текст", undefined]]);
  });
  it("answerTo is passed", async () => {
    const calls: unknown[][] = [];
    await sendOwner(async (...a) => { calls.push(a); return { requestId: "r2" }; }, "s1", "ответ", "q3");
    expect(calls).toEqual([["s1", "ответ", "q3"]]);
  });
  it("refusal: the reason message", async () => {
    const r = await sendOwner(async () => { throw new Error("Сессия уже завершена"); }, "s1", "t", null);
    expect(r).toEqual({ ok: false, error: "Сессия уже завершена" });
  });
});

describe("OwnerComposerView: en", () => {
  afterEach(() => setProcessLanguage("ru"));
  const en = (o: Partial<OwnerComposerViewProps> = {}) => { setProcessLanguage("en"); return view(o); };
  const cyr = /[А-Яа-яЁё]/;

  it("empty field: labels and hint", () => {
    const h = en();
    expect(h).toContain("Owner&#x27;s message");
    expect(h).toContain('placeholder="A clarification, a course correction or a reply to the participants"');
    expect(h).toContain("After a message all participants confirm their agreement again");
    expect(h).toContain(">Send</button>");
    expect(h).not.toContain("Questions for you");
    expect(h).not.toMatch(cyr);
  });
  it("questions to you and «Answer»", () => {
    const h = en({ questions: [q(), q({ id: "q4", text: "Второй" })] });
    expect(h).toContain("Questions for you");
    expect(h.match(/>Answer</g)).toHaveLength(2);
    expect(h).toContain("Какой формат?");
    expect(h).toContain("Имя1");
  });
  it("reply mode: label and cancel", () => {
    const h = en({ answerTo: "q3" });
    expect(h).toContain("Answer to question q3");
    expect(h).toContain("Cancel answer");
    expect(h).not.toContain("Owner&#x27;s message");
  });
  it("the same properties in two languages: the reply text and the refusal are the same, labels differ", () => {
    const o = { text: "Уточняю формат", answerTo: "q3", error: "Вопрос уже закрыт" };
    const e = en(o);
    setProcessLanguage("ru");
    const r = view(o);
    for (const h of [e, r]) { expect(h).toContain(">Уточняю формат</textarea>"); expect(h).toContain("Вопрос уже закрыт"); }
    expect(e).toContain("Answer to question q3"); expect(e).toContain(">Send<");
    expect(r).toContain("Ответ на вопрос q3"); expect(r).toContain(">Отправить<");
  });
  it("language from the context when the process language is ru", () => {
    const ctx = (language: Language) => renderToStaticMarkup(
      <LanguageProvider initial={{ language, source: "file", locked: false }}>
        <OwnerComposerView session={session} questions={[q()]} text="Уточняю" answerTo={null} error={null} sending={false}
          onText={() => {}} onAnswer={() => {}} onCancelAnswer={() => {}} onSubmit={() => {}} />
      </LanguageProvider>);
    const e = ctx("en"), r = ctx("ru");
    for (const t of ["Questions for you", ">Answer<", ">Send<"]) expect(e).toContain(t);
    for (const t of ["Вопросы к вам", ">Ответить<", ">Отправить<"]) expect(r).toContain(t);
    for (const h of [e, r]) expect(h).toContain(">Уточняю</textarea>");
  });
  it("the lineup does not depend on the language", () => {
    const tags = (h: string) => [...h.matchAll(/<([a-z0-9]+)/g)].map((m) => m[1]).join(",");
    for (const o of [{}, { questions: [q()], answerTo: "q3", text: "а" }, { error: "x", sending: true, text: "б" }] as Partial<OwnerComposerViewProps>[]) {
      const e = en(o);
      setProcessLanguage("ru");
      expect(tags(e)).toBe(tags(view(o)));
    }
  });
});

// Defect from change 58's live check: leaving for «Settings» with a language switch unmounted the screen, and the typed reply was lost.
describe("OwnerComposer: the reply draft survives leaving the screen", () => {
  afterEach(() => { setProcessLanguage("ru"); saveDraft("s1", null); });
  const state = { ...initialState(), session };
  const mount = () => renderToStaticMarkup(<OwnerComposer id="s1" state={state} onSent={() => {}} />);

  it("a saved draft is shown when the screen is opened again in both languages", () => {
    saveDraft("s1", { text: "Черновик реплики DRAFT", answerTo: "q3" });
    const ru = mount();
    setProcessLanguage("en");
    const en = mount();
    for (const h of [ru, en]) expect(h).toContain(">Черновик реплики DRAFT</textarea>");
    expect(ru).toContain("Ответ на вопрос q3");
    expect(en).toContain("Answer to question q3");
  });

  it("one session's draft is not visible in another; a cleared one does not come back", () => {
    saveDraft("s1", { text: "Только для s1", answerTo: null });
    expect(renderToStaticMarkup(<OwnerComposer id="s2" state={state} onSent={() => {}} />)).not.toContain("Только для s1");
    saveDraft("s1", null);
    expect(mount()).not.toContain("Только для s1");
  });
});

describe("OwnerComposerView: osen look (89)", () => {
  it("label above the field, hint on the left and primary «Send» on the right in one row", () => {
    const h = view({ text: "Уточняю" });
    expect(h.indexOf('field__label">Реплика владельца<')).toBeLessThan(h.indexOf("<textarea"));
    expect(h).toMatch(/<div class="session-composer__row"><span class="field__hint">После реплики все участники подтверждают согласие заново<\/span><button type="submit" class="btn btn--primary">Отправить<\/button><\/div>/);
  });
  it("«Questions to you»: question block with warn tone, 22 px avatar and name without the model", () => {
    const h = view({ questions: [q()] });
    expect(h).toContain('<div class="session-owner-q" data-tone="warn"><div class="session-owner-q__head"><span class="mono">q3</span><span class="session-who"><span class="avatar avatar--sm">1</span> Имя1</span></div>');
  });
});

describe("finished-session draft field", () => {
  const draftId = "fd1";
  afterEach(() => saveDraft(draftId, null));
  const field = (fallback: ReactNode = null) => renderToStaticMarkup(<FinishedDraft id={draftId} fallback={fallback} />);

  it("hasOwnerDraft: only a non-blank text counts", () => {
    expect(hasOwnerDraft(draftId)).toBe(false);
    saveDraft(draftId, { text: " \n ", answerTo: null });
    expect(hasOwnerDraft(draftId)).toBe(false);
    saveDraft(draftId, { text: "Учтите бюджет", answerTo: null });
    expect(hasOwnerDraft(draftId)).toBe(true);
  });
  it("shows the text in an editable field, caption and buttons, no Send", () => {
    saveDraft(draftId, { text: "Учтите бюджет", answerTo: null });
    const h = field();
    expect(h).toContain('data-state="finished-draft"');
    expect(h).toMatch(/<textarea[^>]*>Учтите бюджет<\/textarea>/);
    expect(h).not.toMatch(/<textarea[^>]*disabled/);
    expect(h).toContain("Сессия завершилась, пока вы писали. Текст сохранён.");
    expect(h).toContain(">Скопировать текст<");
    expect(h).toContain(">Удалить черновик<");
    expect(h).not.toContain(">Отправить<");
    expect(h).not.toContain('type="submit"');
  });
  it("answer binding is dropped: no label, stored answerTo becomes null, text kept", () => {
    saveDraft(draftId, { text: "Ответ про цену", answerTo: "q2" });
    const h = field();
    expect(h).not.toContain("Ответ на вопрос q2");
    expect(h).toContain("Ответ про цену");
    expect(readDraft(draftId)).toEqual({ text: "Ответ про цену", answerTo: null });
  });
  it("editing is saved into the same map", () => {
    saveDraft(draftId, { text: "Было", answerTo: null });
    saveFinishedText(draftId, "Стало");
    expect(field()).toContain(">Стало</textarea>");
  });
  it("copy: success and refusal", async () => {
    const calls: string[] = [];
    expect(await copyDraft(async (t) => { calls.push(t); }, "Текст")).toEqual({ ok: true });
    expect(calls).toEqual(["Текст"]);
    expect(await copyDraft(async () => { throw new Error("Буфер недоступен"); }, "Текст")).toEqual({ ok: false, error: "Буфер недоступен" });
  });
  it("view: confirmation has role status, refusal has role alert", () => {
    const base = { text: "т", copied: false, error: null, onText: () => {}, onCopy: () => {}, onDelete: () => {} };
    const ok = renderToStaticMarkup(<FinishedDraftView {...base} copied />);
    expect(ok).toMatch(/role="status"[^>]*>Текст скопирован в буфер обмена/);
    const bad = renderToStaticMarkup(<FinishedDraftView {...base} error="Буфер недоступен" />);
    expect(bad).toMatch(/role="alert"/);
    expect(bad).toContain("Буфер недоступен");
    expect(renderToStaticMarkup(<FinishedDraftView {...base} />)).not.toMatch(/role="(status|alert)"/);
  });
  it("delete removes the draft from the map", () => {
    saveDraft(draftId, { text: "Учтите", answerTo: null });
    deleteFinishedDraft(draftId);
    expect(hasOwnerDraft(draftId)).toBe(false);
    expect(readDraft(draftId)).toBeNull();
  });
});
