import { defineMessages } from "../i18n/catalog.ts";

// Texts of protocol schemas, continuation points and tariffs.json warnings. Field names and values are not translated.
export const protocolMessages = defineMessages({
  en: {
    blank: "string must not be blank",
    synthesizerNotListed: (id: string) => `synthesizer ${id} is not in the participant list`,
    participantIdAt: (pos: number, id: string) => `participant id at position ${pos} must be p${pos}, got ${id}`,
    noReplacement: (id: string) => `participant ${id} has no replacement: the replaces field is allowed only when resuming`,
    materialIdAt: (pos: number, id: string) => `material id at position ${pos} must be m${pos}, got ${id}`,
    solutionIffAmend: "field solution: not null if and only if stance is \"amend\"",
    replacementsRepeat: "replacements must not repeat the replaced participant or the new identifier",
    resumePointNoSession: "Cannot determine the resume point: the journal has no session_created",
    tariffsNotJson: (file: string) => `${file}: not JSON`,
    tariffsBadShape: (file: string) => `${file}: an object with a tariffs field holding an array of entries is expected`,
    tariffsEntryRejected: (file: string, n: number, problems: string) => `${file}: entry ${n} is not applied — ${problems}`,
    tariffsDuplicates: (file: string, ns: string, providerId: string, model: string) =>
      `${file}: entries ${ns} are not applied — duplicate pair ${providerId} / ${model}`,
    entryObject: "an object is expected",
    entryNonEmpty: "non-empty string",
    entrySource: "non-empty string up to 500 characters",
    entryDate: "date YYYY-MM-DD",
    entryCurrency: "three uppercase Latin letters",
    entryPrice: "finite number not less than 0",
    entryUnknownField: "unknown field",
  },
  ru: {
    blank: "строка не должна быть пустой",
    synthesizerNotListed: (id: string) => `синтезатор ${id} не входит в список участников`,
    participantIdAt: (pos: number, id: string) => `идентификатор участника на позиции ${pos} должен быть p${pos}, получен ${id}`,
    noReplacement: (id: string) => `у участника ${id} нет замены: поле replaces допустимо только при продолжении`,
    materialIdAt: (pos: number, id: string) => `идентификатор материала на позиции ${pos} должен быть m${pos}, получен ${id}`,
    solutionIffAmend: "поле solution: не null тогда и только тогда, когда stance равен \"amend\"",
    replacementsRepeat: "замены не должны повторять заменяемого участника или идентификатор нового",
    resumePointNoSession: "Нельзя определить точку продолжения: в журнале нет session_created",
    tariffsNotJson: (file: string) => `${file}: не JSON`,
    tariffsBadShape: (file: string) => `${file}: ожидается объект с полем tariffs — массивом записей`,
    tariffsEntryRejected: (file: string, n: number, problems: string) => `${file}: запись ${n} не применяется — ${problems}`,
    tariffsDuplicates: (file: string, ns: string, providerId: string, model: string) =>
      `${file}: записи ${ns} не применяются — повтор пары ${providerId} / ${model}`,
    entryObject: "ожидается объект",
    entryNonEmpty: "непустая строка",
    entrySource: "непустая строка до 500 знаков",
    entryDate: "дата ГГГГ-ММ-ДД",
    entryCurrency: "три заглавные латинские буквы",
    entryPrice: "конечное число не меньше 0",
    entryUnknownField: "неизвестное поле",
  },
});
