import type { ReactNode } from "react";
import type { SettingsProvider } from "../../shared/settings.ts";
import { formatDate } from "@model-council/core/i18n";
import { settings } from "../../shared/messages/settings.ts";
import { Icon } from "./icons.tsx";
import { useMessages } from "./language.tsx";

const dayKey = (d: Date) => d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();

/** The list after a manual addition: the whole shown list plus the new model. null — nothing to add. */
export function modelsAfterAdd(provider: SettingsProvider, draft: string): string[] | null {
  const name = draft.trim();
  if (name === "" || name === provider.defaultModel || provider.models.includes(name)) return null;
  return [...provider.models, name];
}

export function modelsAfterRemove(provider: SettingsProvider, model: string): string[] {
  return provider.models.filter((m) => m !== model);
}

export function modelsSourceText(provider: SettingsProvider, now: Date): string {
  const m = settings();
  switch (provider.modelsSource) {
    case "provider": {
      if (provider.modelsAt === null) return m.modelsFromProvider;
      const d = new Date(provider.modelsAt);
      const time = formatDate(d, { timeStyle: "short" });
      return dayKey(d) === dayKey(now)
        ? m.modelsReceivedToday(time)
        : m.modelsReceivedOn(formatDate(d, { day: "numeric", month: "long" }), time);
    }
    case "owner": return m.modelsOwner;
    case "unconfirmed": return m.modelsUnconfirmed(provider.modelsReason);
    case "unavailable": return provider.modelsReason ?? m.modelsUnavailable;
  }
}

export function ProviderModels({ provider, now, draft, busy, onDraft, onAdd, onRemove, onRefresh, onReset }: {
  provider: SettingsProvider;
  now: Date;
  draft: string;
  busy: boolean;
  onDraft(value: string): void;
  onAdd(): void;
  onRemove(model: string): void;
  onRefresh(): void;
  onReset(): void;
}): ReactNode {
  const t = useMessages(settings);
  const owner = provider.modelsSource === "owner";
  return (
    <>
      {provider.models.length > 0 && (
        <div className="settings-models">
          {provider.models.map((m) => (
            <span key={m} className="tag">
              {m}
              {owner && (
                <button type="button" className="settings-chip__x" aria-label={t.removeModel(m)} onClick={() => onRemove(m)}>
                  <Icon name="i-x" size="sm" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="settings-models">
        <span className="settings-models__source">{modelsSourceText(provider, now)}</span>
        <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={owner ? onReset : onRefresh}>
          <Icon name="i-refresh" size="sm" /> {busy ? t.refreshing : owner ? t.resetModels : t.refreshModels}
        </button>
      </div>
      <div className="settings-add">
        <input className="input" aria-label={t.manualModelLabel} placeholder={t.modelNamePlaceholder} value={draft} onChange={(e) => onDraft(e.target.value)} />
        <button type="button" className="btn btn--sm" disabled={busy || modelsAfterAdd(provider, draft) === null} onClick={onAdd}>
          <Icon name="i-plus" size="sm" /> {t.addModel}
        </button>
      </div>
    </>
  );
}
