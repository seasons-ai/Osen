import type { ReactNode } from "react";
import type { SettingsProvider } from "../../shared/settings.ts";
import { settings } from "../../shared/messages/settings.ts";
import { Icon } from "./icons.tsx";
import { CliActions, CliDetailRows, CliLines, CliSourceRow, NO_CLI_CARD } from "./CliTransition.tsx";
import type { CliCardProps } from "./CliTransition.tsx";
import { useMessages } from "./language.tsx";

const Mono = ({ children }: { children: ReactNode }) => <span className="mono">{children}</span>;

export function ProviderCard({ provider: p, envPath, busy, deleting, canTest, models, test, onTest, onRecheck, onEdit, onAskDelete, onDelete, onCancelDelete, cli: cliUi = NO_CLI_CARD }: {
  provider: SettingsProvider;
  envPath: string;
  busy: boolean;
  deleting: boolean;
  canTest: boolean;
  models: ReactNode;
  test: ReactNode | null;
  onTest(): void;
  onRecheck(): void;
  onEdit(): void;
  onAskDelete(): void;
  onDelete(): void;
  onCancelDelete(): void;
  cli?: CliCardProps; // transition state of the card; the data itself is provider.cli
}): ReactNode {
  const t = useMessages(settings);
  const cli = p.kind === "cli";
  const keyMissing = p.keyEnv !== null && !p.keySet;
  const badge = p.available
    ? { tone: "ok", icon: "i-check", text: t.available } as const
    : keyMissing
      ? { tone: "warn", icon: "i-alert", text: t.keyNotSet } as const
      : { tone: "danger", icon: "i-x", text: cli ? t.unavailable : t.notResponding } as const;
  const paid = !cli && p.billing === "paid";
  const spends = (text: string) => <span className="chip">{text}</span>;
  return (
    <article className="card settings-card">
      <div className="settings-card__head">
        <h3 className="settings-card__name">{p.label}</h3>
        <span className="chip mono">{cli ? "CLI" : "HTTP"}</span>
        <span className="badge" data-tone={badge.tone}><Icon name={badge.icon} size="sm" /> {badge.text}</span>
      </div>
      <dl className="kv settings-info">
        {p.cli && <CliSourceRow cli={p.cli} />}
        {cli && p.version && <><dt>{t.version}</dt><dd><Mono>{p.version}</Mono></dd></>}
        {cli && p.path && <><dt>{t.command}</dt><dd><Mono>{p.path}</Mono></dd></>}
        {p.cli && <CliDetailRows cli={p.cli} />}
        {!cli && p.baseUrl && <><dt>{t.address}</dt><dd><Mono>{p.baseUrl}</Mono></dd></>}
        {!cli && (
          <>
            <dt>{t.key}</dt>
            <dd>
              {p.keyEnv === null
                ? <span className="muted">{t.keyNotRequired}</span>
                : <>
                    <Mono>{p.keyEnv}</Mono>
                    {p.keySet
                      ? <span className="badge" data-tone="ok"><Icon name="i-check" size="sm" /> {t.keySet}</span>
                      : <span className="badge" data-tone="warn"><Icon name="i-alert" size="sm" /> {t.keyNotSet}</span>}
                  </>}
            </dd>
          </>
        )}
        {cli && <><dt>{t.billing}</dt><dd>{spends(t.spendsSubscription)}</dd></>}
        {paid && <><dt>{t.billing}</dt><dd>{spends(t.spendsPaid)}</dd></>}
      </dl>
      {p.warning !== null && (
        <div className="alert" data-tone="warn">
          <Icon name="i-alert" />
          <div>
            <div className="alert__title">{t.versionNewerTitle}</div>
            <div className="alert__text">{p.warning}</div>
          </div>
        </div>
      )}
      {!p.available && (keyMissing
        ? (
          <div className="alert" data-tone="warn">
            <Icon name="i-key" />
            <div>
              <div className="alert__title">{t.keyMissingTitle}</div>
              <div className="alert__text">{t.keyHelpBefore} <Mono>{p.keyEnv}</Mono> {t.keyHelpMiddle} <Mono>{envPath}</Mono> {t.keyHelpAfter}</div>
            </div>
          </div>
        )
        : (
          <div className="alert" data-tone="danger" role="alert">
            <Icon name="i-alert" />
            <div>
              <div className="alert__title">{t.providerUnavailable}</div>
              <div className="alert__text">{p.reason}</div>
            </div>
          </div>
        ))}
      {p.cli && <CliLines provider={p} cli={p.cli} ui={cliUi} />}
      {p.cli && <CliActions cli={p.cli} ui={cliUi} />}
      {models}
      {deleting ? (
        <div className="alert" data-tone="warn" role="alert">
          <Icon name="i-alert" />
          <div>
            <div className="alert__title">{t.deleteTitle(p.label)}</div>
            <div className="alert__text">{t.deleteText}</div>
          </div>
          <div className="alert__actions">
            <button type="button" className="btn btn--danger btn--sm" disabled={busy} onClick={onDelete}>{t.delete}</button>
            <button type="button" className="btn btn--sm" disabled={busy} onClick={onCancelDelete}>{t.cancel}</button>
          </div>
        </div>
      ) : test !== null ? test : (
        <div className="settings-actions">
          {p.available
            ? <button type="button" className="btn btn--sm" disabled={busy || !canTest} onClick={onTest}><Icon name="i-play" size="sm" /> {t.test}</button>
            : <button type="button" className="btn btn--sm" disabled={busy} onClick={onRecheck}><Icon name="i-refresh" size="sm" /> {t.recheck}</button>}
          {!cli && (
            <>
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onEdit}><Icon name="i-edit" size="sm" /> {t.edit}</button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={onAskDelete}><Icon name="i-trash" size="sm" /> {t.delete}</button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
