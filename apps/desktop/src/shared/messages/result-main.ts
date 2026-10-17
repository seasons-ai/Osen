import { defineMessages, plural } from "@model-council/core/i18n";

// Main process of the "Result" screen: the resume panel view (main/resume.ts), Markdown export (main/markdown.ts, main/export.ts).
// Topic, decision, arguments, messages, note, material names and reasons from the journal are not included: they go as recorded.
// Statuses, positions, failure kinds, "Owner", "N chars" come from session.ts, question statuses and "Name dropped: reason" — from session-feed.ts.
export const resultMain = defineMessages({
  en: {
    // Resume panel: replacement map check and unavailability
    replacementsNotArray: "Replacements must be an array.",
    replacementAt: (n: number): string => `Replacement ${n}`,
    replacementBadId: (at: string): string => `${at}: participantId must look like p1, p2…`,
    replacementNeedFields: (at: string, pid: string): string => `${at} (${pid}): non-empty providerId and model are required.`,
    replacementNoScenario: (at: string, pid: string, model: string): string => `${at} (${pid}): scenario “${model}” is not in the catalog.`,
    replacementScenarioPath: (at: string, pid: string, file: string): string => `${at} (${pid}): scenario “${file}” is given as a path, not as a name from the catalog.`,
    replacementNoProvider: (at: string, pid: string, providerId: string): string => `${at} (${pid}): provider “${providerId}” is not in the registry.`,
    scenarioUnavailable: (model: string): string => `scenario “${model}” is unavailable`,
    providerMissing: (providerId: string): string => `provider “${providerId}” is missing from the registry`,
    unavailable: "unavailable",

    // Export: file
    fallbackName: "discussion",
    saveFailed: (path: string, why: string): string => `Could not save the file ${path}: ${why}`,
    noCreation: "The session has no creation event",

    // Export: header and participants
    docTitle: "Osen: discussion",
    topic: "Topic",
    dateLine: (date: string): string => `- Date: ${date}`,
    statusLine: (status: string): string => `- Status: ${status}`,
    roundsLine: (round: number, max: number, turns: number): string => `- Rounds: ${round} of ${max}, turns: ${turns}`,
    participants: "Participants",
    participantLine: (n: number, name: string, model: string, role: string): string => `${n}. ${name} — ${model}, role: ${role}`,
    noRole: "none",
    tailReplacedBy: (n: number, name: string, dropReason: string | null): string => ` — replaced by participant p${n} “${name}”${dropReason === null ? "" : `; dropped out: ${dropReason}`}`,
    tailDropped: (reason: string): string => ` — dropped out: ${reason}`,
    tailReplaces: (id: string): string => ` — replaced ${id}`,
    materials: "Materials",
    materialsTotal: (n: number, chars: string): string => `Total: ${n} ${plural(n, { one: "material", other: "materials" }, "en")}, ${chars}`,

    // Export: decision, objections, owner's choice
    finalSolution: "Final solution",
    versionLine: (n: number, author: string, agreed: string): string => `Version ${n}, author: ${author}. Agree: ${agreed}.`,
    nobody: "nobody",
    noSolution: "No solution.",
    reason: (reason: string): string => `Reason: ${reason}`,
    objections: "Objections",
    noArgument: "no argument recorded",
    ownerChoice: "Owner's choice",
    choiceLine: (version: number, author: string | null, when: string, status: string): string =>
      `Version ${version}${author === null ? "" : `, author: ${author}`}. Chosen ${when}. Status at the time of the choice: ${status}. This is the owner's choice, not the models' consensus.`,
    note: (note: string): string => `Note: ${note}`,

    // Export: discussion progress
    discussionLog: "Discussion log",
    noTurns: "No turns.",
    failureLine: (turn: number, name: string, attempt: number, kind: string, message: string, retried: boolean): string =>
      `- Failure: turn ${turn} · ${name} · attempt ${attempt} — ${kind}: ${message}.${retried ? " Retried." : ""}`,
    ownerHead: (owner: string, id: string, afterTurn: number): string => `${owner} · ${id} · ${afterTurn ? `after turn ${afterTurn}` : "before the first turn"}`,
    turnHead: (turn: number, round: number, name: string, stance: string, version: number | null): string =>
      `Turn ${turn} · round ${round} · ${name} — ${stance}${version === null ? "" : ` (version ${version})`}`,
    versionHead: (n: number): string => `Version ${n}:`,
    draftHead: (n: number, name: string, attempts: number, chars: string): string => `Draft ${n} · ${name}${attempts > 1 ? ` · attempts: ${attempts}` : ""} · ${chars}`,
    draftFailureLine: (draftId: string, name: string, attempt: number, kind: string, message: string, retried: boolean): string =>
      `- Failure: draft ${draftId} · ${name} · attempt ${attempt} — ${kind}: ${message}.${retried ? " Retried." : ""}`,
    answerLine: (questionId: string, question: { from: string; text: string } | null, text: string): string =>
      `**Answer to ${questionId}**${question === null ? "" : ` (question from ${question.from}: “${question.text}”)`}: ${text}`,
    questionLine: (id: string, to: string, text: string, status: string): string => `**Question ${id} → ${to}:** ${text} (${status})`,
  },
  ru: {
    replacementsNotArray: "Замены должны быть массивом.",
    replacementAt: (n: number): string => `Замена ${n}`,
    replacementBadId: (at: string): string => `${at}: participantId должен быть вида p1, p2…`,
    replacementNeedFields: (at: string, pid: string): string => `${at} (${pid}): нужны непустые providerId и model.`,
    replacementNoScenario: (at: string, pid: string, model: string): string => `${at} (${pid}): сценария «${model}» нет в каталоге.`,
    replacementScenarioPath: (at: string, pid: string, file: string): string => `${at} (${pid}): сценарий «${file}» задан путём, а не именем из каталога.`,
    replacementNoProvider: (at: string, pid: string, providerId: string): string => `${at} (${pid}): провайдера «${providerId}» нет в реестре.`,
    scenarioUnavailable: (model: string): string => `сценарий «${model}» недоступен`,
    providerMissing: (providerId: string): string => `провайдер «${providerId}» отсутствует в реестре`,
    unavailable: "недоступен",

    fallbackName: "обсуждение",
    saveFailed: (path: string, why: string): string => `Не удалось сохранить файл ${path}: ${why}`,
    noCreation: "Сессия не содержит события создания",

    docTitle: "Osen: обсуждение",
    topic: "Тема",
    dateLine: (date: string): string => `- Дата: ${date}`,
    statusLine: (status: string): string => `- Статус: ${status}`,
    roundsLine: (round: number, max: number, turns: number): string => `- Кругов: ${round} из ${max}, ходов: ${turns}`,
    participants: "Участники",
    participantLine: (n: number, name: string, model: string, role: string): string => `${n}. ${name} — ${model}, роль: ${role}`,
    noRole: "без роли",
    tailReplacedBy: (n: number, name: string, dropReason: string | null): string => ` — заменён участником p${n} «${name}»${dropReason === null ? "" : `; выбыл: ${dropReason}`}`,
    tailDropped: (reason: string): string => ` — выбыл: ${reason}`,
    tailReplaces: (id: string): string => ` — заменил ${id}`,
    materials: "Материалы",
    materialsTotal: (n: number, chars: string): string => `Всего: ${n} ${plural(n, { one: "материал", few: "материала", many: "материалов", other: "материала" }, "ru")}, ${chars}`,

    finalSolution: "Итоговое решение",
    versionLine: (n: number, author: string, agreed: string): string => `Версия ${n}, автор: ${author}. Согласны: ${agreed}.`,
    nobody: "никто",
    noSolution: "Решения нет.",
    reason: (reason: string): string => `Причина: ${reason}`,
    objections: "Возражения",
    noArgument: "аргумент не записан",
    ownerChoice: "Выбор владельца",
    choiceLine: (version: number, author: string | null, when: string, status: string): string =>
      `Версия ${version}${author === null ? "" : `, автор: ${author}`}. Выбрана ${when}. Статус на момент выбора: ${status}. Это выбор владельца, а не согласие моделей.`,
    note: (note: string): string => `Заметка: ${note}`,

    discussionLog: "Ход обсуждения",
    noTurns: "Ходов нет.",
    failureLine: (turn: number, name: string, attempt: number, kind: string, message: string, retried: boolean): string =>
      `- Сбой: ход ${turn} · ${name} · попытка ${attempt} — ${kind}: ${message}.${retried ? " Повтор." : ""}`,
    ownerHead: (owner: string, id: string, afterTurn: number): string => `${owner} · ${id} · ${afterTurn ? `после хода ${afterTurn}` : "до первого хода"}`,
    turnHead: (turn: number, round: number, name: string, stance: string, version: number | null): string =>
      `Ход ${turn} · круг ${round} · ${name} — ${stance}${version === null ? "" : ` (версия ${version})`}`,
    versionHead: (n: number): string => `Версия ${n}:`,
    draftHead: (n: number, name: string, attempts: number, chars: string): string => `Черновик ${n} · ${name}${attempts > 1 ? ` · попыток: ${attempts}` : ""} · ${chars}`,
    draftFailureLine: (draftId: string, name: string, attempt: number, kind: string, message: string, retried: boolean): string =>
      `- Сбой: черновик ${draftId} · ${name} · попытка ${attempt} — ${kind}: ${message}.${retried ? " Повтор." : ""}`,
    answerLine: (questionId: string, question: { from: string; text: string } | null, text: string): string =>
      `**Ответ на ${questionId}**${question === null ? "" : ` (вопрос от ${question.from}: «${question.text}»)`}: ${text}`,
    questionLine: (id: string, to: string, text: string, status: string): string => `**Вопрос ${id} → ${to}:** ${text} (${status})`,
  },
});
