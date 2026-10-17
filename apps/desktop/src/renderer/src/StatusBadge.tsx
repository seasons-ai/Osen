import type { ReactNode } from "react";
import type { StoredStatus } from "@model-council/core";
import type { Language } from "@model-council/core/i18n";
import { session } from "../../shared/messages/session.ts";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";
import { useMessages } from "./language.tsx";

export const BADGES: Record<StoredStatus, { icon: IconName | null; tone: string }> = {
  running: { icon: null, tone: "accent" },
  consensus: { icon: "i-check", tone: "info" },
  no_consensus: { icon: "i-alert", tone: "warn" },
  stopped: { icon: "i-stop", tone: "muted" },
  interrupted: { icon: "i-alert", tone: "muted" },
  failed: { icon: "i-x", tone: "danger" }
};

const CAP_STOP = { icon: "i-coins", tone: "warn" } as const;

const text = (t: ReturnType<typeof session>, status: StoredStatus, tokenCap: boolean): string =>
  status === "stopped" && tokenCap ? t.statusCapStop
    : { running: t.statusRunning, consensus: t.statusConsensus, no_consensus: t.statusNoConsensus, stopped: t.statusStopped, interrupted: t.statusInterrupted, failed: t.statusFailed }[status];

export const statusText = (status: StoredStatus, tokenCap = false, language?: Language): string => text(session(language), status, tokenCap);

export function StatusBadge({ status, tokenCap = false }: { status: StoredStatus; tokenCap?: boolean }): ReactNode {
  const t = useMessages(session);
  const { icon, tone } = status === "stopped" && tokenCap ? CAP_STOP : BADGES[status];
  return (
    <span className="badge" data-tone={tone}>
      {icon ? <Icon name={icon} size="sm" /> : <span className="dots"><i /></span>}
      {text(t, status, tokenCap)}
    </span>
  );
}
