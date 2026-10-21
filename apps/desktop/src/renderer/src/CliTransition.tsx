import type { ReactNode } from "react";
import type { Language } from "@model-council/core/i18n";
import { PERIOD_BOUNDS, checkPeriod } from "../../shared/settings.ts";
import type { CliLevel, CliTransition, CliTransitionSettings, SettingsProvider, SettingsView } from "../../shared/settings.ts";
import type { Bridge } from "../../shared/bridge.ts";
import { settings } from "../../shared/messages/settings.ts";
import { Icon } from "./icons.tsx";
import { useLanguage, useMessages } from "./language.tsx";

// CLI transition UI (change 182): card rows and lines, the banner and the period block. Main computes everything (CliTransition);
// this module only shows it and keeps the confirmation, the refusal and the period draft.

export type CliKind = "switch" | "rollback";
/** An open confirmation: the versions are fixed when it opens, so a language change or a re-read of the view does not alter them. */
export interface CliConfirm { agent: string; kind: CliKind; from: string; to: string }

export interface CliUi {
  confirm: CliConfirm | null;
  busy: boolean;
  refusal: { agent: string; message: string } | null; // shown next to the button
  copied: string | null;                               // agent whose install command was just copied
  period: string | null;                               // the field draft; null — untouched, the saved value is shown
  periodSaving: boolean;
  periodError: string | null;                          // a save refusal
}

export const initialCliUi = (): CliUi => ({ confirm: null, busy: false, refusal: null, copied: null, period: null, periodSaving: false, periodError: null });

export type CliAction =
  | { type: "ask"; confirm: CliConfirm }
  | { type: "cancel" }
  | { type: "begin" }
  | { type: "refused"; agent: string; message: string }
  | { type: "copied"; agent: string }
  | { type: "period"; text: string }
  | { type: "periodSaving" }
  | { type: "periodFailed"; message: string }
  | { type: "applied" }; // a bridge action returned a new view

export function reduceCliUi(ui: CliUi, a: CliAction): CliUi {
  switch (a.type) {
    case "ask": return { ...ui, confirm: a.confirm, refusal: null };
    case "cancel": return { ...ui, confirm: null };
    case "begin": return { ...ui, busy: true, refusal: null };
    case "refused": return { ...ui, busy: false, confirm: null, refusal: { agent: a.agent, message: a.message } };
    case "copied": return { ...ui, copied: a.agent };
    case "period": return { ...ui, period: a.text, periodError: null };
    case "periodSaving": return { ...ui, periodSaving: true, periodError: null };
    case "periodFailed": return { ...ui, periodSaving: false, periodError: a.message };
    case "applied": return { ...initialCliUi(), copied: ui.copied };
  }
}

export interface CliHandlers {
  ask(cli: CliTransition, kind: CliKind): void;
  cancel(): void;
  confirm(): void;
  copy(agent: string, command: string): void;
  period(text: string): void;
  savePeriod(): void;
}
export const noCliHandlers: CliHandlers = { ask() {}, cancel() {}, confirm() {}, copy() {}, period() {}, savePeriod() {} };

export type CliApi = Pick<Bridge, "switchCli" | "rollbackCli" | "setTransitionPeriod" | "copyText">;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The only code that calls the bridge for a transition: a call happens on the confirm press and on the period save, never on its own. */
export function createCliActions(api: () => CliApi, store: { get(): CliUi; dispatch(a: CliAction): void; apply(view: SettingsView): void }): CliHandlers {
  return {
    ask(cli, kind) {
      const from = cli.pin?.version;
      const to = kind === "switch" ? cli.target?.version : cli.pin?.previous;
      if (!from || !to) return;
      store.dispatch({ type: "ask", confirm: { agent: cli.agent, kind, from, to } });
    },
    cancel: () => store.dispatch({ type: "cancel" }),
    confirm() {
      const { confirm, busy } = store.get();
      if (confirm === null || busy) return;
      store.dispatch({ type: "begin" });
      const call = confirm.kind === "switch" ? api().switchCli(confirm.agent, confirm.to) : api().rollbackCli(confirm.agent);
      call.then(store.apply, (e) => store.dispatch({ type: "refused", agent: confirm.agent, message: message(e) }));
    },
    copy(agent, command) {
      api().copyText(command).then(() => store.dispatch({ type: "copied", agent }), () => {});
    },
    period: (text) => store.dispatch({ type: "period", text }),
    savePeriod() {
      const ui = store.get();
      const days = Number(ui.period);
      if (ui.period === null || ui.periodSaving || checkPeriod(ui.period.trim() === "" ? NaN : days) !== null) return;
      store.dispatch({ type: "periodSaving" });
      api().setTransitionPeriod(days).then(store.apply, (e) => store.dispatch({ type: "periodFailed", message: message(e) }));
    },
  };
}

/** Everything the card needs besides the provider itself. */
export interface CliCardProps { running: boolean; confirm: CliConfirm | null; refusal: string | null; copied: boolean; busy: boolean; on: CliHandlers }
export const NO_CLI_CARD: CliCardProps = { running: false, confirm: null, refusal: null, copied: false, busy: false, on: noCliHandlers };

const Mono = ({ children }: { children: ReactNode }) => <span className="mono">{children}</span>;

/** YYYY-MM-DD (record) or a pins.json stamp YYYY-MM-DDTHH:MM:SSZ as a calendar date in the current language; the day does not shift with the time zone. */
export const formatDay = (day: string, language: Language): string => {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(d);
};
const formatAt = (iso: string, language: Language): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(d);
};

const LEVEL_BADGE: Record<CliLevel, { tone: string; icon: "i-check" | "i-info" }> = {
  real: { tone: "ok", icon: "i-check" },
  interface: { tone: "info", icon: "i-info" },
  none: { tone: "muted", icon: "i-info" },
};

/** The «Source» row goes before the version row. */
export function CliSourceRow({ cli }: { cli: CliTransition }): ReactNode {
  const t = useMessages(settings);
  if (cli.source === null) return null;
  const text = { pin: t.cliSourcePin, path: t.cliSourcePath, explicit: t.cliSourceExplicit }[cli.source];
  return <><dt>{t.cliSource}</dt><dd>{text}</dd></>;
}

/** The level and pin rows go after the version and command rows. */
export function CliDetailRows({ cli }: { cli: CliTransition }): ReactNode {
  const t = useMessages(settings);
  const language = useLanguage();
  if (cli.source === null) return null;
  const level = LEVEL_BADGE[cli.level];
  const levelText = { real: t.cliLevelReal, interface: t.cliLevelInterface, none: t.cliLevelNone }[cli.level];
  return (
    <>
      <dt>{t.cliLevel}</dt>
      <dd>
        <span className="badge" data-tone={level.tone}><Icon name={level.icon} size="sm" /> {levelText}</span>
        {cli.checkedAt !== null && <> <span className="muted">{formatDay(cli.checkedAt, language)}</span></>}
      </dd>
      {cli.pin !== null && (
        <>
          <dt>{t.cliActiveSince}</dt>
          <dd>{cli.pin.activatedAt !== null ? formatDay(cli.pin.activatedAt, language) : <span className="muted">{t.cliActivationUnknown}</span>}</dd>
          {cli.pin.previous !== null && <><dt>{t.cliPrevious}</dt><dd><Mono>{cli.pin.previous}</Mono></dd></>}
        </>
      )}
    </>
  );
}

const Note = ({ children }: { children: ReactNode }) => <p className="muted settings-card__note"><Icon name="i-info" size="sm" /> {children}</p>;

function Alert({ tone, title, children }: { tone: "info" | "warn" | "danger"; title: string; children: ReactNode }): ReactNode {
  return (
    <div className="alert" data-tone={tone}>
      <Icon name={tone === "info" ? "i-info" : "i-alert"} />
      <div>
        <div className="alert__title">{title}</div>
        <div className="alert__text">{children}</div>
      </div>
    </div>
  );
}

/** Lines of the card between the rows and the actions; the buttons are in CliActions. */
export function CliLines({ provider: p, cli, ui }: { provider: SettingsProvider; cli: CliTransition; ui: CliCardProps }): ReactNode {
  const t = useMessages(settings);
  const language = useLanguage();
  return (
    <>
      {cli.source === "path" && <Note>{t.cliPathNote}</Note>}
      {cli.source === "explicit" && cli.pin !== null && <Note>{t.cliExplicitNote(cli.pin.version)}</Note>}
      {cli.due !== null && <Alert tone="warn" title={t.cliDueTitle}>{t.cliDueText(cli.due.from, cli.due.to, t.cliDays(cli.due.ageDays), formatDay(cli.due.acceptedAt, language))}</Alert>}
      {cli.candidates.map((c) => <Alert key={c.version} tone="info" title={t.cliCandidateTitle(c.version)}>{t.cliCandidateText}</Alert>)}
      {cli.violations.map((v) => <Alert key={v.version} tone="danger" title={t.cliViolationTitle(v.version)}>{t.cliViolationText(v.names.join(", "))}</Alert>)}
      {cli.install !== null && (
        <>
          <Alert tone="info" title={t.cliInstallTitle(cli.install.version)}>{t.cliInstallText}</Alert>
          <div className="conn-line">
            <code className="mono conn-line__text">{cli.install.command}</code>
            <button type="button" className="btn btn--sm" onClick={() => ui.on.copy(cli.agent, cli.install!.command)}><Icon name="i-copy" size="sm" /> {t.connCopy}</button>
            {ui.copied && <span className="muted" role="status">{t.connCopied}</span>}
          </div>
        </>
      )}
      {cli.check !== null && cli.check.outcome !== "ok" && <Alert tone="warn" title={t.cliCheckFailedTitle}>{t.cliCheckFailedText(cli.check.outcome, formatAt(cli.check.at, language))}</Alert>}
      {cli.check?.notSaved && <Alert tone="warn" title={t.cliCheckNotSavedTitle}>{t.cliCheckNotSavedText(cli.check.notSaved.file, cli.check.notSaved.code, formatAt(cli.check.at, language))}</Alert>}
      {ui.confirm !== null && (
        <div className="alert" data-tone="info" role="alert">
          <Icon name="i-info" />
          <div>
            <div className="alert__title">{(ui.confirm.kind === "switch" ? t.cliConfirmSwitchTitle : t.cliConfirmRollbackTitle)(p.label, ui.confirm.from, ui.confirm.to)}</div>
            <div className="alert__text">{t.cliConfirmText(ui.confirm.to)}</div>
          </div>
          <div className="alert__actions">
            <button type="button" className="btn btn--primary btn--sm" disabled={ui.busy || ui.running} onClick={ui.on.confirm}>{ui.confirm.kind === "switch" ? t.cliConfirmSwitch : t.cliConfirmRollback}</button>
            <button type="button" className="btn btn--sm" disabled={ui.busy} onClick={ui.on.cancel}>{t.cancel}</button>
            {ui.running && <span className="muted"><Icon name="i-info" size="sm" /> {t.cliRunning}</span>}
          </div>
        </div>
      )}
    </>
  );
}

/** «Switch to» and «Roll back»: only for the Osen pin, never while the confirmation is open. */
export function CliActions({ cli, ui }: { cli: CliTransition; ui: CliCardProps }): ReactNode {
  const t = useMessages(settings);
  if (cli.source !== "pin" || ui.confirm !== null) return null;
  const previous = cli.pin?.previous ?? null;
  if (cli.target === null && cli.pin === null && ui.refusal === null) return null;
  return (
    <div className="settings-actions">
      {cli.target !== null && <button type="button" className="btn btn--primary btn--sm" disabled={ui.running} onClick={() => ui.on.ask(cli, "switch")}>{t.cliSwitchTo(cli.target.version)}</button>}
      {previous !== null && <button type="button" className="btn btn--sm" disabled={ui.running} onClick={() => ui.on.ask(cli, "rollback")}>{t.cliRollbackTo(previous)}</button>}
      {previous === null && cli.pin !== null && <><button type="button" className="btn btn--sm" disabled>{t.cliRollback}</button><span className="muted"><Icon name="i-info" size="sm" /> {t.cliNoPrevious}</span></>}
      {ui.running && <span className="muted"><Icon name="i-info" size="sm" /> {t.cliRunning}</span>}
      {ui.refusal !== null && <span className="settings-cli__refusal" role="alert"><Icon name="i-alert" size="sm" /> {ui.refusal}</span>}
    </div>
  );
}

/** One banner for every CLI whose planned transition is due; the same data as the card line. */
export function CliDueBanner({ providers }: { providers: SettingsProvider[] }): ReactNode {
  const t = useMessages(settings);
  const language = useLanguage();
  const due = providers.flatMap((p) => (p.cli?.due ? [{ p, due: p.cli.due }] : []));
  if (due.length === 0) return null;
  return (
    <div className="settings-banner">
      <div className="alert" data-tone="warn">
        <Icon name="i-alert" />
        <div>
          <div className="alert__title">{t.cliDueTitle}</div>
          {due.map(({ p, due: d }) => <div key={p.id} className="alert__text">{p.label}: {t.cliDueText(d.from, d.to, t.cliDays(d.ageDays), formatDay(d.acceptedAt, language))}</div>)}
        </div>
      </div>
    </div>
  );
}

/** One block for all CLIs: the planned transition period and the reminder file error. */
export function CliPeriodBlock({ transition, ui, on }: { transition: CliTransitionSettings; ui: CliUi; on: CliHandlers }): ReactNode {
  const t = useMessages(settings);
  const text = ui.period ?? String(transition.periodDays);
  const invalid = ui.period !== null ? checkPeriod(ui.period.trim() === "" ? NaN : Number(ui.period)) : null;
  const hint = invalid ?? ui.periodError;
  return (
    <div className="card settings-cli">
      <h4 className="settings-cli__title">{t.cliBlockTitle}</h4>
      <div className="settings-cli__row">
        <label className="field">
          <span className="field__label">{t.cliPeriodLabel}</span>
          <input className="input settings-cli__input" value={text} inputMode="numeric" aria-invalid={hint !== null} onChange={(e) => on.period(e.target.value)} />
          {hint !== null
            ? <span className="field__hint" data-tone="danger" role="alert"><Icon name="i-alert" size="sm" /> {hint}</span>
            : <span className="field__hint">{t.cliPeriodHint(PERIOD_BOUNDS.min, PERIOD_BOUNDS.max)}</span>}
        </label>
        <button type="button" className="btn btn--sm" disabled={ui.period === null || invalid !== null || ui.periodSaving} onClick={on.savePeriod}>{t.save}</button>
      </div>
      {transition.fileError !== null && (
        <div className="alert" data-tone="danger" role="alert">
          <Icon name="i-alert" />
          <div>
            <div className="alert__title">{t.cliFileDamagedTitle}</div>
            <div className="alert__text">{transition.fileError}</div>
            <div className="alert__text">{t.cliFileDamagedText}</div>
          </div>
        </div>
      )}
    </div>
  );
}
