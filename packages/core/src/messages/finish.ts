import { defineMessages } from "../i18n/catalog.ts";

// Completion reason with a code: written by the engine, and shown by code through finishReasonText.
export const finishMessages = defineMessages({
  en: { insufficientActive: "Fewer than two active participants remain." },
  ru: { insufficientActive: "Активных участников осталось меньше двух." },
});
