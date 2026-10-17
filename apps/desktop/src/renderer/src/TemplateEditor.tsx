import type { ReactNode } from "react";
import type { TemplateEditorData, TemplateFieldIssue, TemplateOrigin } from "../../shared/setup.ts";
import { useLanguage, useMessages } from "./language.tsx";
import { templateEditor } from "../../shared/messages/template-editor.ts";
import { Icon } from "./icons.tsx";
import { NEW_CATEGORY, checkEditor } from "./template-editor.ts";
import type { EditorAction, EditorForm, EditorLimit } from "./template-editor.ts";

const Err = ({ children }: { children: ReactNode }) => (
  <span className="setup__error" data-tone="danger"><Icon name="i-alert" size="sm" /> {children}</span>
);

const ORIGIN_ICON: Record<TemplateOrigin, "i-doc" | "i-edit"> = { new: "i-doc", user: "i-doc", modified: "i-edit", builtin: "i-doc" };

export function TemplateEditor({ data, form, saving, error, issues, backLabel, dispatch, onSave, onCancel }: {
  data: TemplateEditorData;
  form: EditorForm;
  saving: boolean;
  error: string | null;
  issues: TemplateFieldIssue[];
  backLabel: string;
  dispatch(action: EditorAction): void;
  onSave(): void;
  onCancel(): void;
}): ReactNode {
  const t = useMessages(templateEditor);
  const check = checkEditor(form, data, useLanguage());
  const originLabel = { new: t.originCustom, user: t.originCustom, modified: t.originModified, builtin: t.originBuiltin }[data.origin];
  const limitFields: { field: EditorLimit; label: string }[] = [
    { field: "maxRounds", label: t.limitMaxRounds },
    { field: "turnTimeoutSec", label: t.limitTurnTimeout },
    { field: "contextChars", label: t.limitContext }
  ];
  const text = (field: "title" | "description", label: string, hint?: string, placeholder?: string) => (
    <label className="field">
      <span className="field__label">{label}</span>
      <input className="input" value={form[field]} placeholder={placeholder} onChange={(e) => dispatch({ type: "text", field, value: e.target.value })} />
      {hint && !check.errors[field] && <span className="field__hint">{hint}</span>}
      {check.errors[field] && <Err>{check.errors[field]}</Err>}
    </label>
  );
  const area = (field: "exampleTopic" | "framing", label: string, hint: string, className: string, placeholder?: string) => (
    <label className="field">
      <span className="field__label">{label}</span>
      <textarea className={className} value={form[field]} placeholder={placeholder} onChange={(e) => dispatch({ type: "text", field, value: e.target.value })} />
      {!check.errors[field] && <span className="field__hint">{hint}</span>}
      {check.errors[field] && <Err>{check.errors[field]}</Err>}
    </label>
  );
  const last = form.roles.length - 1;
  const hasProblems = error !== null || issues.length > 0;
  return (
    <>
      <header className="topbar">
        <h1 className="topbar__title">{t.title}</h1>
        <div className="topbar__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}><Icon name="i-chevron-left" size="sm" /> {backLabel}</button>
        </div>
      </header>
      <main className="content">
        <div className="setup">
          <div className="setup__main">
            {text("title", t.fieldTitle, undefined, t.titlePlaceholder)}
            {form.categoryChoice === NEW_CATEGORY ? (
              <div className="stack tpl-category">
                <label className="field">
                  <span className="field__label">{t.fieldCategory}</span>
                  <select className="select" value={form.categoryChoice} onChange={(e) => dispatch({ type: "category", value: e.target.value })}>
                    {data.categories.map((c) => <option key={c} value={c}>{c}</option>)}
                    <option value={NEW_CATEGORY}>{t.newCategory}</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">{t.newCategoryName}</span>
                  <input className="input" value={form.newCategory} onChange={(e) => dispatch({ type: "text", field: "newCategory", value: e.target.value })} />
                  {check.errors.category && <Err>{check.errors.category}</Err>}
                </label>
              </div>
            ) : (
              <label className="field">
                <span className="field__label">{t.fieldCategory}</span>
                <select className="select" value={form.categoryChoice} onChange={(e) => dispatch({ type: "category", value: e.target.value })}>
                  {form.categoryChoice === "" && <option value="" disabled>{t.chooseCategory}</option>}
                  {data.categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  <option value={NEW_CATEGORY}>{t.newCategory}</option>
                </select>
                {check.errors.category && <Err>{check.errors.category}</Err>}
              </label>
            )}
            {text("description", t.fieldDescription, t.descriptionHint)}
            {area("exampleTopic", t.fieldExampleTopic, t.exampleTopicHint, "textarea")}
            {area("framing", t.fieldFraming, t.framingHint, "textarea tpl-frame", t.framingPlaceholder)}
            <section className="stack">
              <div className="setup__head"><h2 className="section-title">{t.rolesTitle}</h2><span className="muted">{t.rolesHint}</span></div>
              <div className="setup__list">
                {form.roles.map((r, i) => {
                  const err = check.roleErrors[r.key];
                  const row = (
                    <div className="tpl-role">
                      <span className="avatar" data-p={i + 1}>{i + 1}</span>
                      <input className="input" aria-label={t.roleLabel(i + 1)} value={r.text} placeholder={t.rolePlaceholder} onChange={(e) => dispatch({ type: "role-text", key: r.key, value: e.target.value })} />
                      <button type="button" className="btn btn--ghost btn--sm" aria-label={t.moveUp} disabled={i === 0} onClick={() => dispatch({ type: "role-move", key: r.key, delta: -1 })}><Icon name="i-arrow-up" size="sm" /></button>
                      <button type="button" className="btn btn--ghost btn--sm" aria-label={t.moveDown} disabled={i === last} onClick={() => dispatch({ type: "role-move", key: r.key, delta: 1 })}><Icon name="i-arrow-down" size="sm" /></button>
                      <button type="button" className="btn btn--ghost btn--sm" aria-label={t.removeRole} onClick={() => dispatch({ type: "role-remove", key: r.key })}><Icon name="i-trash" size="sm" /></button>
                    </div>
                  );
                  return err ? <div key={r.key} className="tpl-role-wrap">{row}<Err>{err}</Err></div> : <div key={r.key} className="tpl-role-item">{row}</div>;
                })}
                <div className="setup__add"><button type="button" className="btn btn--ghost" onClick={() => dispatch({ type: "role-add" })}><Icon name="i-plus" size="sm" /> {t.addRole}</button></div>
              </div>
            </section>
            <section className="stack">
              <h2 className="section-title">{t.limitsTitle}</h2>
              <div className="tpl-limits">
                {limitFields.map(({ field, label }) => (
                  <label key={field} className="field">
                    <span className="field__label">{label}</span>
                    <input className="input" inputMode="numeric" value={form.limits[field]} onChange={(e) => dispatch({ type: "limit", field, value: e.target.value })} />
                    {check.errors[field] && <Err>{check.errors[field]}</Err>}
                  </label>
                ))}
              </div>
              <span className="field__hint">{t.limitsHint}</span>
            </section>
          </div>
          <aside className="setup__side">
            <div className="card stack">
              <h2 className="card__title">{t.saveTitle}</h2>
              <div className="field">
                <span className="field__label">{t.idLabel}</span>
                {check.previewId ? <span className="mono">{check.previewId}</span> : <span className="muted">{t.idPending}</span>}
                <span className="field__hint">{t.idHint}</span>
              </div>
              <div className="field">
                <span className="field__label">{t.originLabel}</span>
                <span><span className="chip"><Icon name={ORIGIN_ICON[data.origin]} size="sm" /> {originLabel}</span></span>
                {data.origin === "builtin" && <span className="field__hint">{t.builtinHint}</span>}
              </div>
              {hasProblems && (
                <div className="alert" data-tone="danger" role="alert">
                  <Icon name="i-alert" />
                  <div>
                    <div className="alert__title">{t.saveFailed}</div>
                    {error && <div className="alert__text">{error}</div>}
                    {issues.map((x, i) => <div key={i} className="alert__text">{x.path}: {x.message}</div>)}
                  </div>
                </div>
              )}
              <button type="button" className="btn btn--primary" disabled={!check.canSave || saving} onClick={onSave}><Icon name="i-check" size="sm" /> {saving ? t.saving : t.save}</button>
              {!check.canSave && <span className="field__hint">{t.fixErrors}</span>}
              <button type="button" className="btn" onClick={onCancel}>{t.cancel}</button>
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
