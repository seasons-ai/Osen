import { useEffect, useId, useReducer, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { CheckResult, ClientActionReply, ClientStatusView, CommandActionReply, CommandStatusView, ConnectionsView, InstallResult, RemoveResult } from "../../shared/connections.ts";
import { commandInstall } from "../../shared/messages/command-install.ts";
import { settings } from "../../shared/messages/settings.ts";
import { clientRow, commandRow, stepNote } from "./connections-model.ts";
import type { ClientButton, CommandButton, RowKind, StepNote } from "./connections-model.ts";
import { Icon } from "./icons.tsx";
import { useLanguage, useMessages } from "./language.tsx";

export type Confirm =
  | { kind: "connect" | "update" | "disconnect"; id: string }
  | { kind: "install" | "updateCommand" | "remove" };

const COMMAND = "$command"; // row key of the council command card; client ids never start with "$"

interface Outcome { refusal?: string; text?: string; detail?: string } // refusal — module code drawn from the catalog; text — already readable

export interface ConnectionsState {
  view: ConnectionsView | null;
  loadError: string | null;
  confirm: Confirm | null;
  busy: Record<string, boolean>;
  notes: Record<string, StepNote>; // memory only: never written to disk
  errors: Record<string, Outcome>;
  checks: Record<string, CheckResult>;
  copied: boolean;
}

export type ConnectionsAction =
  | { type: "view"; view: ConnectionsView }
  | { type: "loadFailed"; message: string }
  | { type: "ask"; confirm: Confirm }
  | { type: "cancel" }
  | { type: "begin"; key: string }
  | { type: "done"; key: string; view: ConnectionsView; note?: StepNote | null; error?: Outcome | null }
  | { type: "fail"; key: string; message: string }
  | { type: "checked"; key: string; result: CheckResult }
  | { type: "dismiss"; key: string }
  | { type: "copied" };

export const initialConnections = (): ConnectionsState =>
  ({ view: null, loadError: null, confirm: null, busy: {}, notes: {}, errors: {}, checks: {}, copied: false });

const without = <T,>(rec: Record<string, T>, key: string): Record<string, T> => {
  const { [key]: _drop, ...rest } = rec;
  return rest;
};

export function reduceConnections(s: ConnectionsState, a: ConnectionsAction): ConnectionsState {
  switch (a.type) {
    case "view": return { ...s, view: a.view, loadError: null };
    case "loadFailed": return { ...s, loadError: a.message };
    case "ask": return { ...s, confirm: a.confirm };
    case "cancel": return { ...s, confirm: null };
    case "begin":
      return { ...s, confirm: null, busy: { ...s.busy, [a.key]: true }, notes: without(s.notes, a.key), errors: without(s.errors, a.key), checks: without(s.checks, a.key) };
    case "done": {
      const notes = a.note ? { ...s.notes, [a.key]: a.note } : s.notes;
      const errors = a.error ? { ...s.errors, [a.key]: a.error } : s.errors;
      return { ...s, view: a.view, loadError: null, busy: without(s.busy, a.key), notes, errors };
    }
    case "fail": return { ...s, busy: without(s.busy, a.key), errors: { ...s.errors, [a.key]: { text: a.message } } };
    case "checked": return { ...s, busy: without(s.busy, a.key), checks: { ...s.checks, [a.key]: a.result } };
    case "dismiss": return { ...s, notes: without(s.notes, a.key) };
    case "copied": return { ...s, copied: true };
  }
}

export interface ConnectionsApi {
  connections(): Promise<ConnectionsView>;
  connectClient(id: string): Promise<ClientActionReply>;
  updateClient(id: string): Promise<ClientActionReply>;
  disconnectClient(id: string): Promise<ClientActionReply>;
  checkClient(id: string): Promise<CheckResult>;
  installCommand(): Promise<CommandActionReply<InstallResult>>;
  removeCommand(): Promise<CommandActionReply<RemoveResult>>;
  copyZprofileLine(): Promise<void>;
}

export interface ConnectionsHandlers {
  ask(confirm: Confirm): void;
  cancel(): void;
  accept(): void;
  check(id: string): void;
  dismiss(key: string): void;
  copy(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createConnectionsActions(
  getApi: () => ConnectionsApi, store: { get(): ConnectionsState; dispatch(a: ConnectionsAction): void },
): ConnectionsHandlers & { load(): Promise<void> } {
  const { dispatch } = store;
  const api = new Proxy({} as ConnectionsApi, { get: (_, name: keyof ConnectionsApi) => (...args: never[]) => (getApi()[name] as (...a: never[]) => unknown)(...args) });
  const guard = (key: string, run: () => Promise<void>) => {
    if (store.get().busy[key]) return;
    dispatch({ type: "begin", key });
    run().catch((e) => dispatch({ type: "fail", key, message: message(e) }));
  };
  // the step note follows only connect and update (spec «Пометка о шаге в клиенте»)
  const client = async (id: string, call: () => Promise<ClientActionReply>, noted: boolean) => {
    const { result, view } = await call();
    if (result.ok) return dispatch({ type: "done", key: id, view, note: noted ? stepNote(result) : null });
    const reason = "reason" in result ? result.reason : undefined;
    dispatch({ type: "done", key: id, view, error: { refusal: result.refusal, detail: reason?.detail } });
  };
  const command = async (call: () => Promise<CommandActionReply<InstallResult | RemoveResult>>) => {
    const { result, view } = await call();
    dispatch({ type: "done", key: COMMAND, view, error: result.ok ? null : { text: result.message } });
  };
  return {
    load: () => api.connections().then((view) => dispatch({ type: "view", view }), (e) => dispatch({ type: "loadFailed", message: message(e) })),
    ask: (confirm) => dispatch({ type: "ask", confirm }),
    cancel: () => dispatch({ type: "cancel" }),
    accept() {
      const c = store.get().confirm;
      if (c === null) return;
      if ("id" in c) {
        const call = { connect: api.connectClient, update: api.updateClient, disconnect: api.disconnectClient }[c.kind];
        guard(c.id, () => client(c.id, () => call.call(api, c.id), c.kind !== "disconnect"));
      } else if (c.kind === "remove") guard(COMMAND, () => command(() => api.removeCommand()));
      else guard(COMMAND, () => command(() => api.installCommand()));
    },
    check: (id) => guard(id, async () => dispatch({ type: "checked", key: id, result: await api.checkClient(id) })),
    dismiss: (key) => dispatch({ type: "dismiss", key }),
    copy() {
      api.copyZprofileLine().then(() => dispatch({ type: "copied" }), (e) => dispatch({ type: "fail", key: COMMAND, message: message(e) }));
    },
  };
}

/** Escape closes the dialog; every other key is left alone. */
export function dialogKey(e: { key: string; preventDefault(): void }, cancel: () => void): void {
  if (e.key !== "Escape") return;
  e.preventDefault();
  cancel();
}

const Mono = ({ children }: { children: ReactNode }) => <span className="mono">{children}</span>;

const BADGE: Record<RowKind, { tone: string; icon: "i-info" | "i-check" | "i-x" | "i-alert" }> = {
  not_installed: { tone: "muted", icon: "i-info" },
  not_connected: { tone: "muted", icon: "i-info" },
  connected: { tone: "ok", icon: "i-check" },
  foreign: { tone: "danger", icon: "i-x" },
  stale_path: { tone: "warn", icon: "i-alert" },
  corrupt: { tone: "danger", icon: "i-x" },
  undetermined: { tone: "danger", icon: "i-x" },
};

const joined = (c: { command: string; args: string[] }) => [c.command, ...c.args].join(" ");

const chipOf = (file: string) => {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toUpperCase();
  return ext ?? "CLI";
};

function Alert({ tone, children, actions, role }: { tone: "danger" | "warn"; children: ReactNode; actions?: ReactNode; role?: "alert" }): ReactNode {
  return (
    <div className="alert" data-tone={tone} role={role}>
      <Icon name="i-alert" />
      <div>{children}</div>
      {actions && <div className="alert__actions">{actions}</div>}
    </div>
  );
}

function Dialog({ title, body, confirmLabel, onConfirm, onCancel }: {
  title: string; body: string; confirmLabel: string; onConfirm(): void; onCancel(): void;
}): ReactNode {
  const t = useMessages(settings);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.querySelector("button")?.focus(); }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    dialogKey(e, onCancel);
    if (e.key !== "Tab") return;
    const all = [...e.currentTarget.querySelectorAll("button")];
    const edge = e.shiftKey ? all[0] : all[all.length - 1];
    if (document.activeElement === edge) { e.preventDefault(); (e.shiftKey ? all[all.length - 1] : all[0])?.focus(); }
  };
  return (
    <div className="conn-scrim">
      <div className="conn-dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={root} onKeyDown={onKeyDown}>
        <h3 className="conn-dialog__title" id={id}>{title}</h3>
        <p className="conn-dialog__text">{body}</p>
        <div className="settings-actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={onConfirm}>{confirmLabel}</button>
          <button type="button" className="btn btn--sm" onClick={onCancel}>{t.connCancel}</button>
          <span className="muted">{t.connEscapeCloses}</span>
        </div>
      </div>
    </div>
  );
}

type Row = { state: ConnectionsState; on: ConnectionsHandlers; rowKey: string };

function Outcomes({ state, on, rowKey: key }: Row): ReactNode {
  const t = useMessages(settings);
  const note = state.notes[key];
  const error = state.errors[key];
  const check = state.checks[key];
  const noteText = note === undefined ? null : { confirm_in_client: t.connNoteConfirm, restart_client: t.connNoteRestart, unverified: t.connNoteUnverified, done: t.connNoteDone }[note];
  return (
    <>
      {note !== undefined && note !== "done" && (
        <Alert tone="warn" actions={<button type="button" className="btn btn--sm" onClick={() => on.dismiss(key)}>{t.connUnderstood}</button>}>
          <div className="alert__title">{noteText}</div>
        </Alert>
      )}
      {note === "done" && (
        <p className="conn-result" role="status">
          <Icon name="i-check" size="sm" /> {noteText} <button type="button" className="btn btn--sm btn--ghost" onClick={() => on.dismiss(key)}>{t.connUnderstood}</button>
        </p>
      )}
      {error !== undefined && (
        <Alert tone="danger" role="alert">
          <div className="alert__title">{error.refusal !== undefined ? t.connRefusal(error.refusal) : error.text}</div>
          {error.detail !== undefined && <div className="alert__text">{error.detail}</div>}
        </Alert>
      )}
      {check !== undefined && (check.ok
        ? <div className="conn-result" role="status"><Icon name="i-check" size="sm" /> <Mono>{t.connCheckOk(check.tools.length, check.durationMs)}</Mono></div>
        : <Alert tone="danger" role="alert"><div className="alert__text">{t.connCheckFailed(check.reason, check.detail)}</div></Alert>)}
    </>
  );
}

function ClientCard({ s, state, on }: { s: ClientStatusView; state: ConnectionsState; on: ConnectionsHandlers }): ReactNode {
  const t = useMessages(settings);
  const { kind, buttons } = clientRow(s);
  const busy = state.busy[s.client] ?? false;
  const stateWord = {
    not_installed: t.connStateNotInstalled, not_connected: t.connStateNotConnected, connected: t.connStateConnected,
    foreign: t.connStateForeign, stale_path: t.connStateStalePath, corrupt: t.connStateCorrupt, undetermined: t.connStateUndetermined,
  }[kind];
  const label: Record<ClientButton, ReactNode> = {
    connect: <><Icon name="i-plus" size="sm" /> {t.connConnect}</>,
    update: <><Icon name="i-refresh" size="sm" /> {t.connUpdate}</>,
    disconnect: <><Icon name="i-x" size="sm" /> {t.connDisconnect}</>,
    check: <><Icon name="i-play" size="sm" /> {t.connCheck}</>,
  };
  const click = (b: ClientButton) => (b === "check" ? on.check(s.client) : on.ask({ kind: b, id: s.client }));
  const recorded = s.entry === null ? null : joined(s.entry);
  const detail = s.reason?.detail;
  return (
    <article className="card settings-card">
      <div className="settings-card__head">
        <h3 className="settings-card__name">{t.connClientName(s.client)}</h3>
        <span className="chip mono">{chipOf(s.file)}</span>
        <span className="badge" data-tone={BADGE[kind].tone}><Icon name={BADGE[kind].icon} size="sm" /> {stateWord}</span>
      </div>
      <dl className="kv settings-info">
        <dt>{t.connFile}</dt><dd><Mono>{s.file}</Mono></dd>
        <dt>{t.connEntry}</dt><dd><Mono>{s.entryKey}</Mono></dd>
        {recorded !== null && <><dt>{t.connRecordedCommand}</dt><dd><Mono>{recorded}</Mono></dd></>}
        {kind === "stale_path" && state.view?.serverCommand && <><dt>{t.connServerCommand}</dt><dd><Mono>{joined(state.view.serverCommand)}</Mono></dd></>}
      </dl>
      {kind === "not_installed" && <p className="muted settings-card__note">{t.connNotInstalledNote}</p>}
      {kind === "foreign" && recorded !== null && (
        <Alert tone="danger"><div className="alert__title">{t.connReasonForeign}</div><div className="alert__text"><Mono>{recorded}</Mono></div></Alert>
      )}
      {kind === "corrupt" && (
        <Alert tone="danger"><div className="alert__title">{t.connReasonCorrupt}</div><div className="alert__text">{detail} <Mono>{s.file}</Mono></div></Alert>
      )}
      {kind === "undetermined" && (
        <Alert tone="danger"><div className="alert__title">{t.connReasonUndetermined}</div><div className="alert__text">{detail}</div></Alert>
      )}
      <Outcomes state={state} on={on} rowKey={s.client} />
      {buttons.length > 0 && (
        <div className="settings-actions">
          {buttons.map((b) => (
            <button key={b} type="button" className={`btn btn--sm${b === "disconnect" ? " btn--ghost" : ""}`} disabled={busy} onClick={() => click(b)}>{label[b]}</button>
          ))}
          {buttons.includes("check") && <span className="muted">{t.connNoModelCalls}</span>}
        </div>
      )}
    </article>
  );
}

function CommandCard({ c, state, on }: { c: CommandStatusView; state: ConnectionsState; on: ConnectionsHandlers }): ReactNode {
  const t = useMessages(settings);
  const language = useLanguage();
  const { kind, buttons } = commandRow(c);
  const busy = state.busy[COMMAND] ?? false;
  const word = {
    not_installed: t.connCmdNotInstalled, found: t.connCmdFound, not_in_path: t.connCmdNotInPath, shadowed: t.connCmdShadowed,
    stale: t.connCmdStale, foreign: t.connCmdForeign, undetermined: t.connCmdUndetermined,
  }[kind];
  const badge = ({
    not_installed: { tone: "muted", icon: "i-info" }, found: { tone: "ok", icon: "i-check" }, not_in_path: { tone: "warn", icon: "i-alert" },
    shadowed: { tone: "warn", icon: "i-alert" }, stale: { tone: "warn", icon: "i-alert" }, foreign: { tone: "danger", icon: "i-x" },
    undetermined: { tone: "danger", icon: "i-x" },
  } as const)[kind];
  const label: Record<CommandButton, ReactNode> = {
    install: <><Icon name="i-plus" size="sm" /> {t.connInstall}</>,
    update: <><Icon name="i-refresh" size="sm" /> {t.connUpdate}</>,
    remove: <><Icon name="i-trash" size="sm" /> {t.connRemove}</>,
    copy: null,
  };
  const click = (b: CommandButton) => on.ask({ kind: b === "install" ? "install" : b === "update" ? "updateCommand" : "remove" });
  const kindText = c.state === "foreign" ? commandInstall(language)[({ file: "kindFile", dir: "kindDir", symlink: "kindSymlink", other: "kindOther" } as const)[c.foreignKind]] : "";
  return (
    <article className="card settings-card">
      <div className="settings-card__head">
        <h3 className="settings-card__name settings-card__name--wrap">{t.connCouncilTitle}</h3>
        <span className="chip mono">CLI</span>
        <span className="badge" data-tone={badge.tone}><Icon name={badge.icon} size="sm" /> {word}</span>
      </div>
      <dl className="kv settings-info">
        <dt>{t.connFile}</dt><dd><Mono>{c.link}</Mono></dd>
        {"target" in c && c.target !== undefined && <><dt>→</dt><dd><Mono>{c.target}</Mono></dd></>}
        {c.state === "shadowed" && <><dt>{t.connShadowedBy}</dt><dd><Mono>{c.shadowedBy}</Mono></dd></>}
        {c.state === "stale" && <><dt>{t.connServerCommand}</dt><dd><Mono>{c.expected}</Mono></dd></>}
      </dl>
      {c.state === "foreign" && <Alert tone="danger"><div className="alert__text">{commandInstall(language).refusalForeign(c.link, kindText)}</div></Alert>}
      {(c.state === "check_failed" || c.state === "error") && <Alert tone="danger"><div className="alert__text">{c.reason}</div></Alert>}
      {c.state === "not_in_path" && (
        <>
          <p className="muted settings-card__note">{t.connZprofileHint}</p>
          <div className="conn-line">
            <code className="mono conn-line__text">{c.hint.line}</code>
            <button type="button" className="btn btn--sm" onClick={on.copy}><Icon name="i-copy" size="sm" /> {t.connCopy}</button>
            {state.copied && <span className="muted" role="status">{t.connCopied}</span>}
          </div>
        </>
      )}
      <Outcomes state={state} on={on} rowKey={COMMAND} />
      {buttons.filter((b) => b !== "copy").length > 0 && (
        <div className="settings-actions">
          {buttons.filter((b) => b !== "copy").map((b) => (
            <button key={b} type="button" className={`btn btn--sm${b === "remove" ? " btn--ghost" : ""}`} disabled={busy} onClick={() => click(b)}>{label[b]}</button>
          ))}
        </div>
      )}
    </article>
  );
}

function ConfirmDialog({ state, on }: { state: ConnectionsState; on: ConnectionsHandlers }): ReactNode {
  const t = useMessages(settings);
  const c = state.confirm;
  const view = state.view;
  if (c === null || view === null) return null;
  if ("id" in c) {
    const s = view.clients.find((x) => x.client === c.id);
    if (s === undefined) return null;
    const name = t.connClientName(c.id);
    const { title, body, label } = {
      connect: { title: t.connConfirmConnectTitle(name), body: t.connConfirmConnectBody(name, s.file, s.entryKey), label: t.connConnect },
      update: { title: t.connConfirmUpdateTitle(name), body: t.connConfirmUpdateBody(name, s.file, s.entryKey), label: t.connUpdate },
      disconnect: { title: t.connConfirmDisconnectTitle(name), body: t.connConfirmDisconnectBody(name, s.file, s.entryKey), label: t.connDisconnect },
    }[c.kind];
    return <Dialog title={title} body={body} confirmLabel={label} onConfirm={on.accept} onCancel={on.cancel} />;
  }
  const link = view.command.link;
  const { title, body, label } = {
    install: { title: t.connConfirmInstallTitle, body: t.connConfirmInstallBody(link), label: t.connInstall },
    updateCommand: { title: t.connConfirmUpdateCommandTitle, body: t.connConfirmUpdateCommandBody(link), label: t.connUpdate },
    remove: { title: t.connConfirmRemoveTitle, body: t.connConfirmRemoveBody(link), label: t.connRemove },
  }[c.kind];
  return <Dialog title={title} body={body} confirmLabel={label} onConfirm={on.accept} onCancel={on.cancel} />;
}

export function ConnectionsPanel({ state, on }: { state: ConnectionsState; on: ConnectionsHandlers }): ReactNode {
  const t = useMessages(settings);
  const { view } = state;
  const loadError = state.loadError === null ? null : <Alert tone="danger" role="alert"><div className="alert__text">{state.loadError}</div></Alert>;
  if (view === null) return loadError ?? <p className="muted" aria-busy="true">…</p>;
  return (
    <>
      {loadError}
      <div className="settings-head"><h2 className="section-title">{t.tabConnections}</h2><span className="muted">{t.connIntro}</span></div>
      <div className="settings-grid">
        {view.clients.map((s) => <ClientCard key={s.client} s={s} state={state} on={on} />)}
        <CommandCard c={view.command} state={state} on={on} />
      </div>
      <ConfirmDialog state={state} on={on} />
    </>
  );
}

export function ConnectionsTab(): ReactNode {
  const [state, dispatch] = useReducer(reduceConnections, undefined, initialConnections);
  const ref = useRef(state);
  ref.current = state;
  const alive = useRef(true);
  const opener = useRef<HTMLElement | null>(null);
  const language = useLanguage();

  const safeDispatch = (a: ConnectionsAction) => { if (alive.current) dispatch(a); };
  const actions = createConnectionsActions(() => window.council, { get: () => ref.current, dispatch: safeDispatch });

  // Read the module when the tab opens (and after a language change: reasons come from main in the request-time language).
  useEffect(() => {
    alive.current = true;
    void actions.load();
    return () => { alive.current = false; };
  }, [language]);

  // Return focus to the button that opened the dialog.
  const open = state.confirm !== null;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open && opener.current?.isConnected) opener.current.focus();
    wasOpen.current = open;
  }, [open]);

  const on: ConnectionsHandlers = {
    ...actions,
    ask(confirm) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      actions.ask(confirm);
    },
  };
  return <ConnectionsPanel state={state} on={on} />;
}
