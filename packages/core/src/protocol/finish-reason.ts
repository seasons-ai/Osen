import { getProcessLanguage } from "../i18n/process-language.ts";
import type { Language } from "../i18n/language.ts";
import { finishMessages } from "../messages/finish.ts";
import { INSUFFICIENT_ACTIVE_REASON_CODE } from "./schema.ts";

// Completion reason for display: a known code gives the catalog text in the requested language, otherwise the record as is.
// The choice is made only by code; the reason text is not compared.
export function finishReasonText(finish: { reason: string | null; reasonCode: string | null }, language: Language = getProcessLanguage()): string | null {
  if (finish.reasonCode === INSUFFICIENT_ACTIVE_REASON_CODE) return finishMessages(language).insufficientActive;
  return finish.reason;
}
