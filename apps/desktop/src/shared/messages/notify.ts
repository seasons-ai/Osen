import { defineMessages } from "@model-council/core/i18n";

// System notifications: session finish and owner attention. Both languages in one object.
export const notify = defineMessages({
  en: {
    finishConsensus: "Consensus reached",
    finishNoConsensus: "No consensus",
    finishStopped: "Discussion stopped",
    finishFailed: "Discussion failed",
    finishInterrupted: "Discussion interrupted",
    rounds: (n: number): string => `rounds: ${n}`,
    attentionQuestion: "Question for the owner",
    attentionPause: "The discussion is waiting for the owner",
    attentionBody: "Open the discussion in the app.",
  },
  ru: {
    finishConsensus: "Согласие достигнуто",
    finishNoConsensus: "Согласия нет",
    finishStopped: "Обсуждение остановлено",
    finishFailed: "Обсуждение сорвалось",
    finishInterrupted: "Обсуждение прервано",
    rounds: (n: number): string => `кругов: ${n}`,
    attentionQuestion: "Вопрос владельцу",
    attentionPause: "Обсуждение ждёт владельца",
    attentionBody: "Откройте обсуждение в приложении.",
  },
});
