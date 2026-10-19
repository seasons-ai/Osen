import { useEffect, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import type { DefaultsValues, ProviderInput, SettingsProvider, SettingsView } from "../../shared/settings.ts";
import { ConnectionsTab } from "./ConnectionsTab.tsx";
import { DefaultsPanel } from "./DefaultsPanel.tsx";
import { settings } from "../../shared/messages/settings.ts";
import { shell } from "../../shared/messages/shell.ts";
import { Icon } from "./icons.tsx";
import { AppearancePanel } from "./AppearancePanel.tsx";
import { LanguagePanel } from "./LanguagePanel.tsx";
import { useLanguageView, useMessages } from "./language.tsx";
import { ProviderCard } from "./ProviderCard.tsx";
import { EMPTY_PROVIDER, ProviderForm } from "./ProviderForm.tsx";
import { ProviderModels, modelsAfterAdd, modelsAfterRemove } from "./ProviderModels.tsx";
import { TestPanel, canTest, reduceTest } from "./ProviderTest.tsx";
import type { TestAction, TestState } from "./ProviderTest.tsx";

export interface SettingsState {
  view: SettingsView | null;
  loadError: string | null;
  tab: "providers" | "defaults" | "connections";
  rechecking: boolean;
  busy: Record<string, boolean>;
  drafts: Record<string, string>;
  tests: Record<string, TestState>;
  deleting: string | null;
  form: { input: ProviderInput; saving: boolean; error: string | null } | null;
  actionError: string | null;
  defaults: { draft: DefaultsValues; saving: boolean; error: string | null } | null;
}

export type SettingsAction =
  | { type: "view"; view: SettingsView; clearDraft?: string }
  | { type: "loadFailed"; message: string }
  | { type: "recheck" }
  | { type: "provider"; provider: SettingsProvider }
  | { type: "tab"; tab: SettingsState["tab"] }
  | { type: "openForm"; provider: SettingsProvider | null }
  | { type: "formChange"; input: ProviderInput }
  | { type: "formSaving" }
  | { type: "formFailed"; message: string }
  | { type: "formClose" }
  | { type: "formSaved"; view: SettingsView }
  | { type: "askDelete"; id: string }
  | { type: "cancelDelete" }
  | { type: "draft"; id: string; text: string }
  | { type: "begin"; id: string }
  | { type: "fail"; id: string; message: string }
  | { type: "test"; id: string; action: TestAction }
  | { type: "defaultsChange"; draft: DefaultsValues }
  | { type: "defaultsSaving" }
  | { type: "defaultsFailed"; message: string }
  | { type: "defaultsSaved"; view: SettingsView };

export const initialSettings = (): SettingsState => ({
  view: null, loadError: null, tab: "providers", rechecking: false, busy: {}, drafts: {}, tests: {},
  deleting: null, form: null, actionError: null, defaults: null,
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function isDirty(state: SettingsState): boolean {
  const saved = state.view?.defaults ?? null;
  return state.defaults !== null && saved !== null && !same(state.defaults.draft, saved);
}

const keep = <T,>(rec: Record<string, T>, ids: Set<string>): Record<string, T> =>
  Object.fromEntries(Object.entries(rec).filter(([id]) => ids.has(id)));

function applyView(state: SettingsState, view: SettingsView, forceDefaults: boolean): SettingsState {
  const ids = new Set(view.providers.map((p) => p.id));
  const untouched = state.defaults === null || state.view?.defaults == null || same(state.defaults.draft, state.view.defaults);
  const defaults = view.defaults === null ? null
    : forceDefaults || untouched ? { draft: view.defaults, saving: false, error: null }
    : { ...state.defaults!, saving: false };
  return {
    ...state, view, loadError: null, actionError: null, rechecking: false, busy: {}, defaults,
    drafts: keep(state.drafts, ids), tests: keep(state.tests, ids),
    deleting: state.deleting !== null && ids.has(state.deleting) ? state.deleting : null,
  };
}

const withoutKey = <T,>(rec: Record<string, T>, id: string): Record<string, T> => {
  const { [id]: _drop, ...rest } = rec;
  return rest;
};

export function reduceSettings(state: SettingsState, action: SettingsAction): SettingsState {
  switch (action.type) {
    case "view": {
      const next = applyView(state, action.view, false);
      return action.clearDraft === undefined ? next : { ...next, drafts: withoutKey(next.drafts, action.clearDraft) };
    }
    case "loadFailed": return { ...state, loadError: action.message, rechecking: false };
    case "recheck": return { ...state, rechecking: true, actionError: null };
    case "provider": {
      if (!state.view) return state;
      const providers = state.view.providers.map((p) => (p.id === action.provider.id ? action.provider : p));
      return { ...state, view: { ...state.view, providers }, busy: withoutKey(state.busy, action.provider.id) };
    }
    case "tab": return { ...state, tab: action.tab };
    case "openForm": {
      const p = action.provider;
      const input = p === null ? EMPTY_PROVIDER : { id: p.id, label: p.label, baseUrl: p.baseUrl ?? "", apiKeyEnv: p.keyEnv ?? "" };
      return { ...state, form: { input, saving: false, error: null } };
    }
    case "formChange": return state.form ? { ...state, form: { ...state.form, input: action.input } } : state;
    case "formSaving": return state.form ? { ...state, form: { ...state.form, saving: true, error: null } } : state;
    case "formFailed": return state.form ? { ...state, form: { ...state.form, saving: false, error: action.message } } : state;
    case "formClose": return { ...state, form: null };
    case "formSaved": return { ...applyView(state, action.view, false), form: null };
    case "askDelete": return { ...state, deleting: action.id, tests: withoutKey(state.tests, action.id) };
    case "cancelDelete": return { ...state, deleting: null };
    case "draft": return { ...state, drafts: { ...state.drafts, [action.id]: action.text } };
    case "begin": return { ...state, busy: { ...state.busy, [action.id]: true }, actionError: null };
    case "fail": return { ...state, busy: withoutKey(state.busy, action.id), actionError: action.message };
    case "test": {
      const provider = state.view?.providers.find((p) => p.id === action.id);
      if (!provider) return state;
      const prev = state.tests[action.id] ?? { phase: "idle" };
      return { ...state, tests: { ...state.tests, [action.id]: reduceTest(prev, action.action, provider) } };
    }
    case "defaultsChange": return state.defaults ? { ...state, defaults: { ...state.defaults, draft: action.draft } } : state;
    case "defaultsSaving": return state.defaults ? { ...state, defaults: { ...state.defaults, saving: true, error: null } } : state;
    case "defaultsFailed": return state.defaults ? { ...state, defaults: { ...state.defaults, saving: false, error: action.message } } : state;
    case "defaultsSaved": return applyView(state, action.view, true);
  }
}

export interface SettingsHandlers {
  onRecheck(): void;
  onTab(tab: SettingsState["tab"]): void;
  onOpenForm(provider: SettingsProvider | null): void;
  onFormChange(input: ProviderInput): void;
  onFormSave(): void;
  onFormClose(): void;
  onAskDelete(id: string): void;
  onCancelDelete(): void;
  onDelete(id: string): void;
  onDraft(id: string, text: string): void;
  onAddModel(provider: SettingsProvider): void;
  onRemoveModel(provider: SettingsProvider, model: string): void;
  onRefreshModels(id: string): void;
  onResetModels(id: string): void;
  onTest(id: string, action: TestAction): void;
  onDefaultsChange(draft: DefaultsValues): void;
  onDefaultsSave(): void;
}

const noHandlers: SettingsHandlers = {
  onRecheck() {}, onTab() {}, onOpenForm() {}, onFormChange() {}, onFormSave() {}, onFormClose() {}, onAskDelete() {},
  onCancelDelete() {}, onDelete() {}, onDraft() {}, onAddModel() {}, onRemoveModel() {}, onRefreshModels() {},
  onResetModels() {}, onTest() {}, onDefaultsChange() {}, onDefaultsSave() {},
};

function RecheckButton({ rechecking, onRecheck }: { rechecking: boolean; onRecheck(): void }): ReactNode {
  const t = useMessages(settings);
  return (
    <button type="button" className="btn btn--sm" disabled={rechecking} onClick={onRecheck}>
      <Icon name="i-refresh" size="sm" /> {rechecking ? t.rechecking : t.recheck}
    </button>
  );
}

function Body({ state, now, on }: { state: SettingsState; now: Date; on: SettingsHandlers }): ReactNode {
  const t = useMessages(settings);
  const { view, loadError, rechecking } = state;
  const tabs = (
    <div className="tabs settings-tabs" role="tablist">
      <button type="button" className="tab" role="tab" aria-selected={state.tab === "providers"} onClick={() => on.onTab("providers")}>{t.tabProviders}</button>
      <button type="button" className="tab" role="tab" aria-selected={state.tab === "defaults"} onClick={() => on.onTab("defaults")}>{t.tabDefaults}</button>
      <button type="button" className="tab" role="tab" aria-selected={state.tab === "connections"} onClick={() => on.onTab("connections")}>{t.tabConnections}</button>
    </div>
  );
  // Client settings do not live in config.json: this tab works while the registry is broken or still loading.
  if (state.tab === "connections") return <>{tabs}<ConnectionsTab /></>;
  if (loadError !== null) {
    return (
      <>
        {tabs}
        <div className="alert" data-tone="danger" role="alert">
          <Icon name="i-alert" />
          <div>
            <div className="alert__title">{t.loadFailedTitle}</div>
            <div className="alert__text">{loadError}</div>
          </div>
          <div className="alert__actions">
            <button type="button" className="btn btn--sm" disabled={rechecking} onClick={on.onRecheck}>{t.recheck}</button>
          </div>
        </div>
      </>
    );
  }
  if (view === null) return <>{tabs}<p className="muted">{t.loading}</p></>;
  if (view.registryError !== null) {
    return (
      <>
        {tabs}
        <div className="alert" data-tone="danger" role="alert">
          <Icon name="i-alert" />
          <div>
            <div className="alert__title">{t.configErrorTitle}</div>
            <div className="alert__text">{view.registryError}</div>
            <div className="alert__text">{t.fileLabel} <span className="mono">{view.configPath}</span></div>
            <div className="alert__text">{t.configErrorHelp}</div>
          </div>
          <div className="alert__actions"><RecheckButton rechecking={rechecking} onRecheck={on.onRecheck} /></div>
        </div>
      </>
    );
  }
  if (state.tab === "defaults") {
    return (
      <>
        {tabs}
        {state.defaults !== null && (
          <DefaultsPanel
            values={state.defaults.draft} providers={view.providers} configPath={view.configPath}
            dirty={isDirty(state)} saving={state.defaults.saving} error={state.defaults.error}
            onChange={on.onDefaultsChange} onSave={on.onDefaultsSave}
          />
        )}
      </>
    );
  }
  const down = view.providers.filter((p) => !p.available);
  const form = state.form;
  const formNode = (input: ProviderInput) => (
    <ProviderForm
      key={input.id ?? "new"} input={input} envPath={view.envPath} saving={form?.saving ?? false} error={form?.error ?? null}
      onChange={on.onFormChange} onSave={on.onFormSave} onCancel={on.onFormClose}
    />
  );
  return (
    <>
      {tabs}
      <div className="settings-head">
        <h2 className="section-title">{t.tabProviders}</h2>
        <RecheckButton rechecking={rechecking} onRecheck={on.onRecheck} />
        <button type="button" className="btn btn--sm" disabled={form !== null} onClick={() => on.onOpenForm(null)}>
          <Icon name="i-plus" size="sm" /> {t.addHttpProvider}
        </button>
      </div>
      {down.length > 0 && (
        <div className="settings-banner">
          <div className="alert" data-tone="danger">
            <Icon name="i-alert" />
            <div>
              <div className="alert__title">{t.unavailableTitle(down.length)}</div>
              <div className="alert__text">
                {t.unavailableList(down.map((p) => `${p.label} — ${p.keyEnv !== null && !p.keySet ? t.keyNotSet : p.reason}`).join("; "))}
              </div>
            </div>
          </div>
        </div>
      )}
      {state.actionError !== null && (
        <div className="settings-banner">
          <div className="alert" data-tone="danger" role="alert">
            <Icon name="i-alert" />
            <div>
              <div className="alert__title">{t.actionFailedTitle}</div>
              <div className="alert__text">{state.actionError}</div>
            </div>
          </div>
        </div>
      )}
      <div className="settings-grid">
        {view.providers.map((p) => {
          if (form !== null && form.input.id === p.id) return formNode(form.input);
          const busy = (state.busy[p.id] ?? false) || rechecking;
          const ts = state.tests[p.id];
          return (
            <ProviderCard
              key={p.id} provider={p} envPath={view.envPath} busy={busy} deleting={state.deleting === p.id} canTest={canTest(p)}
              models={
                <ProviderModels
                  provider={p} now={now} draft={state.drafts[p.id] ?? ""} busy={busy}
                  onDraft={(text) => on.onDraft(p.id, text)} onAdd={() => on.onAddModel(p)}
                  onRemove={(m) => on.onRemoveModel(p, m)} onRefresh={() => on.onRefreshModels(p.id)} onReset={() => on.onResetModels(p.id)}
                />
              }
              test={ts === undefined || ts.phase === "idle" ? null : <TestPanel provider={p} state={ts} dispatch={(a) => on.onTest(p.id, a)} />}
              onTest={() => on.onTest(p.id, { type: "ask" })} onRecheck={on.onRecheck}
              onEdit={() => on.onOpenForm(p)} onAskDelete={() => on.onAskDelete(p.id)}
              onDelete={() => on.onDelete(p.id)} onCancelDelete={on.onCancelDelete}
            />
          );
        })}
        {form !== null && form.input.id === null && formNode(form.input)}
      </div>
    </>
  );
}

// The hook lives in a separate component: SettingsScreen is called both as a function (tests) and as an element.
function Title(): ReactNode {
  const t = useMessages(shell);
  return <h1 className="topbar__title">{t.navSettings}</h1>;
}

export function SettingsScreen({ state, now, on = noHandlers }: { state: SettingsState; now: Date; on?: SettingsHandlers }): ReactNode {
  return (
    <>
      <header className="topbar"><Title /><div className="topbar__actions"></div></header>
      <main className="content"><LanguagePanel /><AppearancePanel /><Body state={state} now={now} on={on} /></main>
    </>
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Settings(): ReactNode {
  const [state, dispatch] = useReducer(reduceSettings, undefined, initialSettings);
  const ref = useRef(state);
  ref.current = state;
  const alive = useRef(true);
  const running = useRef(new Set<string>());

  const load = (call: () => Promise<SettingsView>) =>
    call().then(
      (view) => { if (alive.current) dispatch({ type: "view", view }); },
      (e) => { if (alive.current) dispatch({ type: "loadFailed", message: message(e) }); },
    );

  // A language change rereads the view: core reasons and list explanations come from main in the language of the request moment.
  const language = useLanguageView()?.language;
  useEffect(() => {
    alive.current = true;
    void load(() => window.council.settings());
    return () => { alive.current = false; };
  }, [language]);

  const act = (id: string, call: () => Promise<SettingsView>, clearDraft?: string) => {
    const s = ref.current;
    if (s.busy[id] || s.rechecking) return;
    dispatch({ type: "begin", id });
    call().then(
      (view) => { if (alive.current) dispatch({ type: "view", view, clearDraft }); },
      (e) => { if (alive.current) dispatch({ type: "fail", id, message: message(e) }); },
    );
  };

  const on: SettingsHandlers = {
    onRecheck() {
      if (ref.current.rechecking) return;
      dispatch({ type: "recheck" });
      void load(() => window.council.recheckProviders());
    },
    onTab: (tab) => dispatch({ type: "tab", tab }),
    onOpenForm: (provider) => dispatch({ type: "openForm", provider }),
    onFormChange: (input) => dispatch({ type: "formChange", input }),
    onFormSave() {
      const form = ref.current.form;
      if (!form || form.saving) return;
      dispatch({ type: "formSaving" });
      window.council.saveProvider(form.input).then(
        (view) => { if (alive.current) dispatch({ type: "formSaved", view }); },
        (e) => { if (alive.current) dispatch({ type: "formFailed", message: message(e) }); },
      );
    },
    onFormClose: () => dispatch({ type: "formClose" }),
    onAskDelete: (id) => dispatch({ type: "askDelete", id }),
    onCancelDelete: () => dispatch({ type: "cancelDelete" }),
    onDelete: (id) => act(id, () => window.council.deleteProvider(id)),
    onDraft: (id, text) => dispatch({ type: "draft", id, text }),
    onAddModel(provider) {
      const models = modelsAfterAdd(provider, ref.current.drafts[provider.id] ?? "");
      if (models !== null) act(provider.id, () => window.council.saveModels(provider.id, models), provider.id);
    },
    onRemoveModel: (provider, model) => act(provider.id, () => window.council.saveModels(provider.id, modelsAfterRemove(provider, model))),
    onResetModels: (id) => act(id, () => window.council.saveModels(id, [])),
    onRefreshModels(id) {
      const s = ref.current;
      if (s.busy[id] || s.rechecking) return;
      dispatch({ type: "begin", id });
      window.council.refreshModels(id).then(
        (provider) => { if (alive.current) dispatch({ type: "provider", provider }); },
        (e) => { if (alive.current) dispatch({ type: "fail", id, message: message(e) }); },
      );
    },
    onTest(id, action) {
      if (action.type !== "run") return dispatch({ type: "test", id, action });
      const t = ref.current.tests[id];
      if (t?.phase !== "confirm" || running.current.has(id)) return;
      running.current.add(id);
      dispatch({ type: "test", id, action });
      const done = (result: { ok: true; ms: number } | { ok: false; reason: string }) => {
        running.current.delete(id);
        if (alive.current) dispatch({ type: "test", id, action: { type: "result", result } });
      };
      window.council.testProvider(id, t.model).then(done, (e) => done({ ok: false, reason: message(e) }));
    },
    onDefaultsChange: (draft) => dispatch({ type: "defaultsChange", draft }),
    onDefaultsSave() {
      const d = ref.current.defaults;
      if (!d || d.saving) return;
      dispatch({ type: "defaultsSaving" });
      window.council.saveDefaults(d.draft).then(
        (view) => { if (alive.current) dispatch({ type: "defaultsSaved", view }); },
        (e) => { if (alive.current) dispatch({ type: "defaultsFailed", message: message(e) }); },
      );
    },
  };

  return <SettingsScreen state={state} now={new Date()} on={on} />;
}
