import { finishReasonText, tokenUsage } from "@model-council/core/protocol";
import type { DRAFT_CONTEXT_LIMIT_REASON, SYNTHESIZER_UNAVAILABLE_REASON, SessionState, TOKEN_CAP_REASON } from "@model-council/core/protocol";
import type { Language } from "@model-council/core/i18n";
import { session } from "./messages/session.ts";
import { feed } from "./messages/session-feed.ts";

const TOKEN_CAP: typeof TOKEN_CAP_REASON = "token_cap";
const NO_SYNTHESIZER: typeof SYNTHESIZER_UNAVAILABLE_REASON = "synthesizer_unavailable";
const DRAFTS_TOO_LONG: typeof DRAFT_CONTEXT_LIMIT_REASON = "draft_context_limit";

/** Session finish reason in words for "Result" and export; without a finish — null. The code does not leak out. */
export function finishReasonView(state: SessionState, language?: Language): string | null {
  const { finish } = state;
  if (!finish) return null;
  const m = session(language);
  if (finish.reason === TOKEN_CAP) return feed(language).capText(tokenUsage(state).total, state.session?.limits.maxTotalTokens ?? null);
  if (finish.reason === NO_SYNTHESIZER) {
    const id = state.session?.drafts?.synthesizerId ?? "";
    return m.failNoSynthesizer(state.session?.participants.find((p) => p.id === id)?.name ?? id);
  }
  if (finish.reason === DRAFTS_TOO_LONG) return m.failDraftsTooLong;
  return finishReasonText(finish, language);
}
