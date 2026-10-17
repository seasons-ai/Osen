import { ParticipantCallError } from "../participants/driver.ts";
import { providerMessages } from "../messages/providers.ts";
import type { CliAgent } from "./types.ts";

export type CliFailureKind = "not_found" | "not_logged_in" | "limit_exhausted" | "exit_code";
export interface CliFailure { kind: CliFailureKind; message: string; retryable: boolean; resetsAt?: string }

// Patterns ported from Widget (src/usage/exhaustion.ts) as they are. Order matters:
// "429 rate limit" — short limit (retry), "out of credits" — money, not a wait.
const AUTH = /\b(?:401|unauthori[sz]ed|not logged in|log ?in required|invalid api key|authentication failed|credentials?(?: (?:missing|expired|invalid))|session expired)\b|\brun\b[^.]*\blogin\b/i;
const FUNDS = /\b(?:402|payment required|out of credits?|insufficient (?:funds|credits?|balance|quota)|billing (?:is )?(?:not configured|required|disabled))\b/i;
const RATE = /\b(?:429|too many requests|rate[ _-]?limit(?:ed|ing)?)\b/i;
const QUOTA = /\b(?:usage limit|quota exceeded|limit exceeded|limit reached|usage cap|weekly limit|monthly limit)\b/i;
// Widget takes the time from a separate field; from text — minimal parsing by its real texts
// ("try again at 3:44 PM", "resets at 2026-01-01T01:00:00Z"), the string as is.
const RESET = /(?:try again at|resets? at)\s+(.+?)(?:\.(?:\s|$)|$)/im;

const loginHint = (agent: CliAgent): string => (agent === "claude" ? providerMessages().loginHintClaude : providerMessages().loginHintCodex);

export function classifyFailure(agent: CliAgent, input: {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: NodeJS.ErrnoException;
  text: string;
}): CliFailure {
  const { spawnError, text } = input;
  const m = providerMessages();
  if (spawnError) {
    if (spawnError.code === "ENOENT" || spawnError.code === "EACCES") {
      return { kind: "not_found", message: m.commandNotFound(input.command), retryable: false };
    }
    return { kind: "exit_code", message: m.spawnFailed(agent, spawnError.message), retryable: true };
  }
  if (AUTH.test(text)) {
    return {
      kind: "not_logged_in", retryable: false,
      message: m.notLoggedIn(agent, loginHint(agent)),
    };
  }
  if (FUNDS.test(text) || (!RATE.test(text) && QUOTA.test(text))) {
    const resetsAt = RESET.exec(text)?.[1]?.trim();
    return {
      kind: "limit_exhausted", retryable: false, ...(resetsAt ? { resetsAt } : {}),
      message: resetsAt
        ? m.limitWithReset(agent, resetsAt)
        : m.limitNoReset(agent),
    };
  }
  const tail = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-5).map((l) => l.slice(0, 300)).join(" | ");
  const how = input.exitCode === null ? m.exitSignal(String(input.signal)) : m.exitCode(input.exitCode);
  return { kind: "exit_code", retryable: true, message: m.exited(agent, how, tail) };
}

export function toCallError(failure: CliFailure): ParticipantCallError {
  return new ParticipantCallError("call_error", failure.message, failure.retryable);
}
