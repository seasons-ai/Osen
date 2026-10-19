import { Fragment, useRef, useState } from "react";
import type { ReactNode } from "react";
import { sessionTotals, tokenUsage } from "@model-council/core/protocol";
import type { JournalPartial, StoredStatus } from "@model-council/core";
import type { INSUFFICIENT_ACTIVE_REASON_CODE as InsufficientCode, OwnerSelection, Session, SessionState } from "@model-council/core/protocol";
import { formatNumber } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import type { ResumeReplacement, ResumeView } from "../../shared/bridge.ts";
import { result } from "../../shared/messages/result.ts";
import { session as sessionMessages } from "../../shared/messages/session.ts";
import { feed } from "../../shared/messages/session-feed.ts";
import { useLanguage, useMessages } from "./language.tsx";
import type { ProviderOption } from "../../shared/setup.ts";
import { objectingParticipants } from "../../shared/timeline.ts";
import { chosenVersion, finalVersion } from "../../shared/final-version.ts";
import { billingNote, callsBound, parseTokenCap } from "./setup.ts";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";
import { formatWhen } from "./History.tsx";
import { WaitInterruptedNote } from "./WaitPanel.tsx";
import { StatusBadge, statusText } from "./StatusBadge.tsx";
import { partialView } from "../../shared/partial.ts";
import { sessionActions } from "./partial-actions.ts";
import { Avatar, MaterialsRow, bareNameOf, colorOf, failReason, linkify, modelOf, nameOf, num, spend, stoppedByCap } from "./session-ui.tsx";
import { parseNumberedList } from "./solution-list.ts";

export type ResultStatus = Exclude<StoredStatus, "running">;

export interface ResultStats {
  rounds: number; turns: number; durationMs: number;
  tokens: number | null; tokensFrom: string[]; tokensPartial: boolean;
  costUsd: number | null; costFrom: string[]; costPartial: boolean;
}

export { finalVersion };

export function resultStats(state: SessionState): ResultStats {
  // Sums come from the core (the same usage records as in "History" and the session counter): there is no arithmetic of our own.
  const tot = sessionTotals(state), u = tokenUsage(state);
  const tokens = tot.inputTokens === null && tot.outputTokens === null ? null : u.total;
  return {
    rounds: state.round, turns: state.turns.length, durationMs: tot.durationMs,
    tokens, tokensFrom: tot.tokensFrom, tokensPartial: tokens !== null && u.incomplete,
    costUsd: tot.costUsd, costFrom: tot.costFrom, costPartial: tot.costIncomplete,
  };
}

export function formatDuration(ms: number, language?: Language): string {
  const t = result(language);
  const s = Math.floor(ms / 1000);
  if (s < 60) return t.durationSec(s);
  const m = Math.floor(s / 60);
  if (m < 60) return t.durationMin(m, s % 60);
  return t.durationHours(Math.floor(m / 60), m % 60);
}

export const RESULT_HEAD: Record<ResultStatus, { tone: string; icon: IconName }> = {
  consensus: { tone: "info", icon: "i-check" },
  no_consensus: { tone: "warn", icon: "i-alert" },
  stopped: { tone: "muted", icon: "i-stop" },
  failed: { tone: "danger", icon: "i-x" },
  interrupted: { tone: "muted", icon: "i-alert" },
};

// Stop by the token cap: its own icon and tone, the title comes from the catalog.
const CAP_HEAD = { tone: "warn", icon: "i-coins" } as const satisfies { tone: string; icon: IconName };

export const RESUMABLE: readonly ResultStatus[] = ["no_consensus", "stopped", "interrupted"];

const INSUFFICIENT_ACTIVE: typeof InsufficientCode = "insufficient_active_participants";

/** Three statuses can be continued, plus a failure from a lack of active participants (only with a replacement). */
export const canResume = (state: SessionState, status: ResultStatus): boolean =>
  RESUMABLE.includes(status) || (status === "failed" && state.finish?.reasonCode === INSUFFICIENT_ACTIVE);

/** Participant number for display: from the session roster, and for a newcomer not yet recorded — from its id (p3 → 3). */
export const personNum = (session: Session | null, id: string): number => num(session, id) || Number(/^p(\d+)$/.exec(id)?.[1] ?? 0);

/** The owner's replacement choice: id of the replaced participant → provider and model. */
export type ResumeChoices = Record<string, { providerId: string; model: string }>;

const toReplacements = (choices: ResumeChoices): ResumeReplacement[] =>
  Object.entries(choices).map(([participantId, c]) => ({ participantId, providerId: c.providerId, model: c.model }));

const pickable = (providers: readonly ProviderOption[]) => providers.filter((p) => p.available && p.models.length > 0);

/** Choice on pressing "Replace": the first available provider with models and its first model; null — nothing to choose from. */
export function defaultChoice(providers: readonly ProviderOption[]): ResumeChoices[string] | null {
  const p = pickable(providers)[0];
  return p ? { providerId: p.id, model: p.models[0]! } : null;
}

// Number of rounds from the field: only an integer within the view's bounds; otherwise null.
export function parseRounds(text: string, rounds: Pick<ResumeView["rounds"], "min" | "max">): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= rounds.min && n <= rounds.max ? n : null;
}

type ResumeResult<T> = { ok: true; value: T } | { ok: false; error: string };
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Request for resume parameters; while guard is busy, a second request does not go out (null). */
export async function openResume(
  call: (id: string) => Promise<ResumeView>, id: string, guard: { current: boolean },
): Promise<ResumeResult<ResumeView> | null> {
  if (guard.current) return null;
  guard.current = true;
  try { return { ok: true, value: await call(id) }; } catch (e) { return { ok: false, error: errorText(e) }; } finally { guard.current = false; }
}

/** Recomputing the view after replacements change. A response to a stale request is dropped (null): only the response to the last one is applied. */
export async function refreshResume(
  call: (id: string, replacements?: ResumeReplacement[]) => Promise<ResumeView>, id: string, choices: ResumeChoices, seq: { current: number },
): Promise<ResumeResult<ResumeView> | null> {
  const mine = ++seq.current;
  const replacements = toReplacements(choices);
  let r: ResumeResult<ResumeView>;
  try { r = { ok: true, value: await (replacements.length === 0 ? call(id) : call(id, replacements)) }; } catch (e) { r = { ok: false, error: errorText(e) }; }
  return mine === seq.current ? r : null;
}

/** Choice after recomputing: only replacements of those still in `replaceable` stay; the rest are reset (the repeated recompute runs with a smaller map). */
export function pruneChoices(choices: ResumeChoices, view: Pick<ResumeView, "replaceable">): { kept: ResumeChoices; dropped: string[] } {
  const ok = new Set(view.replaceable.map((r) => r.id));
  const ids = Object.keys(choices);
  return { kept: Object.fromEntries(ids.filter((i) => ok.has(i)).map((i) => [i, choices[i]!])), dropped: ids.filter((i) => !ok.has(i)) };
}

/** Token cap for the resume: undefined — as before, null — remove, number — new. While spend has not reached the cap, the field is not needed. */
export function resumeCap(tokenCap: ResumeView["tokenCap"], text: string, uncap: boolean, language?: Language): { value: number | null | undefined; ok: boolean; why: string | null } {
  const t = result(language);
  if (!tokenCap.exhausted) return { value: undefined, ok: true, why: null };
  if (uncap) return { value: null, ok: true, why: null };
  const n = parseTokenCap(text);
  if (n === null) return { value: undefined, ok: false, why: null };
  if (n === undefined) return { value: undefined, ok: false, why: t.capNeedInt(tokenCap.spent) };
  return n > tokenCap.spent ? { value: n, ok: true, why: null } : { value: undefined, ok: false, why: t.capNeedMore(tokenCap.spent) };
}

/** Session resume. After success guard stays busy: no repeated call, the panel closes. */
export async function submitResume(
  call: (id: string, rounds: number, maxTotalTokens?: number | null, replacements?: ResumeReplacement[]) => Promise<{ droppedOwnerRequests: string[] }>, id: string, rounds: number, guard: { current: boolean },
  maxTotalTokens?: number | null, replacements: ResumeReplacement[] = [],
): Promise<ResumeResult<string[]> | null> {
  if (guard.current) return null;
  guard.current = true;
  try {
    const done = replacements.length > 0 ? await call(id, rounds, maxTotalTokens, replacements) : await (maxTotalTokens === undefined ? call(id, rounds) : call(id, rounds, maxTotalTokens));
    return { ok: true, value: done.droppedOwnerRequests };
  } catch (e) { guard.current = false; return { ok: false, error: errorText(e) }; }
}

const BILLING_CHIP = {
  subscription: { icon: "i-coins" },
  paid: { icon: "i-coins" },
  free: { icon: "i-check" },
} as const satisfies Record<ResumeView["participants"][number]["billing"], { icon: IconName }>;

// Views are also called outside React (tests walk the tree), so the language comes as a property; without it — the process language.
export interface ResumePanelViewProps {
  language?: Language;
  session: Session | null; view: ResumeView;
  text: string; error: string | null; busy: boolean;
  capText: string; uncap: boolean;
  choices: ResumeChoices; refreshing: boolean; refreshError: string | null; // owner replacements, a view recompute in progress, the refusal of the last recompute
  focus?: string | null; // replacement row to return keyboard focus to after "Replace" and "Keep"
  onText(text: string): void; onCapText(text: string): void; onUncap(on: boolean): void; onSubmit(): void; onCancel(): void;
  onReplace(id: string): void; onKeep(id: string): void; onProvider(id: string, providerId: string): void; onModel(id: string, model: string): void;
}

export function ResumePanelView({ language, session, view, text, error, busy, capText, uncap, choices, refreshing, refreshError, focus, onText, onCapText, onUncap, onSubmit, onCancel, onReplace, onKeep, onProvider, onModel }: ResumePanelViewProps): ReactNode {
  const t = result(language);
  const { rounds } = view;
  const value = parseRounds(text, rounds);
  const blocked = view.participants.filter((p) => !p.available);
  const cap = resumeCap(view.tokenCap, capText, uncap, language);
  const chosen = Object.values(choices);
  const canGo = view.allowed && value !== null && blocked.length === 0 && view.blocked === null && !busy && cap.ok
    && !refreshing && refreshError === null && chosen.every((c) => c.model !== "");
  const bounds = t.bounds(rounds.min, rounds.max);
  const alert = (text: string) => <div className="alert" data-tone="danger" role="alert"><Icon name="i-alert" /><div><div className="alert__text">{text}</div></div></div>;
  const active = view.participants.length;
  const cost = billingNote(view.participants.map((p) => ({ label: p.name, billing: p.billing, providerBilling: p.billing })), language);
  const billWord = { subscription: t.billSubscription, paid: t.billPaid, free: t.billFree };
  return (
    <section className="card result-resume" aria-label={t.resumeLabel}>
      <h2 className="section-title">{t.continueDiscussion}</h2>
      {!view.allowed ? alert(view.reason ?? t.resumeUnavailable) : (
        <>
          <label className="field result-resume__rounds">
            <span className="field__label">{t.moreRounds}</span>
            <input className="input" type="number" min={rounds.min} max={rounds.max} value={text} aria-invalid={value === null} onChange={(e) => onText(e.target.value)} />
            <span className="field__hint" data-tone={value === null ? "danger" : undefined}>
              {value === null ? t.roundsInvalid(rounds.min, rounds.max) : bounds}{rounds.remaining !== null && t.remaining(rounds.remaining)}
            </span>
          </label>
          {view.tokenCap.exhausted && (
            <div className="result-resume__cap">
              <p className="result-resume__note" data-tone="warn"><Icon name="i-coins" size="sm" />{t.capExhausted(view.tokenCap.cap, view.tokenCap.spent)}</p>
              <label className="field result-resume__newcap"><span className="field__label">{t.newCap}</span>
                <input className="input" inputMode="numeric" placeholder={t.capPlaceholder(view.tokenCap.spent)} value={capText} disabled={uncap} onChange={(e) => onCapText(e.target.value)} /></label>
              <label className="result-resume__uncap"><input type="checkbox" checked={uncap} onChange={(e) => onUncap(e.target.checked)} /> {t.removeCap}</label>
              {cap.why && <span className="result-resume__why" data-tone="danger"><Icon name="i-alert" size="sm" />{cap.why}</span>}
            </div>
          )}
          {view.blocked !== null && <p className="result-resume__note" data-tone="danger"><Icon name="i-alert" size="sm" />{view.blocked}</p>}
          {view.replaceable.length > 0 && (
            <div className="result-replace">
              <div className="eyebrow">{t.replaceTitle}</div>
              {view.replaceable.map((r) => {
                const n = personNum(session, r.id);
                const c = choices[r.id];
                const provider = c && view.providers.find((x) => x.id === c.providerId);
                const models = provider?.models ?? [];
                const none = c === undefined && pickable(view.providers).length === 0;
                return (
                  <div className="result-replace__row" data-p={colorOf(n)} key={r.id}>
                    <div className="result-replace__who">
                      <Avatar n={n} />
                      <span className="result-person__name">{r.name}</span>
                    </div>
                    <span className="result-replace__why muted">{t.replaceWhy(r.why === "dropped", r.reason, r.required)}</span>
                    <div className="result-replace__pick">
                      {c === undefined ? (
                        <>
                          <button type="button" className="btn btn--sm" disabled={none} autoFocus={focus === r.id} onClick={() => onReplace(r.id)}>{t.replace}</button>
                          {none && <span className="muted">{t.noProviders}</span>}
                        </>
                      ) : (
                        <>
                          <select className="select" aria-label={t.replacementProvider(r.name)} autoFocus={focus === r.id} value={c.providerId} onChange={(e) => onProvider(r.id, e.target.value)}>
                            {view.providers.filter((x) => x.models.length > 0).map((x) => <option key={x.id} value={x.id}>{x.available ? x.label : t.providerUnavailable(x.label)}</option>)}
                            {!(provider && provider.models.length > 0) && <option value={c.providerId}>{c.providerId}</option>}
                          </select>
                          <select className="select" aria-label={t.replacementModel(r.name)} value={c.model} onChange={(e) => onModel(r.id, e.target.value)}>
                            {models.map((m) => <option key={m} value={m}>{m === provider?.defaultModel ? t.defaultModel : m}</option>)}
                            {c.model !== "" && !models.includes(c.model) && <option value={c.model}>{c.model}</option>}
                            {models.length === 0 && c.model === "" && <option value="">{t.noModels}</option>}
                          </select>
                          <button type="button" className="btn btn--ghost btn--sm" onClick={() => onKeep(r.id)}>{t.keep}</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
              {refreshError !== null && alert(refreshError)}
            </div>
          )}
          <ul className="result-resume__people">
            {view.participants.map((p) => {
              const chip = BILLING_CHIP[p.billing];
              return (
                <li className="result-resume__person" data-p={colorOf(personNum(session, p.id))} key={p.id}>
                  <Avatar n={personNum(session, p.id)} />
                  <span className="result-person__name">{p.name}</span>
                  {p.replaces !== undefined && <span className="chip mono">{t.insteadOf(p.id, p.replaces, nameOf(session, p.replaces, language))}</span>}
                  <span className="chip"><Icon name={chip.icon} size="sm" /> {billWord[p.billing]}</span>
                  {!p.available && <span className="result-resume__why" data-tone="danger"><Icon name="i-alert" size="sm" />{p.reason ?? t.reasonUnknown}</span>}
                </li>
              );
            })}
          </ul>
          {[...new Set(blocked.map((p) => t.blockedLine(p.name, p.reason ?? t.reasonUnknown)))].map((line) => (
            <p className="result-resume__note" data-tone="danger" key={line}>
              <Icon name="i-alert" size="sm" />{line}
            </p>
          ))}
          {view.agreementReset && <p className="result-resume__note" data-tone="warn"><Icon name="i-alert" size="sm" />{t.agreementReset}</p>}
          <div className="result-resume__cost">
            <p className="result-resume__estimate">
              {value === null || view.blocked !== null ? "—" : t.estimate(callsBound(active * value * 3 + view.draftCalls, language), active, value, view.draftCalls)}
            </p>
            <span className="muted">{cost.note}</span>
            <span className="muted">{t.spentLine(view.tokenCap.spent, view.tokenCap.cap)}</span>
          </div>
        </>
      )}
      {error !== null && alert(error)}
      <div className="result-resume__actions">
        <button type="button" className="btn" disabled={!canGo} onClick={onSubmit}>{t.resumeSubmit}</button>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>{t.cancel}</button>
      </div>
    </section>
  );
}

export function ResumePanel({ id, session, view: first, onCancel, onResumed }: {
  id: string; session: Session | null; view: ResumeView; onCancel(): void; onResumed(dropped: string[]): void;
}): ReactNode {
  const language = useLanguage();
  const [view, setView] = useState(first);
  const [text, setText] = useState(String(first.rounds.initial));
  const edited = useRef(false); // the "More rounds" field was edited by the owner: the recompute no longer touches it
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [capText, setCapText] = useState("");
  const [uncap, setUncap] = useState(false);
  const [choices, setChoices] = useState<ResumeChoices>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const guard = useRef(false);
  const seq = useRef(0);
  const [focus, setFocus] = useState<string | null>(null);
  const change = (next: ResumeChoices) => {
    setChoices(next); setRefreshing(true);
    void refreshResume((i, r) => window.council.resumeOptions(i, r), id, next, seq).then((r) => {
      if (r === null) return;
      setRefreshing(false);
      if (!r.ok) return setRefreshError(r.error);
      setRefreshError(null); setView(r.value);
      if (!edited.current) setText(String(r.value.rounds.initial));
      const { kept, dropped } = pruneChoices(next, r.value);
      if (dropped.length > 0) change(kept); // the map is strictly smaller: the loop is finite
    });
  };
  const submit = () => {
    const rounds = parseRounds(text, view.rounds);
    const cap = resumeCap(view.tokenCap, capText, uncap, language);
    if (rounds === null || busy || refreshing || refreshError !== null || !cap.ok) return;
    setBusy(true); setError(null);
    void submitResume((i, r, c, m) => window.council.resumeSession(i, r, c, m), id, rounds, guard, cap.value, toReplacements(choices)).then((r) => {
      if (r === null) return;
      if (r.ok) return onResumed(r.value); // the panel is closed by the owner of the state
      setBusy(false); setError(r.error);
    });
  };
  const withChoice = (pid: string, c: ResumeChoices[string]) => change({ ...choices, [pid]: c });
  const onReplace = (pid: string) => { const c = defaultChoice(view.providers); if (c) { setFocus(pid); withChoice(pid, c); } };
  const onKeep = (pid: string) => { const { [pid]: _gone, ...rest } = choices; setFocus(pid); change(rest); };
  const onProvider = (pid: string, providerId: string) => withChoice(pid, { providerId, model: view.providers.find((x) => x.id === providerId)?.models[0] ?? "" });
  const onModel = (pid: string, model: string) => withChoice(pid, { ...choices[pid]!, model });
  return <ResumePanelView language={language} session={session} view={view} text={text} error={error} busy={busy} capText={capText} uncap={uncap} choices={choices} refreshing={refreshing} refreshError={refreshError} focus={focus}
    onText={(t) => { edited.current = true; setText(t); }} onCapText={setCapText} onUncap={setUncap} onSubmit={submit} onCancel={onCancel}
    onReplace={onReplace} onKeep={onKeep} onProvider={onProvider} onModel={onModel} />;
}

/** Saving the owner's choice. While the request runs, a second one does not go out (null); after the response guard is free: the choice can be changed. An empty note goes out as undefined. */
export async function submitChoice(
  call: (id: string, version: number, note?: string) => Promise<OwnerSelection>, id: string, version: number, note: string, guard: { current: boolean },
): Promise<ResumeResult<OwnerSelection> | null> {
  if (guard.current) return null;
  guard.current = true;
  try { return { ok: true, value: await call(id, version, note.trim() === "" ? undefined : note) }; } catch (e) { return { ok: false, error: errorText(e) }; } finally { guard.current = false; }
}

const OWNER_NOTE_MAX = 2000; // matches the core's OWNER_NOTE_MAX: we do not pull the whole core into the renderer

export interface OwnerChoiceViewProps {
  language?: Language;
  state: SessionState;
  version: number | null; note: string; error: string | null; busy: boolean; saved: boolean;
  blocked?: string | null; // the journal was not read to the end: the reason why the choice is unavailable
  onVersion(n: number): void; onNote(text: string): void; onSubmit(): void; onCopyChoice?(): void;
}

export function OwnerChoiceView({ language, state, version, note, error, busy, saved, blocked = null, onVersion, onNote, onSubmit, onCopyChoice }: OwnerChoiceViewProps): ReactNode {
  const t = result(language);
  const { session, ownerSelection: sel, versions } = state;
  const final = finalVersion(state);
  const chosen = chosenVersion(state);
  const canForm = state.finish !== null && versions.length > 0;
  const afterResume = sel !== null && state.resumes.some((r) => Date.parse(r.ts) > Date.parse(sel.ts));
  return (
    <section className="card result-choice" aria-label={t.choiceTitle}>
      <h2 className="section-title">{t.choiceTitle}</h2>
      {sel !== null && (
        <div className="result-choice__saved">
          <p className="result-choice__summary">
            {t.choiceSummary(sel.version, chosen ? nameOf(session, chosen.authorId, language) : null, formatWhen(sel.ts, new Date(), language), statusText(sel.statusAtSelection, false, language))}
          </p>
          <p className="muted">{t.choiceYours}</p>
          {final !== null && final.number !== sel.version && <p className="muted">{t.choiceObjectionsNote(final.number)}</p>}
          {afterResume && <p className="muted">{t.choiceBeforeResume}</p>}
          {sel.note !== null && <p className="result-choice__note">{t.choiceNote(sel.note)}</p>}
          {chosen && <p><button type="button" className="btn btn--sm result-choice__copy" onClick={() => onCopyChoice?.()}><Icon name="i-copy" size="sm" />{t.copyChoice}</button></p>}
          {chosen && <div className="prose result-prose session-view__text">{linkify(chosen.text)}</div>}
        </div>
      )}
      {canForm ? (
        <div className="result-choice__form">
          <div className="result-choice__row">
            <label className="field">
              <span className="field__label">{t.versionLabel}</span>
              <select className="select" value={version ?? ""} onChange={(e) => onVersion(Number(e.target.value))}>
                {versions.map((v) => <option key={v.number} value={v.number}>{t.versionOption(v.number, nameOf(session, v.authorId, language))}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field__label">{t.noteLabel}</span>
              <textarea className="textarea" rows={1} maxLength={OWNER_NOTE_MAX} value={note} onChange={(e) => onNote(e.target.value)} />
            </label>
          </div>
          {error !== null && <div className="alert" data-tone="danger" role="alert"><Icon name="i-alert" /><div><div className="alert__text">{error}</div></div></div>}
          <div className="result-choice__actions">
            <button type="button" className="btn" disabled={busy || version === null || blocked !== null} onClick={onSubmit}>{t.accept}</button>
            {blocked !== null && <span className="muted">{blocked}</span>}
            {saved && error === null && <span className="muted" role="status">{t.choiceSaved}</span>}
          </div>
        </div>
      ) : (
        <p className="muted">{blocked ?? (state.finish === null ? t.choiceAfterFinish : t.choiceNoVersions)}</p>
      )}
    </section>
  );
}

export function OwnerChoice({ id, state, onCopyChoice, partial = null }: { id: string; state: SessionState; onCopyChoice?(): void; partial?: JournalPartial | null }): ReactNode {
  const language = useLanguage();
  const sel = state.ownerSelection;
  const [picked, setPicked] = useState<number | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const guard = useRef(false);
  const blocked = sessionActions({ status: "stopped", partial, waiting: false, hasVersion: state.versions.length > 0, finished: state.finish !== null, insufficientActive: false }, language).reason;
  const version = picked ?? sel?.version ?? finalVersion(state)?.number ?? null;
  const note = typed ?? sel?.note ?? "";
  const submit = () => {
    if (version === null || busy || blocked !== null) return;
    setBusy(true); setError(null); setSaved(false);
    void submitChoice((i, v, n) => window.council.acceptVersion(i, v, n), id, version, note, guard).then((r) => {
      if (r === null) return;
      setBusy(false);
      if (r.ok) setSaved(true); else setError(r.error);
    });
  };
  return <OwnerChoiceView language={language} state={state} version={version} note={note} error={error} busy={busy} saved={saved} blocked={blocked} onVersion={setPicked} onNote={setTyped} onSubmit={submit} onCopyChoice={onCopyChoice} />;
}

export interface ResultProps {
  id?: string; // for bridge actions; without it the "Owner's choice" block is display-only
  state: SessionState;
  status: ResultStatus;
  notice: { tone: "ok" | "danger"; text: string } | null;
  onCopy(): void; onCopyChoice?(): void; onExport(): void; onFeed(): void; onNew(): void;
  onRerun?(): void; onContinue?(): void; rerunBusy?: boolean;
  when?: string; // ISO time of the session start
  partial?: JournalPartial | null; // the journal was not read to the end
  onResume?(): void; resuming?: boolean; panel?: ReactNode; // "Continue discussion": the button, busy state during the parameter request, the open panel
}

export function Result({ id = "", state, status, notice, onCopy, onCopyChoice, onExport, onFeed, onNew, onRerun, onContinue, rerunBusy = false, onResume, resuming = false, panel = null, partial = null, when }: ResultProps): ReactNode {
  const t = useMessages(result);
  const f = useMessages(feed);
  const s = useMessages(sessionMessages);
  const language = useLanguage();
  const { session } = state;
  if (session === null) return null;
  const version = finalVersion(state);
  const stats = resultStats(state);
  const items = version ? parseNumberedList(version.text) : null;
  const hasVersion = version !== null;
  const texts: Record<ResultStatus, string> = {
    consensus: t.consensusText(String(version?.number ?? "—")),
    no_consensus: t.noConsensusText(state.round, session.limits.maxRounds, hasVersion),
    stopped: t.stoppedText(state.round, hasVersion),
    failed: failReason(state, language),
    interrupted: t.interruptedText(hasVersion),
  };
  const capStop = status === "stopped" && stoppedByCap(state);
  const sp = spend(state);
  if (capStop) texts.stopped = f.capText(sp.total, sp.cap) + (hasVersion ? t.capStopTail : "");
  const titles = { consensus: f.titleConsensus, no_consensus: f.titleNoConsensus, stopped: f.titleStopped, failed: f.titleFailed, interrupted: f.titleInterrupted };
  const h = { ...(capStop ? CAP_HEAD : RESULT_HEAD[status]), title: capStop ? f.titleCapStop : titles[status], text: texts[status] };
  const view = partialView(partial, language);
  const actions = sessionActions({ status, partial, waiting: state.waiting !== null, hasVersion, finished: state.finish !== null, insufficientActive: state.finish?.reasonCode === INSUFFICIENT_ACTIVE }, language);
  const agreed = state.finish?.agreed ?? state.agreed;
  // Outside no_consensus only one who actually objected to the current version objects.
  const objecting = objectingParticipants(state, status).map((o) => ({ ...o, reasoning: o.reasoning || t.noArgument }));
  const dropped = state.participants.filter((p) => p.status === "dropped");
  const modelTag = (id: string) => { const m = modelOf(session, id); return m && m !== "default" ? <span className="tag">{m}</span> : null; };
  const person = (id: string, off: boolean, badge: ReactNode) => (
    <div className="result-person">
      <Avatar n={num(session, id)} off={off} />
      <span className="result-person__name">{bareNameOf(session, id, language)} {modelTag(id)}</span>
      {badge}
    </div>
  );
  const badge = (tone: string, icon: IconName, word: string) => <span className="badge" data-tone={tone}><Icon name={icon} size="sm" />{word}</span>;
  const stat = (label: string, value: string) => (
    <div className="stat"><div className="stat__label">{label}</div><div className="stat__value mono">{value}</div></div>
  );
  const note = (what: (names: string) => string, from: string[]) => (
    <p className="result-note muted"><Icon name="i-info" size="sm" />{what(from.map((id) => nameOf(session, id, language)).join(", "))}</p>
  );
  return (
    <>
      <header className="topbar topbar--wrap">
        <h1 className="topbar__title row">
          <span className="session-view__topic" title={session.topic}>{session.topic}</span>
          {view ? <span className="badge" data-tone="warn"><Icon name="i-alert" size="sm" />{view.badge}</span> : <StatusBadge status={status} tokenCap={capStop} />}
        </h1>
        <div className="topbar__actions">
          <button type="button" className="btn btn--ghost" onClick={onFeed}><Icon name="i-chevron-left" size="sm" />{t.toFeed}</button>
          <button type="button" className="btn btn--primary" onClick={onCopy} disabled={version === null}><Icon name="i-copy" size="sm" />{t.copy}</button>
          <button type="button" className="btn" onClick={onExport}><Icon name="i-download" size="sm" />{t.exportMd}</button>
          <button type="button" className="btn" disabled={rerunBusy} onClick={onRerun}><Icon name="i-refresh" size="sm" />{t.rerun}</button>
          <button type="button" className="btn" disabled={version === null || rerunBusy} onClick={onContinue}><Icon name="i-reply" size="sm" />{t.discussFurther}</button>
          <button type="button" className="btn btn--ghost" onClick={onNew}><Icon name="i-plus" size="sm" />{t.newDiscussion}</button>
        </div>
      </header>
      <main className="content result-content">
        {version === null && <p className="result-note muted result-rerun-note"><Icon name="i-info" size="sm" />{t.noVersionNote}</p>}
        <section className="result-hero" data-tone={view ? view.tone : h.tone}>
          <span className="result-hero__icon"><Icon name={view ? view.icon : h.icon} size="lg" /></span>
          {view ? <div><p className="result-hero__text">{view.message}</p></div>
            : <div><h2 className="result-hero__title">{h.title}</h2><p className="result-hero__text muted">{h.text}</p></div>}
          {when && <span className="result-hero__when mono">{formatWhen(when, new Date(), language)}</span>}
          {(view ? true : canResume(state, status)) && (
            <button type="button" className="btn result-resume-btn" disabled={resuming || !actions.resume} title={actions.reason ?? undefined} onClick={onResume}><Icon name="i-play" size="sm" />{t.continueDiscussion}</button>
          )}
        </section>
        {view === null && status === "interrupted" && state.waiting !== null && <WaitInterruptedNote state={state} />}
        {notice && (
          <div className="alert" data-tone={notice.tone} role="status">
            <Icon name={notice.tone === "ok" ? "i-check" : "i-alert"} /><div className="alert__text">{notice.text}</div>
          </div>
        )}
        {panel}
        <div className="result-cols">
          <div className="result-main">
            <section className="card result-solution">
              <div className="eyebrow">{t.finalSolution}</div>
              {version ? (
                <>
                  <div className="result-meta">
                    <span className="chip mono" data-tone="info">{f.version(version.number)}</span>
                    <span className="result-author"><span className="avatar avatar--sm">{num(session, version.authorId)}</span><span>{bareNameOf(session, version.authorId, language)}</span>{modelTag(version.authorId)}</span>
                  </div>
                  {items
                    ? <div className="prose result-prose"><ol className="result-list">{items.map((it, i) => <li key={i}>{linkify(it)}</li>)}</ol></div>
                    : <div className="prose result-prose session-view__text">{linkify(version.text)}</div>}
                </>
              ) : <p className="muted">{t.noSolution}</p>}
            </section>
            <OwnerChoice id={id} state={state} onCopyChoice={onCopyChoice} partial={partial} />
            <section>
              <div className="eyebrow">{t.topic}</div>
              <p className="result-topic">{session.topic}</p>
            </section>
            <MaterialsRow session={session} />
          </div>
          <aside className="result-side">
            <section className="card">
              <h2 className="section-title">{t.positions}</h2>
              {agreed.length > 0 && (
                <div className="result-group"><div className="eyebrow">{t.groupAgreed}</div>
                  {agreed.map((id) => <Fragment key={id}>{person(id, false, badge("info", "i-check", s.stanceAgree))}</Fragment>)}
                </div>
              )}
              {objecting.length > 0 && (
                <div className="result-group"><div className="eyebrow">{t.groupObjecting}</div>
                  {objecting.map((o) => (
                    <Fragment key={o.participantId}>
                      {person(o.participantId, false, badge("danger", "i-x", s.stanceObject))}
                      <blockquote className="result-quote">{o.reasoning}</blockquote>
                    </Fragment>
                  ))}
                </div>
              )}
              {dropped.length > 0 && (
                <div className="result-group"><div className="eyebrow">{t.groupDropped}</div>
                  {dropped.map((d) => (
                    <Fragment key={d.id}>
                      {person(d.id, true, badge("warn", "i-user-off", d.replacedBy !== undefined ? t.badgeReplaced : s.phaseDropped))}
                      <p className="result-off-reason muted">{d.replacedBy !== undefined
                        ? t.replacedBy(d.replacedBy, nameOf(session, d.replacedBy, language), typeof d.dropReason === "string" ? d.dropReason : null)
                        : d.dropReason ?? s.reasonMissing}</p>
                    </Fragment>
                  ))}
                </div>
              )}
            </section>
            <div className="stat-row result-stats">
              {stat(t.statRounds, String(stats.rounds))}
              {stat(t.statTurns, String(stats.turns))}
              {stats.tokens !== null && stat(t.statTokens, formatNumber(stats.tokens, undefined, language))}
              {stats.costUsd !== null && stat(t.statCost, formatNumber(stats.costUsd, { maximumFractionDigits: 4 }, language) + " $")}
              {stat(t.statDuration, formatDuration(stats.durationMs, language))}
            </div>
            {stats.costPartial && note(t.costPartial, stats.costFrom)}
            {stats.tokensPartial && note(t.tokensPartial, stats.tokensFrom)}
            {(capStop || sp.cap !== null) && sp.incomplete && <p className="result-note muted"><Icon name="i-info" size="sm" />{t.spendIncomplete}</p>}
          </aside>
        </div>
      </main>
    </>
  );
}
