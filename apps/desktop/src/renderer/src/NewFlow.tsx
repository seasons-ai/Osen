import { useEffect, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LineupsView, MaterialsKind, MaterialsPreviewView, MaterialsView, RegistryView, RerunView, RosterEntry, TemplateCard, TemplateEditorData, TemplateEditorRequest, TemplatesView } from "../../shared/setup.ts";
import { newDiscussion } from "../../shared/messages/new-discussion.ts";
import { Icon } from "./icons.tsx";
import { useLanguage, useMessages } from "./language.tsx";
import { initialGallery, reduceGallery } from "./gallery.ts";
import { NewDiscussion } from "./NewDiscussion.tsx";
import { SessionSetup } from "./SessionSetup.tsx";
import { TemplateEditorScreen } from "./TemplateEditorScreen.tsx";
import { formFromRerun, initialForm, lineupSaveInput, reduceSetup, setupTemplateData, toStartInput } from "./setup.ts";
import type { AcceptedPreview, SetupAction, SetupForm } from "./setup.ts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The catalog is needed by the gallery and the rerun (template card). A key change rereads the catalog: entering the gallery — from a rerun,
// session setup or the editor, where a template may have been saved — always gives a fresh list.
export const templatesKey = (s: { picked: unknown; rerun: unknown; editor: unknown }): "gallery" | "rerun" | null =>
  s.picked === null && s.rerun === null && s.editor === null ? "gallery" : s.rerun !== null ? "rerun" : null;

// Start is blocked while the session is starting, materials or the preview are being read, or a URL is loading: the set is not ready yet.
export const canLaunch = (s: { starting: boolean; busy: boolean; previewBusy: boolean; urlPending: string | null }): boolean =>
  !s.starting && !s.busy && !s.previewBusy && s.urlPending === null;

// Returning to the section (not the first show): the set is reread, selection is counted against the current limit from "Settings".
export const refetchOnReturn = (prev: boolean, now: boolean, bridge: { materials(): Promise<MaterialsView> }): Promise<MaterialsView> | null =>
  !prev && now ? bridge.materials() : null;

function Setup({ registry, template, last, rerun = null, active = true, onBack, onStarted }: {
  registry: RegistryView;
  template: TemplateCard | null;
  last: RosterEntry[] | null;
  rerun?: RerunView | null;
  active?: boolean;
  onBack(): void;
  onStarted(id: string): void;
}): ReactNode {
  const ctx = { registry, template };
  const m = useMessages(newDiscussion);
  const language = useLanguage();
  const [form, dispatch] = useReducer((f: SetupForm, a: SetupAction) => reduceSetup(f, a, ctx, language), undefined, () => (rerun ? formFromRerun(rerun, registry) : initialForm(ctx, last)));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urlText, setUrlText] = useState("");
  const [urlPending, setUrlPending] = useState<string | null>(null);
  const [materials, setMaterials] = useState<MaterialsView | null>(rerun?.materials ?? null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<MaterialsPreviewView | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<AcceptedPreview | null>(null);
  const [saveAs, setSaveAs] = useState<TemplateEditorData | null>(null);
  const [saveAsBusy, setSaveAsBusy] = useState(false);
  const [saveAsError, setSaveAsError] = useState<string | null>(null);
  const [lineups, setLineups] = useState<LineupsView>({ lineups: [], error: null });
  const [lineupName, setLineupName] = useState("");
  const [lineupBusy, setLineupBusy] = useState(false);
  const [lineupSaveError, setLineupSaveError] = useState<string | null>(null);
  const [lineupPickError, setLineupPickError] = useState<string | null>(null);
  const [lineupNotice, setLineupNotice] = useState<{ tone: "ok" | "muted"; text: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true;
    window.council.lineups().then((v) => { if (alive) setLineups(v); }, (e) => { if (alive) setLineups({ lineups: [], error: message(e) }); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (rerun) return; // prepareRerun has already replaced the draft and returned its view
    let alive = true;
    // A new setup starts with an empty draft: otherwise materials of an abandoned rerun or of the previous setup would end up in someone else's session
    window.council.clearMaterials().then((v) => { if (alive) setMaterials(v); }, (e) => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, []);
  const wasActive = useRef(active);
  useEffect(() => {
    const p = refetchOnReturn(wasActive.current, active, window.council);
    wasActive.current = active;
    if (!p) return;
    let alive = true;
    p.then((v) => { if (alive) setMaterials(v); }, (e) => { if (alive) setError(message(e)); });
    return () => { alive = false; };
  }, [active]);
  // Action on the set: busy while it runs, the result is the new view; a bridge failure goes to the screen's error
  const act = (run: () => Promise<MaterialsView>) => {
    if (busy) return;
    setBusy(true);
    run().then(setMaterials, (e) => setError(message(e))).finally(() => setBusy(false));
  };
  // A preview refusal does not touch the previous set, the acceptance, or the panel expansion
  const onPreview = (refresh: boolean) => {
    if (busy || previewBusy) return;
    setPreviewBusy(true);
    setPreviewError(null);
    window.council.previewMaterials(refresh).then(
      (p) => {
        setPreview(p);
        setMaterials(p.materials);
        setPreviewOpen(true);
        setAccepted((a) => (a && a.stamp === p.materials.stamp ? a : null)); // a new set is prepared: the stale acceptance is cleared, the new one only by an explicit "Accept set"
      },
      (e) => setPreviewError(message(e)),
    ).finally(() => setPreviewBusy(false));
  };
  const onAddUrl = (raw: string) => {
    const url = raw.trim();
    if (busy || url === "") return;
    setUrlPending(url);
    act(() => window.council.addUrl(url).then((v) => { if (v.error === null) setUrlText(""); return v; }).finally(() => setUrlPending(null)));
  };
  const onAcceptPreview = () => { if (preview) setAccepted({ handle: preview.handle, stamp: preview.stamp, createdAt: preview.createdAt }); };
  const onStart = () => {
    if (!canLaunch({ starting, busy, previewBusy, urlPending })) return;
    setStarting(true);
    setError(null);
    window.council.startSession(toStartInput(form, registry, materials, rerun?.sessionId, accepted)).then(
      (r) => {
        if (r.id !== null) return onStarted(r.id);
        setError(r.error);
        setAccepted(null); // the set was not accepted by main: the preview must be refreshed
        setStarting(false);
        window.council.materials().then(setMaterials, () => {});
      },
      (e) => {
        setError(message(e));
        setStarting(false);
        window.council.materials().then(setMaterials, () => {}); // the draft in main is unchanged
      },
    );
  };
  const onSaveAs = () => {
    if (saveAsBusy) return;
    setSaveAsBusy(true);
    setSaveAsError(null);
    window.council.templateEditor({ mode: "snapshot", templateId: form.templateId, ...(rerun ? { framingFrom: rerun.sessionId } : {}) }).then(
      (data) => setSaveAs(setupTemplateData(form, data)),
      (e) => setSaveAsError(message(e)),
    ).finally(() => setSaveAsBusy(false));
  };
  const onPickLineup = async (id: string) => {
    if (lineupBusy) return;
    setLineupBusy(true);
    setLineupPickError(null);
    setLineupSaveError(null);
    setLineupNotice(null);
    try {
      const v = await window.council.lineups(); // checking positions at the moment of choice
      setLineups(v);
      if (v.error !== null) return;
      const found = v.lineups.find((l) => l.id === id);
      if (!found) { setLineupPickError(m.lineupNotFound); return; }
      dispatch({ type: "lineup", participants: found.participants });
      setLineupNotice({ tone: "muted", text: m.lineupApplied(found.name) });
    } catch (e) {
      setLineupPickError(message(e));
    } finally {
      setLineupBusy(false);
    }
  };
  const onSaveLineup = async () => {
    if (lineupBusy || lineupName.trim() === "") return;
    setLineupBusy(true);
    setLineupPickError(null);
    setLineupSaveError(null);
    setLineupNotice(null);
    try {
      const r = await window.council.saveLineup(lineupSaveInput(form, lineupName));
      if (r.ok) {
        setLineupName("");
        setLineupNotice({ tone: "ok", text: m.lineupSaved(r.name) });
        nameRef.current?.focus(); // the save button is disabled with an empty name: focus does not stay on it
        setLineups(await window.council.lineups().catch((e) => ({ lineups: [], error: message(e) })));
      } else {
        setLineupSaveError(r.error);
        nameRef.current?.focus();
      }
    } catch (e) {
      setLineupSaveError(message(e));
      nameRef.current?.focus();
    } finally {
      setLineupBusy(false);
    }
  };
  if (saveAs !== null) return <TemplateEditorScreen data={saveAs} backLabel={m.toSetup} onDone={() => setSaveAs(null)} />;
  return (
    <SessionSetup form={form} registry={registry} template={template} starting={starting} error={error} dispatch={dispatch}
      lineups={{ list: lineups.lineups, error: lineups.error, name: lineupName, busy: lineupBusy, saveError: lineupSaveError, pickError: lineupPickError, notice: lineupNotice, nameRef, onPick: onPickLineup, onName: (t) => { setLineupName(t); setLineupSaveError(null); }, onSave: onSaveLineup }}
      onStart={onStart}
      onSaveAs={onSaveAs} saveAsBusy={saveAsBusy} saveAsError={saveAsError}
      onBack={() => { window.council.clearMaterials().catch(() => {}); onBack(); }}
      rerun={rerun ? { framingFromSession: rerun.framingFromSession, date: rerun.date } : null}
      materials={materials} materialsBusy={busy} dragOver={dragOver} onDragOver={setDragOver}
      onPick={(kind: MaterialsKind) => act(() => window.council.pickMaterials(kind))}
      urlText={urlText} urlPending={urlPending} onUrlText={setUrlText} onAddUrl={onAddUrl}
      onDropFiles={(files) => act(() => window.council.attachDropped(files))}
      onRemoveMaterial={(id) => act(() => window.council.removeMaterial(id))}
      onReturnIgnored={(id) => act(() => window.council.returnIgnored(id))}
      onExcludeIgnored={(id) => act(() => window.council.excludeIgnored(id))}
      preview={preview} previewOpen={previewOpen} previewBusy={previewBusy} previewError={previewError} accepted={accepted}
      onPreview={onPreview} onAcceptPreview={onAcceptPreview} onClosePreview={() => setPreviewOpen(false)} />
  );
}

export function NewFlow({ onStarted, rerun = null, active = true }: { onStarted(id: string): void; rerun?: RerunView | null; active?: boolean }): ReactNode {
  const m = useMessages(newDiscussion);
  const [templates, setTemplates] = useState<TemplatesView | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [registry, setRegistry] = useState<RegistryView | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [last, setLast] = useState<RosterEntry[] | null>(null);
  const [picked, setPicked] = useState<{ template: TemplateCard | null } | null>(null);
  const [rerunUsed, setRerunUsed] = useState(false); // "Back to templates" returns to the gallery, the rerun is no longer substituted
  const activeRerun = rerun !== null && !rerunUsed ? rerun : null;

  const [editor, setEditor] = useState<TemplateEditorData | null>(null);
  const [galleryState, dispatchGallery] = useReducer(reduceGallery, initialGallery);

  const catalogKey = templatesKey({ picked, rerun: activeRerun, editor });
  const reload = () => window.council.listTemplates().then(
    (v) => { setTemplates(v); setTemplatesError(null); },
    (e) => setTemplatesError(message(e)),
  );
  useEffect(() => {
    if (catalogKey === null) return;
    let alive = true;
    window.council.listTemplates().then(
      (v) => { if (alive) { setTemplates(v); setTemplatesError(null); } },
      (e) => { if (alive) setTemplatesError(message(e)); },
    );
    return () => { alive = false; };
  }, [catalogKey]);
  const openEditor = (request: TemplateEditorRequest) => {
    window.council.templateEditor(request).then(
      setEditor,
      (e) => dispatchGallery({ type: "failed", id: null, message: message(e) }),
    );
  };
  const onConfirmRemove = () => {
    const c = galleryState.confirming;
    if (c === null || galleryState.removing) return;
    dispatchGallery({ type: "removing" });
    window.council.removeTemplate(c.id, c.mode).then(
      () => dispatchGallery({ type: "removed" }),
      (e) => dispatchGallery({ type: "failed", id: c.id, message: message(e) }),
    ).then(reload);
  };

  useEffect(() => {
    let alive = true;
    window.council.registry().then(
      (v) => { if (alive) setRegistry(v); },
      (e) => { if (alive) setRegistryError(message(e)); },
    );
    window.council.lastParticipants().then((v) => { if (alive) setLast(v); }, () => {});
    return () => { alive = false; };
  }, []);

  if (editor !== null) {
    return <TemplateEditorScreen key={editor.id ?? "new"} data={editor} backLabel={m.toTemplates} onDone={() => setEditor(null)} />;
  }
  if (picked === null && activeRerun === null) {
    return (
      <NewDiscussion
        view={templates}
        error={templatesError}
        defaultMaxRounds={registry?.defaults.maxRounds ?? null}
        onPick={(id) => setPicked({ template: id === null ? null : (templates?.templates.find((t) => t.id === id) ?? null) })}
        gallery={galleryState}
        onNew={() => openEditor({ mode: "new" })}
        onEdit={(id) => openEditor({ mode: "edit", id })}
        onDuplicate={(id) => openEditor({ mode: "duplicate", id })}
        dispatchGallery={dispatchGallery}
        onConfirmRemove={onConfirmRemove}
      />
    );
  }
  const back = () => { setPicked(null); setRerunUsed(true); };
  if (registry === null) {
    return (
      <>
        <header className="topbar">
          <h1 className="topbar__title">{m.sessionSetup}</h1>
          <div className="topbar__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={back}><Icon name="i-chevron-left" size="sm" /> {m.toTemplates}</button>
          </div>
        </header>
        <main className="content">
          {registryError ? (
            <div className="alert" data-tone="danger" role="alert">
              <Icon name="i-alert" />
              <div>
                <div className="alert__title">{m.registryFailed}</div>
                <div className="alert__text">{registryError}</div>
              </div>
            </div>
          ) : <p className="muted">{m.checkingProviders}</p>}
        </main>
      </>
    );
  }
  const template = activeRerun
    ? (activeRerun.templateId === null ? null : (templates?.templates.find((t) => t.id === activeRerun.templateId) ?? null))
    : picked!.template;
  return <Setup key={activeRerun ? `rerun:${activeRerun.sessionId}` : (template?.id ?? "custom")} registry={registry} template={template} last={last} rerun={activeRerun} active={active} onBack={back} onStarted={onStarted} />;
}
