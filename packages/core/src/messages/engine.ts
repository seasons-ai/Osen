import { defineMessages } from "../i18n/catalog.ts";
import { plural } from "../i18n/format.ts";

const files = (n: number) => `${n} ${plural(n, { one: "file", other: "files" }, "en")}`;
const chars = (n: number) => `${n} ${plural(n, { one: "character", other: "characters" }, "en")}`;

// Texts of the engine's refusals and drop reasons: SessionInputError exceptions, drop reasons, the timeout message.
export const engineMessages = defineMessages({
  en: {
    topicRequired: "Topic is required.",
    tooFewParticipants: (n: number) => `At least 2 participants are required, got ${n}.`,
    tooManyParticipants: (max: number, n: number) => `No more than ${max} participants are allowed, got ${n}.`,
    folderTooLarge: (chars: number, limit: number) => `Folder: size of ${chars} ${plural(chars, { one: "character", other: "characters" }, "en")} exceeds the snapshot limit of ${limit}`,
    synthesizerOutside: (id: string, n: number) => `Synthesizer ${id} is not in the lineup: allowed are p1–p${n}.`,
    materialsMismatch: (why: string) => `Materials do not match the session: ${why}`,
    materialsCount: (meta: number, set: number) => `the session has ${meta} ${plural(meta, { one: "material", other: "materials" }, "en")}, ${set} given.`,
    materialDiffers: (pos: number) => `the material at position ${pos} differs from the one recorded in the session.`,
    workspaceMismatch: (why: string) => `Folder does not match the session: ${why}`,
    workspaceNone: (count: number) => `the session has no folder, ${files(count)} given.`,
    workspaceStats: (mFiles: number, mChars: number, sFiles: number, sChars: number) =>
      `the session has ${files(mFiles)} and ${chars(mChars)}, given ${files(sFiles)} and ${chars(sChars)}.`,
    noDriver: (id: string) => `No driver for participant ${id}.`,
    foreignJournal: "The journal to resume belongs to a different session.",
    noDraftText: (draftId: string) => `No text for draft ${draftId}.`,
    turnTimeoutTooLong: (max: number) => `limits.turnTimeoutSec must not exceed ${max}.`,
    turnTimeout: (sec: number) => `Turn timeout: ${sec} s.`,
    invariantNoVersion: "Invariant: turn without amend while there is no version",
    dropDraftCalls: "Three draft calls exhausted.",
    dropDraftCallsWith: (why: string) => `Three draft calls exhausted: ${why}`,
    dropTurnCallsWith: (why: string) => `Three turn calls exhausted: ${why}`,
    dropNonRetryable: (why: string) => `Non-retryable error: ${why}`,
    dropRetryFailed: (why: string) => `Retry failed: ${why}`,
    dropInvalidAfterCorrection: (why: string) => `Invalid response after the correction request: ${why}`,
  },
  ru: {
    topicRequired: "Тема обязательна.",
    tooFewParticipants: (n: number) => `Нужно не меньше 2 участников, получено ${n}.`,
    tooManyParticipants: (max: number, n: number) => `Участников не может быть больше ${max}, получено ${n}.`,
    folderTooLarge: (chars: number, limit: number) => `Папка: объём ${chars} знаков больше границы снимка ${limit}`,
    synthesizerOutside: (id: string, n: number) => `Синтезатор ${id} не входит в состав: допустимы p1–p${n}.`,
    materialsMismatch: (why: string) => `Материалы не соответствуют сессии: ${why}`,
    materialsCount: (meta: number, set: number) => `в сессии материалов ${meta}, передано ${set}.`,
    materialDiffers: (pos: number) => `материал на позиции ${pos} отличается от записанного в сессии.`,
    workspaceMismatch: (why: string) => `Папка не соответствует сессии: ${why}`,
    workspaceNone: (count: number) => `в сессии папки нет, передано файлов ${count}.`,
    workspaceStats: (mFiles: number, mChars: number, sFiles: number, sChars: number) =>
      `в сессии файлов ${mFiles} и знаков ${mChars}, передано файлов ${sFiles} и знаков ${sChars}.`,
    noDriver: (id: string) => `Нет драйвера для участника ${id}.`,
    foreignJournal: "Журнал для продолжения относится к другой сессии.",
    noDraftText: (draftId: string) => `Нет текста черновика ${draftId}.`,
    turnTimeoutTooLong: (max: number) => `limits.turnTimeoutSec не может быть больше ${max}.`,
    turnTimeout: (sec: number) => `Таймаут хода: ${sec} с.`,
    invariantNoVersion: "Инвариант: ход без amend при отсутствии версии",
    dropDraftCalls: "Исчерпаны три вызова черновика.",
    dropDraftCallsWith: (why: string) => `Исчерпаны три вызова черновика: ${why}`,
    dropTurnCallsWith: (why: string) => `Исчерпаны три вызова хода: ${why}`,
    dropNonRetryable: (why: string) => `Неповторяемая ошибка: ${why}`,
    dropRetryFailed: (why: string) => `Повторная попытка не удалась: ${why}`,
    dropInvalidAfterCorrection: (why: string) => `Невалидный ответ после запроса на исправление: ${why}`,
  },
});
