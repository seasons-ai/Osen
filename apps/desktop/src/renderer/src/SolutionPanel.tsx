import { Fragment, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { currentVersion } from "@model-council/core/protocol";
import type { Session, SessionState } from "@model-council/core/protocol";
import type { Language } from "@model-council/core/i18n";
import { panels } from "../../shared/messages/session-panels.ts";
import { Icon } from "./icons.tsx";
import { parseNumberedList } from "./solution-list.ts";
import { useLanguage, useMessages } from "./language.tsx";
import { diffSolution } from "./solution-diff.ts";
import { Who, bareNameOf, linkify, num, participantPhase } from "./session-ui.tsx";

/** Tab click: the current version follows new ones again (null), the previous one is pinned. */
export function tabTarget(version: number, current: number): number | null {
  return version === current ? null : version;
}

export type CopyNotice = { tone: "ok" | "danger"; text: string };

/** Tab click: comparison turns off on the first version and stays as it was on the others. */
export function diffAfterTab(diff: boolean, version: number, firstNumber: number | undefined): boolean {
  return version === firstNumber ? false : diff;
}

/** Copies exactly the version's source text; the result is a notification for the panel. */
export function copyVersion(version: { number: number; text: string }, copyText: (text: string) => Promise<unknown>, language?: Language): Promise<CopyNotice> {
  return copyText(version.text).then(
    (): CopyNotice => ({ tone: "ok", text: panels(language).solutionCopied(version.number) }),
    (e: unknown): CopyNotice => ({ tone: "danger", text: e instanceof Error ? e.message : String(e) }),
  );
}

function Votes({ session, ids, tone, mark }: { session: Session; ids: string[]; tone: "info" | "danger"; mark: string }): ReactNode {
  const language = useLanguage();
  return (
    <span className="session-votes" data-tone={tone}>
      {ids.map((id) => <span key={id} className="avatar avatar--sm" data-tone={tone} title={bareNameOf(session, id, language)}>{num(session, id)}</span>)}
      <span className="session-votes__mark" aria-hidden="true">{mark}</span>
    </span>
  );
}

export function SolutionPanelView({ state, selected, onSelect, diff = false, notice = null, onDiff, onCopy }: {
  state: SessionState; selected: number | null; onSelect(version: number | null): void;
  diff?: boolean; notice?: CopyNotice | null; onDiff?(on: boolean): void; onCopy?(): void;
}): ReactNode {
  const t = useMessages(panels);
  const language = useLanguage();
  const { session, versions } = state;
  const cur = session === null ? null : currentVersion(state);
  const shown = (selected === null ? undefined : versions.find((v) => v.number === selected)) ?? cur;
  const idx = shown ? versions.findIndex((v) => v.number === shown.number) : -1;
  const prev = idx > 0 ? versions[idx - 1] : null;
  const diffOn = diff && prev !== null;
  const prevText = prev?.text, nextText = shown?.text;
  // The panel redraws on every chunk of streamed text: comparison depends only on the two texts.
  const result = useMemo(() => (diffOn ? diffSolution(prevText!, nextText!) : null), [diffOn, prevText, nextText]);
  if (session === null) return null;
  const objecting = session.participants.filter((p) => participantPhase(state, p.id, false) === "objecting");
  const items = result === null && shown ? parseNumberedList(shown.text) : null;
  const isCur = shown !== null && shown === cur;
  return (
    <section className="session-col" aria-label={t.solutionLabel}>
      <div className="session-col__head session-col__head--solution">
        <span className="eyebrow">{t.solutionTitle}</span>
        {cur !== null && (
          <div className="tabs solution-tabs" role="tablist">
            {versions.map((v) => (
              <button key={v.number} type="button" role="tab" className="tab mono" aria-selected={v === shown} onClick={() => onSelect(tabTarget(v.number, cur.number))}>v{v.number}</button>
            ))}
          </div>
        )}
      </div>
      {shown && cur && (
        <div className="solution-tools">
          <label className="solution-tools__toggle"><input type="checkbox" checked={diffOn} disabled={prev === null} onChange={(e) => onDiff?.(e.target.checked)} /> {t.showChanges}</label>
          {prev === null && <span className="solution-tools__hint">{t.firstVersion}</span>}
          <button type="button" className="btn btn--sm" onClick={() => onCopy?.()}><Icon name="i-copy" size="sm" /> {t.copy}</button>
        </div>
      )}
      <div className="session-panel">
        {shown === undefined || shown === null || cur === null ? (
          <p className="muted">{t.noSolution}</p>
        ) : (
          <>
            {!isCur && (
              <div className="alert" data-tone="warn">
                <Icon name="i-info" />
                <div><div className="alert__text">{t.notCurrent(cur.number)}</div></div>
              </div>
            )}
            {notice && (
              <div className="alert" data-tone={notice.tone} role="status">
                <Icon name={notice.tone === "ok" ? "i-check" : "i-alert"} /><div className="alert__text">{notice.text}</div>
              </div>
            )}
            <div className="session-meta">
              <div className="session-meta__version mono">{t.version(shown.number)}{isCur ? t.currentSuffix : ""}</div>
              <div className="session-meta__row"><span className="session-meta__label">{t.author}</span><Who session={session} id={shown.authorId} /></div>
              {result && prev && (
                <>
                  <div className="session-meta__row"><strong className="muted">{t.changesHead(shown.number, prev.number)}</strong></div>
                  <div className="session-meta__row"><span className="diff-count" data-tone="ok">{t.wordsAdded(result.added)}</span><span className="diff-count" data-tone="danger">{t.wordsRemoved(result.removed)}</span></div>
                  {result.byLines && <div className="session-meta__row diff-note">{t.lineDiffNote}</div>}
                </>
              )}
              {isCur && (
                <div className="session-meta__row">
                  <span className="session-meta__label">{t.agreed}</span>
                  {state.agreed.length === 0 ? <span className="muted">{t.nobody}</span> : <Votes session={session} ids={state.agreed} tone="info" mark="✓" />}
                </div>
              )}
              {isCur && objecting.length > 0 && (
                <div className="session-meta__row">
                  <span className="session-meta__label">{t.objecting}</span>
                  <Votes session={session} ids={objecting.map((p) => p.id)} tone="danger" mark="×" />
                </div>
              )}
            </div>
            {items !== null ? (
              <ol className="prose session-view__text solution-list">{items.map((item, i) => <li key={i}>{linkify(item)}</li>)}</ol>
            ) : (
              <div className="prose session-view__text">
                {result ? result.parts.map((part, i) => (
                  part.kind === "same" ? <Fragment key={i}>{linkify(part.text)}</Fragment>
                    : part.kind === "add" ? <ins key={i} className="diff-add">+{linkify(part.text)}</ins>
                      : <del key={i} className="diff-del">−{part.text}</del>
                )) : linkify(shown.text)}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function SolutionPanel({ state }: { state: SessionState }): ReactNode {
  const [selected, setSelected] = useState<number | null>(null);
  const [diff, setDiff] = useState(false);
  const [notice, setNotice] = useState<CopyNotice | null>(null);
  const language = useLanguage();
  const { versions } = state;
  const cur = currentVersion(state);
  const shown = (selected === null ? undefined : versions.find((v) => v.number === selected)) ?? cur;
  return (
    <SolutionPanelView
      state={state} selected={selected} diff={diff} notice={notice}
      onSelect={(v) => {
        const n = v ?? cur?.number;
        if (n !== undefined) setDiff((d) => diffAfterTab(d, n, versions[0]?.number));
        setNotice(null);
        setSelected(v);
      }}
      onDiff={setDiff}
      onCopy={() => { if (shown) void copyVersion(shown, (t) => window.council.copyText(t), language).then(setNotice); }}
    />
  );
}
