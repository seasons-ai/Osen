import type { ReactNode, Ref } from "react";
import { ROUNDS_BOUNDS, rosterNames } from "../../shared/setup.ts";
import type { LineupView, MaterialsKind, MaterialsPreviewView, MaterialsView, RegistryView, TemplateCard } from "../../shared/setup.ts";
import { sessionSetup } from "../../shared/messages/session-setup.ts";
import { newDiscussion } from "../../shared/messages/new-discussion.ts";
import { Icon } from "./icons.tsx";
import { useLanguage, useMessages } from "./language.tsx";
import { chars, splitName } from "./session-ui.tsx";
import { billingOf, checkSetup, estimate, lineupLabel, materialsFolderLine, materialsLeftHint, materialsOverText, materialsTotal, previewIsCurrent, previewStatus, previewTime, synthesizerOf } from "./setup.ts";
import type { AcceptedPreview, SetupAction, SetupForm } from "./setup.ts";

export interface LineupsProps {
  list: LineupView[];
  error: string | null;
  name: string;
  busy: boolean;
  saveError: string | null;
  pickError: string | null;
  notice: { tone: "ok" | "muted"; text: string } | null;
  nameRef?: Ref<HTMLInputElement>;
  onPick(id: string): void;
  onName(text: string): void;
  onSave(): void;
}

// "Start" waits for materials reading and the preview: otherwise the session would start without a not-yet-read set. over is already part of canStart.
export const startEnabled = (o: { canStart: boolean; starting: boolean; urlPending: string | null; materialsBusy: boolean; previewBusy: boolean }): boolean =>
  o.canStart && !o.starting && o.urlPending === null && !o.materialsBusy && !o.previewBusy;

// URL in the "loading…" line: host and path without the scheme, query and fragment
// Reason of unavailability in an option label: up to 60 code points, a surrogate pair is not cut; the full text is in title and the participant's error line.
export const clipReason = (reason: string): string => {
  const points = Array.from(reason);
  return points.length > 60 ? `${points.slice(0, 60).join("")}…` : reason;
};
const urlShown = (raw: string): string => { try { const u = new URL(raw.trim()); return u.host + u.pathname; } catch { return raw.trim(); } };

const Err = ({ children }: { children: ReactNode }) => (
  <span className="setup__error" data-tone="danger"><Icon name="i-alert" size="sm" /> {children}</span>
);

/** "at most 36 calls": the number is a separate mono element; text without a number — as a whole. */
function estimateParts(cost: { calls: number; callsText: string }): ReactNode {
  const n = String(cost.calls);
  const at = cost.callsText.indexOf(n);
  if (at < 0) return <span className="setup__cost">{cost.callsText}</span>;
  return <>{cost.callsText.slice(0, at)}<span className="setup__cost">{n}</span>{cost.callsText.slice(at + n.length)}</>;
}

export function SessionSetup({ form, registry, registryError = null, template, starting, error, lineups, dispatch, onStart, onBack, onSaveAs, saveAsBusy, saveAsError, materials = null, materialsBusy = false, dragOver = false, onPick = () => {}, urlText = "", urlPending = null, onUrlText = () => {}, onAddUrl = () => {}, onDropFiles = () => {}, onDragOver = () => {}, onRemoveMaterial = () => {}, onReturnIgnored = () => {}, onExcludeIgnored = () => {}, rerun = null, preview = null, previewOpen = false, previewBusy = false, previewError = null, accepted = null, onPreview = () => {}, onAcceptPreview = () => {}, onClosePreview = () => {} }: {
  form: SetupForm;
  registry: RegistryView;
  registryError?: string | null;
  template: TemplateCard | null;
  starting: boolean;
  error: string | null;
  lineups: LineupsProps;
  dispatch(action: SetupAction): void;
  onStart(): void;
  onBack(): void;
  onSaveAs(): void;
  saveAsBusy: boolean;
  saveAsError: string | null;
  materials?: MaterialsView | null;
  materialsBusy?: boolean;
  dragOver?: boolean;
  onPick?(kind: MaterialsKind): void;
  urlText?: string;
  urlPending?: string | null; // the URL being loaded now; null — nothing is loading
  onUrlText?(text: string): void;
  onAddUrl?(url: string): void;
  onDropFiles?(files: File[]): void;
  onDragOver?(over: boolean): void;
  onRemoveMaterial?(id: string): void;
  onReturnIgnored?(id: string): void;
  onExcludeIgnored?(id: string): void;
  rerun?: { framingFromSession: boolean; date: string } | null;
  preview?: MaterialsPreviewView | null;
  previewOpen?: boolean;
  previewBusy?: boolean;
  previewError?: string | null;
  accepted?: AcceptedPreview | null;
  onPreview?(refresh: boolean): void;
  onAcceptPreview?(): void;
  onClosePreview?(): void;
}): ReactNode {
  const t = useMessages(sessionSetup);
  const nd = useMessages(newDiscussion);
  const language = useLanguage();
  const status = previewStatus(materials, accepted);
  const current = previewIsCurrent(materials, preview);
  const actionBusy = materialsBusy || previewBusy || urlPending !== null;
  // The "Excluded by rules" section: shared by the materials block and the preview window; reads only view fields.
  const ignoredBlock = materials && materials.ignored.length > 0 && (
    <details className="disclosure">
      <summary>{t.excludedByRules(materials.ignored.length)}</summary>
      <ul className="disclosure__list">
        {materials.ignored.map((x) => (
          <li key={x.id} className="setup-ignored">
            <span className="mono">{x.name}</span>
            <span className="muted">{x.rule}</span>
            {x.returned
              ? <><span className="chip">{t.returned}</span><button type="button" className="btn btn--sm" aria-label={t.excludeAgainLabel(x.name)} disabled={materialsBusy} onClick={() => onExcludeIgnored(x.id)}>{t.excludeAgain}</button></>
              : <button type="button" className="btn btn--sm" aria-label={t.returnPathLabel(x.name)} disabled={materialsBusy} onClick={() => onReturnIgnored(x.id)}>{t.returnPath}</button>}
          </li>
        ))}
      </ul>
    </details>
  );
  const hasSource = materials !== null && (materials.items.length > 0 || materials.folder !== null);
  const isAccepted = preview !== null && accepted?.handle === preview.handle;
  const check = checkSetup(form, registry, materials, language);
  const cost = estimate(form, registry, materials, language);
  const names = rosterNames(form.participants, registry.providers);
  const max = registry.defaults.maxParticipants;
  const { min: rMin, max: rMax } = ROUNDS_BOUNDS;
  const pickOff = lineups.error !== null || starting; // the list is not disabled during selection: a disabled element loses keyboard focus
  const saveOff = pickOff || lineups.busy || lineups.name.trim() === "";
  const synth = synthesizerOf(form);
  const saveErrorId = "setup-lineup-save-error";
  return (
    <>
      <header className="topbar">
        <h1 className="topbar__title">{t.title}</h1>
        <div className="topbar__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onBack}><Icon name="i-chevron-left" size="sm" /> {t.back}</button>
        </div>
      </header>
      <main className="content">
        <div className="setup">
          <div className="setup__main">
            {registryError && (
              <div className="alert" data-tone="danger" role="alert" data-registry-error="">
                <Icon name="i-alert" />
                <div>
                  <div className="alert__title">{nd.registryFailed}</div>
                  <div className="alert__text">{registryError}</div>
                </div>
              </div>
            )}
            {error && (
              <div className="alert" data-tone="danger" role="alert">
                <Icon name="i-alert" />
                <div>
                  <div className="alert__title">{t.startFailed}</div>
                  <div className="alert__text">{error}</div>
                </div>
              </div>
            )}
            <div className="setup__origin">
              {template
                ? <><span className="chip">{template.category}</span><strong>{template.title}</strong><span className="muted">{rerun ? t.originFromRerun : t.originFromTemplate}</span></>
                : <><span className="chip">{t.customTopic}</span><span className="muted">{rerun ? t.originFromRerun : t.originNeutral}</span></>}
              {rerun && <span className="setup__rerun"><Icon name="i-refresh" size="sm" />{t.rerunOf(rerun.date)}</span>}
              {rerun?.framingFromSession && <span className="setup__framing"><Icon name="i-info" size="sm" />{t.framingFromSession}</span>}
            </div>
            <label className="field">
              <span className="field__label">{t.topicLabel}</span>
              <textarea className="textarea" value={form.topic} placeholder={t.topicPlaceholder}
                onChange={(e) => dispatch({ type: "topic", value: e.target.value })} />
              {template && form.topic === template.exampleTopic && <span className="field__hint">{t.topicExample}</span>}
              {check.topicError && <Err>{check.topicError}</Err>}
            </label>
            <section className="stack setup-materials" data-drop={dragOver ? "over" : undefined}
              onDragEnter={(e) => { e.preventDefault(); onDragOver(true); }}
              onDragOver={(e) => { e.preventDefault(); onDragOver(true); }}
              onDragLeave={() => onDragOver(false)}
              onDrop={(e) => { e.preventDefault(); onDragOver(false); onDropFiles([...e.dataTransfer.files]); }}>
              <div className="setup__head"><h2 className="section-title">{t.materialsTitle}</h2><span className="muted">{t.materialsNote}</span></div>
              <div className="setup-materials__actions">
                <button type="button" className="btn" disabled={materials === null || materialsBusy} onClick={() => onPick("files")}><Icon name="i-plus" size="sm" /> {t.attachFiles}</button>
                <button type="button" className="btn" disabled={materials === null || materialsBusy} onClick={() => onPick("folder")}><Icon name="i-plus" size="sm" /> {t.attachFolder}</button>
                <span className="muted setup-materials__hint">{t.dropHint}</span>
                <span className="muted setup-materials__drop">{t.dropOver}</span>
                {materialsBusy && urlPending === null && <span className="muted setup-materials__busy">{t.readingMaterials}</span>}
              </div>
              <form className="setup-materials__url" onSubmit={(e) => { e.preventDefault(); if (urlText.trim() !== "") onAddUrl(urlText); }}>
                <label className="field"><span className="field__label">{t.urlLabel}</span><input className="input" type="url" value={urlText} placeholder="https://" onChange={(e) => onUrlText(e.target.value)} /></label>
                <button type="submit" className="btn" disabled={materials === null || actionBusy}>{t.urlAdd}</button>
              </form>
              {materials && (
                <>
                  {(materials.items.length > 0 || urlPending !== null) && (
                    <ul className="setup-materials__list">
                      {materials.items.map((m) => (
                        <li key={m.id} className="setup-material">
                          <Icon name="i-doc" size="sm" />
                          {m.source
                            ? <span className="setup-material__name"><span className="mono">{m.name}</span> <span className="chip">{t.urlBadge}</span> <span className="muted">{m.source.label} · {t.urlFetchedAt(previewTime(m.source.fetchedAt, language))}</span></span>
                            : <span className="setup-material__name mono">{m.name}</span>}
                          <span className="muted">{chars(m.chars, language)}</span>
                          <button type="button" className="btn btn--ghost btn--sm" aria-label={t.removeMaterial(m.name)} disabled={materialsBusy} onClick={() => onRemoveMaterial(m.id)}><Icon name="i-trash" size="sm" /></button>
                        </li>
                      ))}
                      {urlPending !== null && (
                        <li className="setup-material" data-pending="true">
                          <Icon name="i-doc" size="sm" />
                          <span className="setup-material__name"><span className="mono">{urlShown(urlPending)}</span> <span className="chip">{t.urlBadge}</span></span>
                          <span className="muted">{t.urlLoading}</span>
                        </li>
                      )}
                    </ul>
                  )}
                  <div className="setup-materials__total muted">{materialsTotal(materials, language)}</div>
                  {materials.folder && <div className="setup-materials__total muted">{materialsFolderLine(materials.folder, language)}</div>}
                  {materials.skipped.length > 0 && (
                    <details className="disclosure">
                      <summary>{t.skipped(materials.skipped.length)}</summary>
                      <ul className="disclosure__list">
                        {materials.skipped.map((x, i) => <li key={i}><span className="mono">{x.name}</span><span className="muted">{x.reason}</span></li>)}
                      </ul>
                    </details>
                  )}
                  {ignoredBlock}
                  {materials.left.length > 0 && (
                    <>
                      <details className="disclosure">
                        <summary>{t.notIncluded(materials.left.length)}</summary>
                        <ul className="disclosure__list">
                          {materials.left.map((x, i) => <li key={i}><span className="mono">{x.name}</span><span className="muted">{x.reason}</span></li>)}
                        </ul>
                      </details>
                      <span className="muted setup-materials__hint">{materialsLeftHint(materials, language)}</span>
                    </>
                  )}
                  {materials.error?.split("\n").filter((l) => l !== "").map((l, i) => <div key={i} className="setup__error" data-tone="danger"><Icon name="i-alert" size="sm" /> {l}</div>)}
                </>
              )}
              <div className="setup-materials__preview">
                <button type="button" id="setup-preview-open" className="btn" disabled={!hasSource || actionBusy} onClick={() => onPreview(false)}>{t.previewOpen}</button>
                {previewBusy && <span className="muted">{t.previewBusy}</span>}
                {status === "accepted" && accepted && <><span className="chip">{t.acceptedAt(previewTime(accepted.createdAt, language))}</span><span className="muted">{t.acceptedNote}</span></>}
                {status === "stale" && (
                  <>
                    <span className="setup__error" data-tone="danger"><Icon name="i-alert" size="sm" /> {t.stale}</span>
                    <button type="button" className="btn btn--sm" disabled={actionBusy} onClick={() => onPreview(true)}>{t.refresh}</button>
                    <span className="muted">{t.staleNote}</span>
                  </>
                )}
                {previewError?.split("\n").filter((l) => l !== "").map((l, i) => <div key={i} className="setup__error" data-tone="danger"><Icon name="i-alert" size="sm" /> {l}</div>)}
              </div>
              {previewOpen && preview && (
                <section className="setup-preview" role="region" aria-label={t.previewRegion}>
                  <div className="setup-preview__head"><h3 className="section-title">{t.previewOpen}</h3><span className="muted">{t.preparedAt(previewTime(preview.createdAt, language))}</span></div>
                  {!current && <span className="setup__error" data-tone="danger"><Icon name="i-alert" size="sm" /> {t.previewOld}</span>}
                  <details className="disclosure" open>
                    <summary>{t.initialContext}</summary>
                    {preview.initial !== null ? <pre className="setup-preview__text" tabIndex={0}>{preview.initial}</pre> : <span className="muted">{t.noInitial}</span>}
                  </details>
                  {preview.manifest && (
                    <details className="disclosure">
                      <summary>{t.manifest}</summary>
                      <pre className="setup-preview__text" tabIndex={0}>{preview.manifest}</pre>
                    </details>
                  )}
                  {preview.available.length > 0 && (
                    <details className="disclosure">
                      <summary>{t.folderFiles(preview.available.length, preview.available.filter((f) => !f.initial).length)}</summary>
                      <ul className="disclosure__list">
                        {preview.available.map((f, i) => (
                          <li key={i} className="setup-preview__file">
                            <span className="mono">{f.name}</span>
                            <span className="muted">{chars(f.chars, language)}</span>
                            <span className="chip">{f.initial ? t.inInitial : t.onRequest}</span>
                            {f.reason && <span className="muted">{f.reason}</span>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {preview.skipped.length > 0 && (
                    <details className="disclosure">
                      <summary>{t.skipped(preview.skipped.length)}</summary>
                      <ul className="disclosure__list">{preview.skipped.map((x, i) => <li key={i}><span className="mono">{x.name}</span><span className="muted">{x.reason}</span></li>)}</ul>
                    </details>
                  )}
                  {ignoredBlock}
                  {preview.sources.length > 0 && (
                    <details className="disclosure" open>
                      <summary>{t.urlSources}</summary>
                      <ul className="disclosure__list">{preview.sources.map((x, i) => <li key={i}><span className="mono">{x.id} ← {x.url} · {t.urlFetchedAt(previewTime(x.fetchedAt, language))}</span></li>)}</ul>
                    </details>
                  )}
                  {preview.left.length > 0 && (
                    <details className="disclosure">
                      <summary>{t.notSent(preview.left.length)}</summary>
                      <ul className="disclosure__list">{preview.left.map((x, i) => <li key={i}><span className="mono">{x.name}</span><span className="muted">{x.reason}</span></li>)}</ul>
                    </details>
                  )}
                  <div className="setup-preview__actions">
                    <button type="button" className="btn btn--primary" disabled={!current || isAccepted || actionBusy} onClick={onAcceptPreview}>{isAccepted ? t.accepted : t.accept}</button>
                    <button type="button" className="btn" disabled={actionBusy} onClick={() => onPreview(true)}>{t.refresh}</button>
                    <button type="button" className="btn btn--ghost" onClick={() => { onClosePreview(); setTimeout(() => document.getElementById("setup-preview-open")?.focus(), 0); }}>{t.close}</button>
                  </div>
                </section>
              )}
            </section>
            <section className="stack">
              <div className="setup__head"><h2 className="section-title">{t.participantsTitle}</h2><span className="muted">{t.participantsCount(form.participants.length, max)}</span></div>
              <div className="setup-lineups">
                <label className="field setup-lineups__pick"><span className="field__label">{t.lineup}</span>
                  <select className="select" value="" disabled={pickOff} onChange={(e) => { if (e.target.value !== "") lineups.onPick(e.target.value); }}>
                    <option value="">{t.pickLineup}</option>
                    {lineups.list.map((l) => <option key={l.id} value={l.id}>{lineupLabel(l, language)}</option>)}
                  </select></label>
                <label className="field setup-lineups__name"><span className="field__label">{t.lineupName}</span>
                  <input className="input" type="text" placeholder={t.lineupNamePlaceholder} maxLength={100} value={lineups.name} ref={lineups.nameRef}
                    aria-invalid={lineups.saveError ? "true" : undefined} aria-describedby={lineups.saveError ? saveErrorId : undefined}
                    onChange={(e) => lineups.onName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.nativeEvent?.isComposing && !saveOff) { e.preventDefault(); lineups.onSave(); } }} /></label>
                <button type="button" className="btn setup-lineups__save" disabled={saveOff} onClick={lineups.onSave}
                  title={t.saveLineupTitle}><Icon name="i-users" size="sm" /> {t.saveLineup}</button>
                {lineups.error && <div className="setup__error" data-tone="danger" role="alert"><Icon name="i-alert" size="sm" /> {t.lineupsUnread}{lineups.error}</div>}
                {lineups.saveError && <div id={saveErrorId} className="setup__error" data-tone="danger" role="alert"><Icon name="i-alert" size="sm" /> {lineups.saveError}</div>}
                {lineups.pickError && <div className="setup__error" data-tone="danger" role="alert"><Icon name="i-alert" size="sm" /> {lineups.pickError}</div>}
                {lineups.notice && (lineups.notice.tone === "ok"
                  ? <div className="setup-lineups__note" data-tone="ok" role="status"><Icon name="i-check" size="sm" /> {lineups.notice.text}</div>
                  : <div className="setup-lineups__note" data-tone="muted">{lineups.notice.text}</div>)}
              </div>
              <div className="setup__list">
                {form.participants.map((p, i) => {
                  const provider = registry.providers.find((x) => x.id === p.providerId);
                  const billing = billingOf(provider, p.model);
                  const models = provider?.models ?? [];
                  const err = check.participantErrors[i];
                  const key = p.key;
                  return (
                    <div key={key} className="participant setup-p" data-p={i + 1}>
                      <div className="setup-p__head">
                        <div className="avatar" data-p={i + 1}>{i + 1}</div>
                        <div className="participant__name">{splitName(names[i] ?? p.providerId, p.model).name}</div>
                        {p.model !== "" && p.model !== provider?.defaultModel && <span className="tag">{p.model}</span>}
                        {billing !== "free" && <span className="chip"><Icon name="i-coins" size="sm" /> {billing === "subscription" ? t.usesSubscription : t.paid}</span>}
                        <div className="setup-p__move">
                          <button type="button" className="btn btn--ghost btn--sm" aria-label={t.moveUp} disabled={i === 0} onClick={() => dispatch({ type: "move", key, delta: -1 })}>↑</button>
                          <button type="button" className="btn btn--ghost btn--sm" aria-label={t.moveDown} disabled={i === form.participants.length - 1} onClick={() => dispatch({ type: "move", key, delta: 1 })}>↓</button>
                        </div>
                        <button type="button" className="btn btn--ghost btn--sm" aria-label={t.removeParticipant} onClick={() => dispatch({ type: "remove", key })}><Icon name="i-trash" size="sm" /></button>
                      </div>
                      <select className="select" aria-label={t.provider} value={p.providerId} onChange={(e) => dispatch({ type: "provider", key, providerId: e.target.value })}>
                        {registry.providers.map((x) => <option key={x.id} value={x.id} title={x.available || !x.reason ? undefined : x.reason}>{x.available ? x.label : `${x.label} — ${x.reason ? clipReason(x.reason) : t.unavailable}`}</option>)}
                        {!provider && <option value={p.providerId}>{p.providerId}</option>}
                      </select>
                      <select className="select" aria-label={t.model} value={p.model} onChange={(e) => dispatch({ type: "model", key, model: e.target.value })}>
                        {models.map((m) => <option key={m} value={m}>{m === provider?.defaultModel ? t.defaultModel : m}</option>)}
                        {p.model !== "" && !models.includes(p.model) && <option value={p.model}>{p.model}</option>}
                        {models.length === 0 && p.model === "" && <option value="">{t.noModels}</option>}
                      </select>
                      <input className="input" aria-label={t.role} value={p.role} title={p.role} placeholder={t.rolePlaceholder} onChange={(e) => dispatch({ type: "role", key, role: e.target.value })} />
                      {err ? <div className="setup__error" data-tone="danger"><Icon name="i-alert" size="sm" /> {err}</div>
                        : check.participantNotes[i] && <div className="setup__error" data-tone="warn"><Icon name="i-alert" size="sm" /> {check.participantNotes[i]}</div>}
                    </div>
                  );
                })}
                <div className="setup__add">
                  <button type="button" className="btn btn--ghost" disabled={!check.canAdd} onClick={() => dispatch({ type: "add" })}><Icon name="i-plus" size="sm" /> {t.addParticipant}</button>
                  <span className="muted">{check.canAdd ? t.atMost(max) : t.limitReached(max)}</span>
                </div>
              </div>
              {check.countError && <div className="setup__error" data-tone="danger"><Icon name="i-alert" size="sm" /> {check.countError}</div>}
            </section>
            <section className="stack setup-drafts">
              <label className="setup-wait__toggle"><input type="checkbox" checked={form.drafts} aria-describedby="setup-drafts-flag setup-drafts-hint" onChange={(e) => dispatch({ type: "drafts", value: e.target.checked })} /> {t.drafts}</label>
              <span className="chip" id="setup-drafts-flag"><Icon name="i-info" size="sm" /> {t.draftsFlag}</span>
              <span className="field__hint" id="setup-drafts-hint">{t.draftsHint}</span>
              {synth && (
                <label className="field setup-drafts__pick"><span className="field__label">{t.synthesizer}</span>
                  <select className="select" value={synth.key} onChange={(e) => dispatch({ type: "synthesizer", key: Number(e.target.value) })}>
                    {form.participants.map((p, i) => <option key={p.key} value={p.key}>{i + 1} · {names[i]}</option>)}
                  </select></label>
              )}
            </section>
          </div>
          <aside className="setup__side">
            <div className="card stack">
              <h2 className="card__title">{t.launch}</h2>
              <div className="field">
                <span className="field__label">{t.roundLimit}</span>
                <div className="stepper" data-min={rMin} data-max={rMax}>
                  <button type="button" data-step="-1" aria-label={t.less} disabled={form.maxRounds <= rMin} onClick={() => dispatch({ type: "rounds", value: form.maxRounds - 1 })}>−</button>
                  <span className="stepper__value">{form.maxRounds}</span>
                  <button type="button" data-step="1" aria-label={t.more} disabled={form.maxRounds >= rMax} onClick={() => dispatch({ type: "rounds", value: form.maxRounds + 1 })}>+</button>
                </div>
                <span className="field__hint">{t.roundHint(rMin, rMax)}</span>
              </div>
              <label className="field setup-cap">
                <span className="field__label">{t.tokenCap}</span>
                <input className="input" inputMode="numeric" placeholder={t.tokenCapPlaceholder} value={form.tokenCap} onChange={(e) => dispatch({ type: "cap", value: e.target.value })} />
                <span className="field__hint">{t.tokenCapHint}</span>
                {check.capError && <Err>{check.capError}</Err>}
              </label>
              <div className="setup-wait">
                <span className="eyebrow">{t.ownerWait}</span>
                <label className="setup-wait__toggle"><input type="checkbox" checked={form.pauseAfterRound} onChange={(e) => dispatch({ type: "pause-after-round", value: e.target.checked })} /> {t.pauseAfterRound}</label>
                <span className="field__hint">{t.pauseHint}</span>
                <label className="setup-wait__toggle"><input type="checkbox" checked={form.waitForOwner} onChange={(e) => dispatch({ type: "wait-for-owner", value: e.target.checked })} /> {t.waitForOwner}</label>
                <span className="field__hint">{t.waitHint}</span>
                {(form.pauseAfterRound || form.waitForOwner) && (
                  <label className="field setup-wait__sec">
                    <span className="field__label">{t.waitSec}</span>
                    <input className="input" inputMode="numeric" value={form.waitSec} onChange={(e) => dispatch({ type: "wait-sec", value: e.target.value })} />
                    <span className="field__hint">{t.waitSecHint}</span>
                    {check.waitError && <Err>{check.waitError}</Err>}
                  </label>
                )}
              </div>
              <div className="setup__block">
                <span className="eyebrow">{t.costTitle}</span>
                {cost ? <><span className="setup__estimate">{estimateParts(cost)}</span><span className="muted">{cost.note}</span>{cost.materialsNote && <span className="muted">{cost.materialsNote}</span>}{cost.draftsNote && <span className="muted">{cost.draftsNote}</span>}{cost.capNote && <span className="muted">{cost.capNote}</span>}</> : <span className="setup__estimate"><span className="setup__cost">—</span></span>}
              </div>
              {materials && materials.over > 0 && <Err>{materialsOverText(materials, language)}</Err>}
              <button type="button" className="btn btn--primary" disabled={!startEnabled({ canStart: check.canStart, starting, urlPending, materialsBusy, previewBusy })} onClick={onStart}><Icon name="i-play" size="sm" /> {starting ? t.starting : t.start}</button>
              {(materialsBusy || previewBusy) && urlPending === null && <span className="field__hint"><Icon name="i-clock" size="sm" /> {t.readingMaterials}</span>}
              {check.startHint && <span className="field__hint">{check.startHint}</span>}
              <button type="button" className="btn btn--ghost setup__save" disabled={starting || saveAsBusy} onClick={onSaveAs} title={t.saveAsTitle}><Icon name="i-doc" size="sm" /> {t.saveAs}</button>
              {saveAsError && <span className="setup__error" data-tone="danger" role="alert"><Icon name="i-alert" size="sm" /> {t.saveAsFailed}{saveAsError}</span>}
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
