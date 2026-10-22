import { ROUNDS_BOUNDS } from "./setup.ts";
import type { Billing, RosterEntry } from "./setup.ts";
import { settings } from "./messages/settings.ts";

// "Settings" screen data: the contract between main and renderer. Key values are not included — only the variable name and a flag.

export type ModelsSource = "provider" | "owner" | "unconfirmed" | "unavailable";

export interface SettingsProvider {
  id: string;
  kind: "cli" | "openai-http";
  label: string;
  available: boolean;
  reason: string | null;        // reason for unavailability
  warning: string | null;       // cli: version newer than the verified range
  version: string | null;       // cli
  path: string | null;          // cli: executable file
  baseUrl: string | null;       // openai-http
  keyEnv: string | null;        // openai-http: key variable name; null — no key required
  keySet: boolean;              // meaningful when keyEnv !== null
  billing: Billing;
  models: string[];             // the shown list, without defaultModel
  defaultModel: string | null;  // the "default model" value; null — no such option
  modelsSource: ModelsSource;   // provider — received from the provider, owner — set by the owner in config.json
  modelsReason: string | null;  // explanation for unconfirmed and unavailable
  modelsAt: string | null;      // ISO time the list was received; only when modelsSource === "provider"
  cli: CliTransition | null;    // cli only: source, verified level and transition state; null for openai-http
}

// CLI transition (change 182). Computed in main; the renderer only shows it and calls the bridge actions.
export type CliSource = "explicit" | "pin" | "path"; // the same order as a turn launch: explicit path, then the active Osen pin, then PATH
export type CliLevel = "real" | "interface" | "none";
export type CliCheckOutcome = "ok" | "source_unavailable" | "install_failed" | "record_failed" | "no_base" | "check_failed";
export interface CliTransition {
  agent: "claude" | "codex";
  source: CliSource | null;     // null — the binary was not found
  level: CliLevel;              // verified level of the found version in the effective record
  checkedAt: string | null;     // YYYY-MM-DD of that record entry; null with level "none"
  pin: {                        // the active Osen pin from pins.json; also shown (as unused) when source === "explicit"
    version: string;
    activatedAt: string | null; // null — pins.json has no activatedAt: the age is unknown
    ageDays: number | null;     // whole days from activatedAt; null when unknown
    previous: string | null;    // version kept for rollback
  } | null;
  due: { from: string; to: string; ageDays: number; acceptedAt: string } | null; // planned transition reminder: pin older than the period and a newer `real` version exists
  target: { version: string; acceptedAt: string } | null;   // newest installed `real` version newer than the active pin: the "Switch to" button
  install: { version: string; command: string } | null;     // newest `real` version newer than the active pin and newer than target, not installed: the install command
  candidates: { version: string }[];                         // newer than the active pin, `interface` only in the record
  violations: { version: string; names: string[] }[];        // newer than the active pin, last check status `violates`: missing flags and features
  // last candidate check for this agent; null — none recorded. notSaved: this run's latest attempt could not be written to cli-reminder.json (file path and errno code); the next attempt in this run is not before 24 hours
  check: { at: string; outcome: CliCheckOutcome; notSaved?: { file: string; code: string } } | null;
}
export interface CliTransitionSettings {
  periodDays: number;           // planned transition period; 30 when the file is absent or broken
  fileError: string | null;     // the file is unreadable or fails the schema: the reason (localized at read time)
  running: boolean;             // at least one session is running: switch and rollback are unavailable
}

export const PERIOD_BOUNDS = { min: 1, max: 365 } as const;
export const DEFAULT_PERIOD_DAYS = 30;

/** null — valid; otherwise the reason with the bounds. */
export function checkPeriod(days: unknown): string | null {
  const { min, max } = PERIOD_BOUNDS;
  return typeof days === "number" && Number.isInteger(days) && days >= min && days <= max ? null : settings().intRange(min, max);
}

export interface DefaultsValues {
  maxRounds: number;
  turnTimeoutSec: number;
  contextChars: number;
  materialsChars: number;
  maxTotalTokens: number | null; // default session token cap; null — none
  maxParticipants: number;
  participants: RosterEntry[];
}

export interface SettingsView {
  configPath: string;
  envPath: string;
  registryError: string | null; // not null — the registry was not read: providers is empty, defaults === null
  providers: SettingsProvider[];
  defaults: DefaultsValues | null;
  transition: CliTransitionSettings;
}

export interface ProviderInput { id: string | null; label: string; baseUrl: string; apiKeyEnv: string } // id null — a new provider; apiKeyEnv "" — no key required

export type TestResult = { ok: true; ms: number } | { ok: false; reason: string };

export const DEFAULTS_BOUNDS = {
  maxRounds: ROUNDS_BOUNDS,
  turnTimeoutSec: { min: 10, max: 3600 },
  contextChars: { min: 1000, max: 1_000_000 },
  materialsChars: { min: 1000, max: 1_000_000 },
  maxParticipants: { min: 2, max: 8 },
} as const;

export interface ProviderInputErrors { label: string | null; baseUrl: string | null; apiKeyEnv: string | null }

export function checkProviderInput(input: ProviderInput): ProviderInputErrors {
  const url = input.baseUrl.trim();
  const env = input.apiKeyEnv.trim();
  const m = settings();
  return {
    label: input.label.trim() === "" ? m.labelRequired : null,
    baseUrl: URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol) ? null : m.baseUrlInvalid,
    apiKeyEnv: env === "" || /^[A-Z_][A-Z0-9_]*$/.test(env) ? null : m.keyEnvInvalid,
  };
}

export interface DefaultsErrors { maxRounds: string | null; turnTimeoutSec: string | null; contextChars: string | null; materialsChars: string | null; maxTotalTokens: string | null; maxParticipants: string | null; participants: string | null }

export function checkDefaults(values: DefaultsValues, providerIds: readonly string[]): DefaultsErrors {
  const m = settings();
  const num = (key: keyof typeof DEFAULTS_BOUNDS) => {
    const { min, max } = DEFAULTS_BOUNDS[key];
    const v = values[key];
    return Number.isInteger(v) && v >= min && v <= max ? null : m.intRange(min, max);
  };
  const list = values.participants;
  const unknown = list.find((p) => !providerIds.includes(p.providerId));
  const participants =
    list.length < 2 ? m.participantsMin
    : list.length > values.maxParticipants ? m.participantsOverMax(list.length, values.maxParticipants)
    : unknown ? m.providerUnknown(unknown.providerId)
    : list.some((p) => p.model.trim() === "") ? m.participantNoModel
    : null;
  return {
    maxRounds: num("maxRounds"),
    turnTimeoutSec: num("turnTimeoutSec"),
    contextChars: num("contextChars"),
    materialsChars: num("materialsChars"),
    maxTotalTokens: values.maxTotalTokens === null || (Number.isSafeInteger(values.maxTotalTokens) && values.maxTotalTokens >= 1) ? null : m.capInvalid,
    maxParticipants: num("maxParticipants"),
    participants,
  };
}

export const hasErrors = (errors: object): boolean => Object.values(errors).some((v) => v !== null);
