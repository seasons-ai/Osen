import type { ReactNode } from "react";
import type { TemplateCard, TemplateRemoveMode, TemplatesView } from "../../shared/setup.ts";
import type { GalleryAction, GalleryState } from "./gallery.ts";
import { newDiscussion } from "../../shared/messages/new-discussion.ts";
import { Icon } from "./icons.tsx";
import { useMessages } from "./language.tsx";

interface Handlers {
  gallery: GalleryState;
  onPick(id: string | null): void;
  onEdit(id: string): void;
  onDuplicate(id: string): void;
  dispatchGallery(action: GalleryAction): void;
  onConfirmRemove(): void;
}

function Confirm({ t, mode, busy, dispatchGallery, onConfirmRemove }: {
  t: TemplateCard;
  mode: TemplateRemoveMode;
  busy: boolean;
  dispatchGallery(action: GalleryAction): void;
  onConfirmRemove(): void;
}): ReactNode {
  const m = useMessages(newDiscussion);
  const reset = mode === "reset";
  return (
    <div className="alert" data-tone={reset ? "warn" : "danger"} role="alert">
      <Icon name="i-alert" />
      <div>
        <div className="alert__title">{reset ? m.confirmResetTitle(t.title) : m.confirmDeleteTitle(t.title)}</div>
        <div className="alert__text">
          {reset
            ? m.confirmResetText
            : <>{m.idLabel} <span className="mono">{t.id}</span>. {t.modified ? m.confirmDeleteModifiedText : m.confirmDeleteText}</>}
        </div>
      </div>
      <div className="alert__actions">
        <button type="button" className={reset ? "btn btn--primary btn--sm" : "btn btn--danger btn--sm"} disabled={busy} onClick={onConfirmRemove}>{reset ? m.reset : m.delete}</button>
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => dispatchGallery({ type: "cancel" })}>{m.cancel}</button>
      </div>
    </div>
  );
}

function Card({ t, defaultMaxRounds, h }: { t: TemplateCard; defaultMaxRounds: number | null; h: Handlers }): ReactNode {
  const m = useMessages(newDiscussion);
  const rounds = t.maxRounds ?? defaultMaxRounds;
  const { gallery, dispatchGallery } = h;
  const confirming = gallery.confirming?.id === t.id ? gallery.confirming : null;
  const failure = gallery.failure?.id === t.id ? gallery.failure : null;
  const meta = [t.roles.length > 0 ? m.roles(t.roles.length) : null, rounds !== null ? m.rounds(rounds) : null].filter((s) => s !== null);
  return (
    <article className="card index-card">
      <button type="button" className="index-card__main" onClick={() => h.onPick(t.id)}>
        <h3 className="card__title">{t.title}</h3>
        {(t.modified || t.source === "user") && (
          <p className="index-origin">
            <span className="chip">{t.modified ? m.modified : m.custom}</span>
          </p>
        )}
        <p className="card__text index-clamp">{t.description}</p>
        <p className="card__meta index-meta">{meta.join(" · ")}</p>
      </button>
      {confirming ? (
        <Confirm t={t} mode={confirming.mode} busy={gallery.removing} dispatchGallery={dispatchGallery} onConfirmRemove={h.onConfirmRemove} />
      ) : (
        <div className="index-card__actions">
          <button type="button" className="btn btn--ghost" onClick={() => h.onEdit(t.id)}>{m.edit}</button>
          <button type="button" className="btn btn--ghost" onClick={() => h.onDuplicate(t.id)}>{m.duplicate}</button>
          {t.source === "user" && (
            <button type="button" className="btn btn--ghost" onClick={() => dispatchGallery({ type: "ask", id: t.id, mode: "delete" })}>{m.delete}</button>
          )}
          {t.modified && (
            <button type="button" className="btn btn--ghost" onClick={() => dispatchGallery({ type: "ask", id: t.id, mode: "reset" })}>{m.resetToBuiltin}</button>
          )}
        </div>
      )}
      {failure && <Failure title={m.deleteFailed} message={failure.message} dispatchGallery={dispatchGallery} />}
    </article>
  );
}

function Failure({ title, message, dispatchGallery }: { title: string; message: string; dispatchGallery(action: GalleryAction): void }): ReactNode {
  const m = useMessages(newDiscussion);
  return (
    <div className="alert" data-tone="danger" role="alert">
      <Icon name="i-alert" />
      <div>
        <div className="alert__title">{title}</div>
        <div className="alert__text">{message}</div>
      </div>
      <div className="alert__actions">
        <button type="button" className="btn btn--sm" onClick={() => dispatchGallery({ type: "dismiss" })}>{m.understood}</button>
      </div>
    </div>
  );
}

export function NewDiscussion({ view, error, defaultMaxRounds, onPick, gallery, onNew, onEdit, onDuplicate, dispatchGallery, onConfirmRemove }: {
  view: TemplatesView | null;
  error: string | null;
  defaultMaxRounds: number | null;
  onPick(templateId: string | null): void;
  gallery: GalleryState;
  onNew(): void;
  onEdit(id: string): void;
  onDuplicate(id: string): void;
  dispatchGallery(action: GalleryAction): void;
  onConfirmRemove(): void;
}): ReactNode {
  const m = useMessages(newDiscussion);
  const h: Handlers = { gallery, onPick, onEdit, onDuplicate, dispatchGallery, onConfirmRemove };
  const groups = new Map<string, TemplateCard[]>();
  for (const t of view?.templates ?? []) groups.set(t.category, [...(groups.get(t.category) ?? []), t]);
  const errors = view?.errors ?? [];
  return (
    <>
      <header className="topbar">
        <h1 className="topbar__title">{m.title}</h1>
        {view !== null && <span className="mono index-topbar-meta">{m.topbarMeta(view.templates.length, groups.size)}</span>}
      </header>
      <main className="content content--index">
        <div className="stack index-page">
          <p className="muted">{m.hint}</p>
          {error && (
            <div className="alert" data-tone="danger" role="alert">
              <Icon name="i-alert" />
              <div className="alert__text">{error}</div>
            </div>
          )}
          {errors.length > 0 && (
            <div className="alert" data-tone="warn">
              <Icon name="i-alert" />
              <div>
                <div className="alert__title">{m.templatesFailed(errors.length)}</div>
                <div className="alert__text">
                  {errors.map((e, i) => (
                    <span key={e.file}>{i > 0 && "; "}<span className="mono">{e.file}</span> — {e.reason}</span>
                  ))}
                  {". "}{m.othersAvailable}
                </div>
              </div>
            </div>
          )}
          {gallery.failure?.id === null && <Failure title={m.editorFailed} message={gallery.failure.message} dispatchGallery={dispatchGallery} />}
          <div className="grid-cards">
            <button type="button" className="card card--interactive card--dashed" onClick={() => onPick(null)}>
              <h2 className="card__title index-custom"><span className="index-glyph" aria-hidden="true">✎</span> {m.customTopic}</h2>
              <p className="card__text">{m.customTopicText}</p>
            </button>
            <button type="button" className="card card--interactive card--dashed" onClick={onNew}>
              <h2 className="card__title index-custom"><span className="index-glyph" aria-hidden="true">+</span> {m.newTemplate}</h2>
              <p className="card__text">{m.newTemplateText}</p>
            </button>
          </div>
          {view === null && !error && <p className="muted">{m.loading}</p>}
          {[...groups].map(([category, list]) => (
            <section key={category} className="stack index-section">
              <h2 className="section-title index-heading">{category}<span className="mono index-count">{list.length}</span></h2>
              <div className="grid-cards">
                {list.map((t) => <Card key={t.id} t={t} defaultMaxRounds={defaultMaxRounds} h={h} />)}
              </div>
            </section>
          ))}
        </div>
      </main>
    </>
  );
}
