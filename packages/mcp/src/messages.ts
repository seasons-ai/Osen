import { defineMessages, materialsMessages } from "@model-council/core";
import type { StoredStatus } from "@model-council/core";

// MCP server texts for the agent and the owner in the process language: instructions, descriptions of tools and fields,
// refusals, explanations and hints in responses. Tool and field names, error codes, status and
// enum values do not depend on the language. Log lines (logger.*) are always English and are not part of this.
export const mcpMessages = defineMessages({
  en: {
    // server instructions
    instrIntro: "The server runs a discussion between several models on the owner's topic until they reach a shared decision. Rules for the agent:",
    instr1: "1. Take templates, providers, models and defaults from council_options; do not invent identifiers. Participants are values from the response, not files: do not search the disk.",
    instr2: "2. Before council_start, tell the owner the topic, the participants, the round limit and the upper bound on the number of model calls (participants × rounds × 3; with independent drafts — participants × (rounds + 1) × 3). If at least one participant consumes a subscription or money (providers of kind cli and openai-http), wait for the owner's consent; if refused, do not start. Consent is not needed when the owner named the participants and allowed the start in the same request, or when all participants are scripted, but the message before the start is always needed.",
    instr3: "3. Pass the topic in the owner's words; add nothing of your own.",
    instr4: "4. After the start, wait for the result with council_status calls with waitSec up to 50 and do not write to the owner on every turn.",
    instr5: "5. The result exists only as the council_status response: give the status and the decision as the server returned them. If there is no consensus, or the session was stopped, interrupted or failed, say so plainly and do not present the last version as an agreed decision. Do not replace the discussion with your own answer on behalf of several models. If the response contains ownerSelection, it is the owner's choice made in the app: give it separately from the status and do not call it the models' consensus.",
    instr6: "6. Pass the owner's files and folders in attachments of council_start: only those the owner named or clearly meant, add nothing yourself; absolute paths only. Materials go into every call of every participant and increase the spend: in the message before the start, tell the owner the number of materials and their size in characters (the limit is defaults.materialsChars from council_options), and after the start the exact numbers from the response (materials). A folder can be attached even when it is larger than the limit: only the initial set within the limit goes into each call, and the participants read the remaining files on request from the folder snapshot (the participants still have no tools and no disk access) — tell the owner this in the message before the start. After the start, tell the owner the snapshot size (folder) and the number of files that did not fit (materials.left.count) from the response; the files the participants have read are visible in council_status (filesRead). Do not paste file text into the topic.",
    instr7: "7. Waiting for the owner is enabled only explicitly by council_start fields: pauseAfterRound (a pause after every round without a result), waitForOwner (wait for an answer to a question to the owner), ownerWaitSec (the time limit in seconds, 300 by default, at most 86400). Without these fields the session does not wait. The wait is finite: when the time limit passes, the discussion continues by itself. While the session waits, council_status returns waiting (waitId, reasons, questions, deadline) and ownerQuestions — the open questions to the owner: show the owner the questions and the deadline.",
    instr8: "8. Call council_say (the owner's message, or an answer to a question by questionId) and council_continue (release the wait by waitId) only at the owner's request and in the owner's words. Do not answer a question to the owner yourself and do not release the wait on your own initiative. Both tools return the requestId of the accepted request, not a confirmation that it was applied: read the application in council_status. council_continue does not start a new session and does not add rounds, but the previous executor will keep calling models within the limits already agreed — tell the owner this before the call.",
    instr9: "9. Resume a session with the status interrupted, no_consensus, stopped or consensus with council_resume, only at the owner's request. First call it without execute: that is a plan, it writes nothing and does not call models. Tell the owner the topic, the participants, the number of rounds and the exact upper bound on calls from the plan (maxCalls: active participants × rounds × 3 plus the remaining calls of unfinished independent drafts, draftCalls). If requiresConsent is true — there are participants consuming a subscription or money — wait for the owner's consent to this bound; if refused, do not start. Then repeat the call with the same parameters, execute=true and the planToken from the plan. The stale_plan error means that the session or the parameters have changed: get a new plan, name it to the owner again and get consent. The server cannot verify the owner's consent: planToken only confirms that the plan is unchanged, you are responsible for the consent. A session with the status failed is resumed only if the failure is “fewer than two active participants” (reasonCode insufficient_active_participants in council_status) and the replacements bring back at least two active ones; sessions with the status running and failed for another reason are not resumed. A session with the status consensus is resumed only with message — the owner's reply in the owner's own words, passed only at the owner's request and never composed by you; without it the server refuses (consensus); with it all agreements are reset (agreementReset), and the text is part of planToken: a different text gives stale_plan, a new plan and new consent. The roster is saved and is changed ONLY through replacements: each replacement names the dropped or unavailable participant (participantId) and the provider with the model (providerId, model) that replace it. The owner names the replacement: do not choose the provider and the model yourself, take the values from council_options, nobody is substituted by default. Before execute, tell the owner each replacement (old → new) and that all agreements are reset and every active participant must agree again. A change in replacements, participant availability, the journal or the budget gives stale_plan: a new plan and new consent. The replacement error means the replacement was rejected. A response with accepted comes before the result: read the progress in council_status by the same sessionId.",
    instr10: "10. Named lineups are the lineups field in council_options: participants saved by the owner with models, roles and order. Start by lineup is council_start with lineupId and without participants; both fields together are an error. Before the start, tell the owner the lineup's participants (provider, model, role) in the same way as for an ordinary start and wait for consent under the conditions of rule 2. Do not start a lineup with available: false and do not replace its participants with your own: tell the owner the reason (reason). Pass the model notes (modelNote in council_options, lineup.notes in the council_start response) to the owner. A lineup cannot be saved through MCP: the owner saves it with the council lineups save command or in the app. If the response contains lineupsError, the lineups file is corrupted: tell the owner, the other ways to start still work.",
    instr11: "11. Independent drafts (drafts in council_start) are an experimental mode, off by default. Set drafts: true only when the owner directly asks for independent drafts. Before the start, tell the owner the synthesizer (synthesizerId; if not chosen, the first participant) and the call bound participants × (rounds + 1) × 3. The drafts in council_status (drafts) are not a decision and not the models' consensus: give them only as intermediate variants; the result is still only status and solution.",
    instrOwnerLanguage: "Reply to the owner in the owner's language, whatever the language of these instructions and of the server texts.",

    // common
    scriptedLabel: "Scripted",
    scenarioUnavailable: (model: string) => `Scenario “${model}” is unavailable.`,
    sessionNotFound: (id: string) => `Session ${id} was not found.`,

    // council_options
    optionsDesc: "Returns the discussion templates, the providers with their availability and models, the defaults for council_start, and the owner's named lineups (lineups) with the availability of each position. It starts nothing and spends nothing.",
    optionsProviderUnavailable: "The provider is unavailable",
    optionsProviderNotInspected: "The provider was not inspected",
    optionsNoScenarios: "No scenario files found",

    // council_say / council_continue
    sayDesc:
      "Passes the owner's message, or the owner's answer to a participant's question (questionId is an identifier from ownerQuestions in council_status), into a running session. It also works for sessions started from the app or the terminal. " +
      "Call it only at the owner's request and in the owner's words: do not answer for the owner yourself. " +
      "Returns the requestId of the accepted request — it is a queue, not a confirmation that it was applied: the applied messages are visible in council_status (ownerMessages). " +
      "The message resets the agreements; it does not release the owner wait itself, except the wait for the answer to this question.",
    fSessionId: "Session identifier",
    sayFText: "The text of the message or answer, in the owner's words",
    sayFQuestionId: "Identifier of an open question to the owner (ownerQuestions[].id); not given — an ordinary message",
    sayParticipant: "A discussion participant cannot speak for the owner.",
    sayNext: "The request is queued for the executor; this is not yet the application. Check the application in council_status: the message will appear in ownerMessages with this requestId, and the answered question will disappear from ownerQuestions.",
    continueDesc:
      "Releases the current owner wait of a running session (waitId is from waiting in council_status), including a session started from the app or the terminal. Call it only at the owner's request. " +
      "No new session is created and no rounds are added: the previous executor will continue the discussion within the limits already agreed, so further model calls are possible — tell the owner about it. " +
      "Returns the requestId of the accepted request, not a confirmation: the release is visible in council_status (waiting becomes null or changes its waitId).",
    continueFWaitId: "Identifier of the current wait: waiting.waitId from council_status",
    continueParticipant: "A discussion participant cannot release the owner's wait.",
    continueNeedWaitId: "The waitId of the current wait is required: take it from waiting in the council_status response.",
    continueNext: "The request to release the wait is queued for the executor. The previous executor will continue the discussion within the previous limits: new model calls are possible. Check the release in council_status: waiting becomes null or changes its waitId.",

    // council_status / council_stop
    statusText: (s: StoredStatus) => ({
      consensus: "consensus reached", no_consensus: "no consensus", stopped: "stopped",
      failed: "failure", interrupted: "interrupted", running: "running",
    })[s],
    statusRunningWaiting: "running, waiting for the owner",
    statusDrafting: (accepted: number, total: number) => `independent drafts in progress: ${accepted} of ${total} accepted`,
    journalUndefined: (note: string) => `state undefined: ${note}; update the app to read the whole session`,
    reasonSynthesizer: (id: string) => `synthesizer ${id} dropped out without creating version 1; there is no replacement — a new session with a different synthesizer is needed`,
    reasonSynthesizerBare: "synthesizer dropped out without creating version 1; there is no replacement — a new session with a different synthesizer is needed",
    reasonInsufficient: "fewer than two active participants remain; the session can be resumed by replacing the dropped participant through council_resume (replacements)",
    reasonDraftContext: "the drafts do not fit the context limit; the general discussion has not started",
    statusDesc:
      "Returns the session state: status, round, who agrees, the current version of the decision, the names and total size of the session materials (without texts), the effective token cap and the total tokens; after completion — the result, the objectors with their arguments and the statistics. " +
      "ownerQuestions are the open questions of participants to the owner (identifier, author, text, turn number): show them to the owner, do not answer yourself; the answer is passed through council_say with questionId. waiting is the current owner wait (waitId, reasons round_boundary or owner_question, held questions, deadline) or null: the wait is finite, after the deadline the discussion continues by itself; for an interrupted session the saved waiting is given separately from the status. ownerMessages are the owner's messages already applied (requestId, turn number, answered questions) without texts. " +
      "journal is null when the session journal was read in full, otherwise { reason: newer_version | corrupted, lastEvent }: with newer_version the journal was written by a newer version of the app, the session status is undefined, the owner needs to update the app, and such a session must not be called interrupted. " +
      "If the owner accepted a version in the app, the response contains ownerSelection (the version number and text, the note, the time, the status at the moment of the choice): it is a separate choice of the owner, not the models' consensus — status, solution and objectors remain the original result of the discussion. " +
      "If independent drafts are enabled (experimental), drafts is the phase, the synthesizer and the accepted drafts: they are intermediate variants, not a decision and not consensus, and solution and agreed are not replaced by them. If a folder is attached to the session, the response contains folder — the number of files and the size of its snapshot (otherwise null) — and filesRead — the snapshot files read by the participants in completed turns (turn, participant, name, size, characters shown), without texts. " +
      "With waitSec it waits for a change and responds earlier as soon as a new turn has finished, an owner's message or answer has been applied, the questions or the wait have changed, or the session has ended.",
    statusFWaitSec: (cap: number) => `How many seconds to wait for a change (a new completed turn, an applied owner message, a change in the questions or the wait, the end of the session); at most ${cap}`,
    waitSecInvalid: "waitSec must be a finite number not less than 0.",
    stopDesc: "Stops a running session, including one started from the app or the terminal, and returns its final state.",
    stopFinished: (statusText: string) => `The session has already finished: ${statusText}.`,
    stopNotDone: (statusText: string) => `The stop was not carried out: ${statusText}.`,
    stopInterrupted: "The session is interrupted: its executor is not running.",
    stopRequestedPending: "The stop was requested, the session is still finishing; check council_status.",
    stopDone: "The session was stopped.",

    // council_start
    startDesc:
      "Starts a discussion between several models on a topic and immediately returns sessionId; the session runs in the background in its own process: closing the agent does not interrupt it, stop it with council_stop; the state and the result are read through council_status. " +
      "The start spends the owner's subscriptions or money and is done only with the owner's consent. The valid templates, providers and models are in council_options. " +
      "Before the call, you must write to the owner in a separate message the topic, the participants, the round limit and the upper bound on the number of model calls (participants × rounds × 3; with independent drafts — participants × (rounds + 1) × 3), even when consent is not required." +
      " The owner's files and folders are passed in attachments: only those named by the owner or clearly meant, only by absolute paths; in the message before the start, tell the number of materials and their size — they go into every call and increase the spend." +
      " A folder is accepted even when it is larger than the materials limit: only the initial set (materials) goes into each call, the participants read the remaining files on request from the folder snapshot — after the start, tell the owner the snapshot size (folder) and the number of files that did not fit (materials.left.count)." +
      " The spend cap is set in maxTotalTokens (tokens, not money): the session stops by itself when the sum of tokens reaches it." +
      " Waiting for the owner is enabled only explicitly: pauseAfterRound (a pause after every round without a result) and waitForOwner (wait for an answer to a question to the owner), the time limit is ownerWaitSec. Without these fields the session does not wait. The wait is finite: after the time limit the discussion continues by itself; earlier it is released by the owner's answer (council_say) or council_continue — only at the owner's request." +
      " Start by a named lineup: the lineupId field from council_options instead of participants; the participants, models, roles and order are taken from the lineup without substitution; before the call, the lineup's participants are named to the owner in the same way as for an ordinary start." +
      " The experimental phase of independent drafts: drafts=true (off by default, enabled only at the owner's request) — first each participant writes a draft without seeing the others', then the discussion is started by the synthesizer (synthesizerId, p1 by default); synthesizerId without drafts=true is an error.",
    startFTopic: "The discussion topic",
    startFTemplateId: "Template identifier from council_options; not given — the neutral framing",
    startFProviderId: "Provider identifier from council_options",
    startFModel: "The model; not given — the default model (only for providers of kind cli)",
    startFParticipants: "Participants in turn order, at least two; not given — the default participants",
    startFMaxRounds: (min: number, max: number) => `The round limit, from ${min} to ${max}; not given — from the template, otherwise the default`,
    startFMaxTotalTokens: "The cap on the session's total tokens (input plus output), an integer of at least 1: the sum covers all model calls of the session that reported tokens, including failed attempts, file requests and drafts; when it reaches the cap, the session stops with the status stopped and the reason token_cap. The check is made between turns, so the cap can be exceeded by one turn. Not given — the value from council_options (defaults.maxTotalTokens), and if there is none — there is no cap",
    startFPauseAfterRound: "A pause after every round without a result: the session waits for the owner until council_continue or until ownerWaitSec expires. Off by default",
    startFWaitForOwner: "Wait for the owner's answer to a participant's question before the nearest next turn — until the answer (council_say with questionId), council_continue or the ownerWaitSec expiry. Off by default",
    startFOwnerWaitSec: (max: number, def: number) => `The owner wait time limit in seconds, an integer from 1 to ${max}; when it expires the discussion continues by itself. Set only together with pauseAfterRound or waitForOwner; not given — ${def}`,
    startFLineupId: "Identifier of a named lineup from council_options (lineups): the participants, models, roles and order are taken from the lineup; not given together with participants",
    startFDrafts: "Independent drafts (experiment): before the discussion each participant writes a draft without seeing the others'; all accepted drafts then go into every ordinary request. Off by default; enable only at the owner's request",
    startFSynthesizerId: "Identifier of the synthesizer (p1, p2, …) — the participant who makes the first ordinary turn after the drafts; only together with drafts=true; not given — p1",
    startFAttachments: (snapshotChars: number) => `Absolute paths to files and folders that the owner named or clearly meant; a relative path is an error. Accepted formats: ${materialsMessages("en").supportedFormats}. A file of another format is refused when named explicitly and skipped inside a folder, with a reason naming its kind (for example audio, video, an archive other than ZIP, a program). The limit of the initial set is defaults.materialsChars from council_options: explicitly named files must fit into it, from a folder larger than the limit the descriptions are taken (no descriptions — the files closest to the root), and the rest of its files are kept in the snapshot (the snapshot limit is ${snapshotChars} characters). Environment files (.env) are not accepted`,
    startParticipant: "A discussion participant cannot convene a discussion.",
    startLineupAndParticipants: "The lineupId and participants fields are incompatible: specify only one.",
    startRoundsBounds: (min: number, max: number) => `The round limit must be from ${min} to ${max}.`,
    startTokenCap: "The token cap (maxTotalTokens) must be an integer of at least 1.",
    startSynthesizerNeedsDrafts: "synthesizerId works only together with drafts: true.",
    startOwnerWaitRange: (max: number) => `The owner wait time limit (ownerWaitSec) must be an integer from 1 to ${max}.`,
    startOwnerWaitNeedsWait: "ownerWaitSec is set only together with pauseAfterRound or waitForOwner.",
    startRelativePaths: (names: string[]) => `Paths in attachments must be absolute: ${names.map((a) => `“${a}”`).join(", ")}. The server's working folder does not match the owner's project.`,
    startLineupNotFound: (id: string) => `Lineup “${id}” was not found: the list of lineups is in council_options.`,
    startLineupUnavailable: (name: string) => `Lineup “${name}” is unavailable:`,
    startLineupNote: (position: number, providerId: string, model: string, note: string) => `Position ${position} (${providerId}:${model}): ${note}`,
    startNoProviders: "There are no participants to take: the registry has no providers. Specify participants or describe a provider in config.json.",
    startScriptedNeedsModel: "A scripted participant needs a scenario in the model field.",
    startProviderNotFound: (id: string, known: string[]) => `Provider “${id}” was not found in the registry; available: ${known.join(", ") || "no providers"}.`,
    startProviderNeedsModel: (id: string) => `Provider “${id}” needs a model.`,
    startProviderUnavailable: (label: string, reason: string | null | undefined) => `Provider “${label}” is unavailable: ${reason ?? "reason unknown"}`,
    startExecutorFailed: (reason: string) => `The session executor did not start: ${reason}`,
    startExecutorTimeout: (sec: number) => `The executor did not respond in ${sec} s.`,
    startNext: (hasMaterials: boolean, hasFolder: boolean) => `If you have not yet told the owner the participants, the round limit and the upper bound on calls (maxCalls)${hasMaterials ? " and the number and size of the materials (materials)" : ""}${hasFolder ? " and the folder snapshot size (folder) and the number of files that did not fit into the initial set (materials.left.count)" : ""}, say it now in one line. Then call council_status with this sessionId and waitSec up to 50, without messages on every turn; the result is taken only from its response.`,
    startNextLineupNotes: " Pass the lineup's model notes (lineup.notes) to the owner.",
    startNextDrafts: (synthesizerId: string, synthesizerName: string, byDefault: boolean, bound: number) => ` Independent drafts are enabled (experiment): first each participant writes a draft without seeing the others', then the ordinary discussion is started by the synthesizer ${synthesizerId} (${synthesizerName})${byDefault ? ", chosen by default" : ""}; tell the owner the synthesizer and the call bound ${bound} (participants × (rounds + 1) × 3).`,
    startNextOwnerWait: (sec: number) => ` Owner wait is enabled (time limit ${sec} s, then the discussion continues by itself): when waiting or ownerQuestions appear in council_status, show them to the owner; council_say and council_continue — only at the owner's request.`,

    // council_resume
    resumeDesc:
      "Resumes a saved session with the status interrupted, no_consensus or stopped in the same journal, with the same sessionId and the saved roster of participants. " +
      "A session with the status failed is resumed only when the failure is “fewer than two active participants” (reasonCode insufficient_active_participants in council_status) and the replacements bring back at least two active ones. " +
      "The roster is changed only through replacements: each replacement names the dropped or unavailable participant and the provider with the model that replace it; the owner names the replacement, do not choose the provider and the model yourself, take the values from council_options; nobody is substituted by default. The new participant gets the next identifier, the place and the role of the previous one; the previous one stays in the history; all agreements are reset. " +
      "The start (execute=true) spends the owner's subscriptions or money: model calls go within maxCalls. " +
      "Without execute it is a plan: it writes nothing and does not call models, and returns the roster, the number of rounds, the exact upper bound on calls maxCalls (active × rounds × 3 plus the remaining calls of unfinished independent drafts, draftCalls), requiresConsent and planToken. " +
      "Before execute, tell the owner the topic, the participants, the rounds and the exact bound maxCalls, each replacement (old → new) and that all agreements are reset, and, when requiresConsent is true, get the owner's consent; then repeat the call with the same parameters, execute=true and the planToken from the plan. " +
      "The stale_plan error means that the session, the replacements, the participant availability or the parameters changed after the plan: a new plan and new consent of the owner are needed. " +
      "A session with the status consensus is resumed only with message: the owner's own reply in the owner's own words, passed only at the owner's request; without it the server refuses (consensus), with it all agreements are reset (agreementReset) and the text is part of planToken (a different text — stale_plan). Sessions with the status running and failed for another reason are not resumed. The replacement error means the replacement was rejected (a repeat, an unknown or already replaced id, an available participant, an unavailable new one). " +
      "Like a council_start session, a resumed session runs in the background in its own process: closing the agent does not interrupt it, stop it with council_stop. The execute response comes before the result of the discussion: read the progress in council_status by the same sessionId. Only at the owner's request.",
    resumeFRounds: (min: number, max: number) => `How many more rounds to run, an integer from ${min} to ${max}; not given — the remainder of the previous limit`,
    resumeFMaxTotalTokens: "The new cap on the total tokens, an integer of at least 1; null — remove the cap; not given — the previous one",
    resumeFExecute: "true — start the resumption; false by default (plan only)",
    resumeFPlanToken: "The token from the plan; required with execute=true",
    resumeFMessage: "The owner's message in the owner's own words; required to resume a consensus session, passed only at the owner's request, never composed by the agent; all agreements are reset; the text is part of planToken",
    resumeConsensusHint: " A consensus session is resumed only with message — the owner's own words, at the owner's request.",
    resumeFReplacements: "Replacements of dropped or unavailable participants: whom (participantId) and by whom (providerId, model from council_options); the new participant gets the next identifier, the place and the role of the previous one; all agreements are reset",
    resumeParticipant: "A discussion participant cannot resume a discussion.",
    resumeBadRounds: (min: number, max: number) => `The number of additional rounds (rounds) must be an integer from ${min} to ${max}.`,
    resumePlanRequired: "First get a plan: call council_resume without execute, tell the owner the roster and the upper bound on calls, then repeat the call with execute=true and the planToken from the plan.",
    resumeStale: "The resumption plan is out of date: the session journal or the parameters changed after the planToken was received. Get a new plan (council_resume without execute), tell the owner the roster and the upper bound on calls again and get consent.",
    resumeStaleWithReason: (detail: string) => `The resumption plan is out of date: the session journal or the parameters changed after the planToken was received. Get a new plan (council_resume without execute), tell the owner the roster and the upper bound on calls again and get consent. Reason: ${detail}`,
    resumeCapHint: " In council_resume the number of rounds is set by the rounds field, the cap by maxTotalTokens (null removes the cap).",
    resumeJournalChanged: (id: string) => `Session ${id}: the journal changed after the check: repeat the call.`,
    resumeReplacementUnavailable: (reason: string | undefined) => `unavailable: ${reason ?? "reason unknown"}`,
    resumeReplacementDropped: (reason: string | null | undefined) => `dropped out: ${reason ?? "reason unknown"}`,
    resumeNextPlan: (addedRounds: number, maxCalls: number, draftCalls: number, hasReplacements: boolean, hasMessage: boolean) => `Tell the owner the topic, the participants, ${addedRounds} more rounds and the upper bound on calls ${maxCalls} (active × rounds × 3${draftCalls > 0 ? ` plus ${draftCalls} calls remaining from the independent drafts` : ""})${hasReplacements ? ", each replacement (old → new) and that all agreements are reset and every active participant must agree again" : hasMessage ? ", the owner's message and that all agreements are reset and every active participant must agree again" : ""}; with requiresConsent, wait for the owner's consent, then repeat the same call with execute=true and the planToken from this response.`,
    resumeNextAccepted: (sessionId: string, dropped: number) => `Read the progress through council_status with sessionId ${sessionId} and waitSec up to 50; the result is taken only from its response.${dropped > 0 ? " Tell the owner: the messages from droppedOwnerRequests were not applied, they need to be sent again." : ""}`,
  },
  ru: {
    instrIntro: "Сервер ведёт обсуждение нескольких моделей по теме владельца до общего решения. Правила для агента:",
    instr1: "1. Шаблоны, провайдеров, модели и значения по умолчанию бери из council_options; идентификаторы не выдумывай. Участники — это значения из ответа, а не файлы: ничего не ищи на диске.",
    instr2: "2. Перед council_start напиши владельцу тему, участников, лимит кругов и верхнюю границу числа вызовов моделей (участники × круги × 3; с независимыми черновиками — участники × (круги + 1) × 3). Если хотя бы один участник расходует подписку или деньги (провайдеры вида cli и openai-http), дождись согласия владельца; отказ — не запускай. Согласие не нужно, когда владелец в этой же просьбе сам назвал участников и разрешил запуск или когда все участники сценарные (scripted), но сообщение перед запуском нужно всегда.",
    instr3: "3. Тему передавай словами владельца, от себя ничего не добавляй.",
    instr4: "4. После запуска жди итога вызовами council_status с waitSec до 50 и не пиши владельцу на каждый ход.",
    instr5: "5. Итог существует только как ответ council_status: приводи статус и решение так, как их вернул сервер. Если согласия нет, сессия остановлена, прервана или сорвалась — скажи это прямо и не выдавай последнюю версию за согласованное решение. Не подменяй обсуждение собственным ответом от имени нескольких моделей. Если в ответе есть ownerSelection — это выбор владельца, сделанный в приложении: приведи его отдельно от статуса и не называй согласием моделей.",
    instr6: "6. Файлы и папки владельца передавай в attachments у council_start: только те, что владелец назвал или явно имел в виду, сам ничего не добавляй; пути только абсолютные. Материалы уходят в каждый вызов каждого участника и увеличивают расход: в сообщении перед запуском назови владельцу число материалов и их объём в знаках (лимит — defaults.materialsChars из council_options), а после запуска — точные числа из ответа (materials). Папку можно прикладывать и тогда, когда она больше лимита: в каждый вызов уходит только исходный набор в пределах лимита, остальные файлы участники читают по запросу из снимка папки (инструментов и доступа к диску у участников по-прежнему нет) — скажи это владельцу в сообщении перед запуском. После запуска назови владельцу объём снимка (folder) и число не вошедших файлов (materials.left.count) из ответа; прочитанные участниками файлы видны в council_status (filesRead). Текст файлов в тему не вставляй.",
    instr7: "7. Ожидание владельца включается только явно полями council_start: pauseAfterRound (пауза после каждого круга без итога), waitForOwner (ждать ответа на вопрос владельцу), ownerWaitSec (срок в секундах, по умолчанию 300, не больше 86400). Без этих полей сессия не ждёт. Ожидание конечное: по истечении срока обсуждение продолжается само. Пока сессия ждёт, council_status отдаёт waiting (waitId, причины, вопросы, срок) и ownerQuestions — открытые вопросы владельцу: покажи владельцу вопросы и срок.",
    instr8: "8. council_say (реплика владельца или ответ на вопрос по questionId) и council_continue (снять ожидание по waitId) вызывай только по просьбе владельца и его словами. Не отвечай на вопрос владельцу сам и не снимай ожидание по своей инициативе. Оба инструмента возвращают requestId принятого запроса, а не подтверждение применения: применение читай в council_status. council_continue не запускает новую сессию и не добавляет кругов, но прежний исполнитель продолжит вызывать модели в уже согласованных лимитах — скажи это владельцу до вызова.",
    instr9: "9. Продолжение сессии со статусом interrupted, no_consensus, stopped или consensus — council_resume, только по просьбе владельца. Сначала вызови его без execute: это план, он ничего не пишет и модели не вызывает. Напиши владельцу тему, участников, число кругов и точную верхнюю границу вызовов из плана (maxCalls: активные участники × круги × 3 плюс остаток вызовов незавершённых независимых черновиков, draftCalls). Если requiresConsent истинно — есть участники, расходующие подписку или деньги, — дождись согласия владельца на эту границу; отказ — не запускай. Затем повтори вызов с теми же параметрами, execute=true и planToken из плана. Ошибка stale_plan значит, что сессия или параметры изменились: получи новый план, заново назови его владельцу и получи согласие. Сервер не может проверить согласие владельца: planToken подтверждает только неизменность плана, за согласие отвечаешь ты. Сессия со статусом failed продолжается, только если сбой — «активных участников меньше двух» (reasonCode insufficient_active_participants в council_status) и замены возвращают не меньше двух активных; сессии running и failed по другой причине не продолжаются. Сессия consensus продолжается только с message — ответ владельца его словами, передаётся только по его просьбе и не сочиняется тобой; без него сервер отказывает (consensus); с ним все согласия сбрасываются (agreementReset), а текст входит в planToken: другой текст даёт stale_plan, новый план и новое согласие. Состав сохранённый и меняется ТОЛЬКО через replacements: каждая замена называет выбывшего или недоступного участника (participantId) и провайдера с моделью (providerId, model), которые его заменяют. Замену называет владелец: провайдера и модель сам не выбирай, значения бери из council_options, по умолчанию никто не подставляется. Перед execute назови владельцу каждую замену (прежний → новый) и то, что все согласия сброшены и каждый активный участник должен согласиться заново. Изменение замен, доступности участников, журнала или бюджета даёт stale_plan: новый план и новое согласие. Ошибка replacement — замена отклонена. Ответ с accepted приходит до итога: ход читай в council_status по прежнему sessionId.",
    instr10: "10. Именованные составы — поле lineups в council_options: сохранённые владельцем участники с моделями, ролями и порядком. Запуск по составу — council_start с lineupId и без participants; оба поля вместе — ошибка. Перед запуском назови владельцу участников состава (провайдер, модель, роль) наравне с обычным запуском и жди согласия по условиям правила 2. Состав с available: false не запускай и не заменяй его участников своими: назови владельцу причину (reason). Пометки о моделях (modelNote в council_options, lineup.notes в ответе council_start) передай владельцу. Сохранить состав через MCP нельзя: владелец сохраняет его командой council lineups save или в приложении. Если в ответе есть lineupsError — файл составов повреждён: скажи это владельцу, остальные варианты запуска работают.",
    instr11: "11. Независимые черновики (drafts в council_start) — экспериментальный режим, выключен по умолчанию. Включай drafts: true только когда владелец прямо просит независимые черновики. Перед запуском назови владельцу синтезатора (synthesizerId; не выбран — первый участник) и границу вызовов участники × (круги + 1) × 3. Черновики в council_status (drafts) — не решение и не согласие моделей: приводи их только как промежуточные варианты; итог по-прежнему только status и solution.",
    instrOwnerLanguage: "",

    scriptedLabel: "Сценарный",
    scenarioUnavailable: (model: string) => `Сценарий «${model}» недоступен.`,
    sessionNotFound: (id: string) => `Сессия ${id} не найдена.`,

    optionsDesc: "Возвращает шаблоны обсуждений, провайдеров с доступностью и моделями и значения по умолчанию для council_start и именованные составы владельца (lineups) с доступностью каждой позиции. Сам ничего не запускает и ничего не расходует.",
    optionsProviderUnavailable: "Провайдер недоступен",
    optionsProviderNotInspected: "Провайдер не осмотрен",
    optionsNoScenarios: "Файлы сценариев не найдены",

    sayDesc:
      "Передаёт в идущую сессию реплику владельца или его ответ на вопрос участника (questionId — идентификатор из ownerQuestions в council_status). Работает и для сессий, запущенных из приложения или терминала. " +
      "Вызывай только по просьбе владельца и его словами: сам за владельца не отвечай. " +
      "Возвращает requestId принятого запроса — это очередь, а не подтверждение применения: применённые реплики видны в council_status (ownerMessages). " +
      "Реплика сбрасывает согласных; ожидание владельца она сама не снимает, кроме ожидания ответа на этот вопрос.",
    fSessionId: "Идентификатор сессии",
    sayFText: "Текст реплики или ответа словами владельца",
    sayFQuestionId: "Идентификатор открытого вопроса владельцу (ownerQuestions[].id); не указан — обычная реплика",
    sayParticipant: "Участник обсуждения не может говорить за владельца.",
    sayNext: "Запрос принят в очередь исполнителя, это ещё не применение. Применение смотри в council_status: реплика появится в ownerMessages с этим requestId, отвеченный вопрос исчезнет из ownerQuestions.",
    continueDesc:
      "Снимает текущее ожидание владельца у идущей сессии (waitId — из waiting в council_status), в том числе запущенной из приложения или терминала. Вызывай только по просьбе владельца. " +
      "Новая сессия не создаётся и круги не добавляются: прежний исполнитель продолжит обсуждение в уже согласованных лимитах, то есть возможны дальнейшие вызовы моделей — скажи об этом владельцу. " +
      "Возвращает requestId принятого запроса, а не подтверждение: снятие видно в council_status (waiting станет null или сменит waitId).",
    continueFWaitId: "Идентификатор текущего ожидания: waiting.waitId из council_status",
    continueParticipant: "Участник обсуждения не может снимать ожидание владельца.",
    continueNeedWaitId: "Нужен waitId текущего ожидания: возьмите его из waiting в ответе council_status.",
    continueNext: "Запрос на снятие ожидания принят в очередь исполнителя. Прежний исполнитель продолжит обсуждение в прежних лимитах: возможны новые вызовы моделей. Снятие смотри в council_status: waiting станет null или сменит waitId.",

    statusText: (s: StoredStatus) => ({
      consensus: "согласие достигнуто", no_consensus: "согласия нет", stopped: "остановлена",
      failed: "сбой", interrupted: "прервана", running: "идёт",
    })[s],
    statusRunningWaiting: "идёт, ждёт владельца",
    statusDrafting: (accepted: number, total: number) => `идут независимые черновики: принято ${accepted} из ${total}`,
    journalUndefined: (note: string) => `состояние не определено: ${note}; обновите приложение, чтобы прочитать сессию целиком`,
    reasonSynthesizer: (id: string) => `синтезатор ${id} выбыл, не создав версию 1; замены нет — нужна новая сессия с другим синтезатором`,
    reasonSynthesizerBare: "синтезатор выбыл, не создав версию 1; замены нет — нужна новая сессия с другим синтезатором",
    reasonInsufficient: "осталось меньше двух активных участников; сессию можно продолжить, заменив выбывшего участника через council_resume (replacements)",
    reasonDraftContext: "черновики не помещаются в лимит контекста; общее обсуждение не начато",
    statusDesc:
      "Возвращает состояние сессии: статус, круг, согласных, текущую версию решения, имена и суммарный объём материалов сессии (без текстов), действующий потолок токенов и суммарные токены; после завершения — итог, возражающих с аргументами и статистику. " +
      "ownerQuestions — открытые вопросы участников владельцу (идентификатор, автор, текст, номер хода): покажи их владельцу, сам не отвечай; ответ передаётся через council_say с questionId. waiting — текущее ожидание владельца (waitId, причины round_boundary или owner_question, удерживаемые вопросы, срок deadline) либо null: ожидание конечное, после срока обсуждение продолжается само; у прерванной сессии сохранённое waiting отдаётся отдельно от статуса. ownerMessages — уже применённые реплики владельца (requestId, номер хода, отвеченные вопросы) без текстов. " +
      "journal — null, когда журнал сессии прочитан целиком, иначе { reason: newer_version | corrupted, lastEvent }: при newer_version журнал записан более новой версией приложения, статус сессии не определён, владельцу нужно обновить приложение, и называть такую сессию прерванной нельзя. " +
      "Если владелец принял версию в приложении, ответ содержит ownerSelection (номер и текст версии, заметка, время, статус на момент выбора): это отдельный выбор владельца, а не согласие моделей — status, solution и objectors остаются исходным итогом обсуждения. " +
      "Если включены независимые черновики (эксперимент), drafts — фаза, синтезатор и принятые черновики: это промежуточные варианты, а не решение и не согласие, solution и agreed их не подменяют. Если к сессии приложена папка, ответ содержит folder — число файлов и объём её снимка (иначе null) — и filesRead — файлы снимка, прочитанные участниками в завершённых ходах (ход, участник, имя, объём, показано знаков), без текстов. " +
      "С waitSec ждёт изменения и отвечает раньше, как только завершился новый ход, применена реплика или ответ владельца, изменились вопросы или ожидание либо сессия завершилась.",
    statusFWaitSec: (cap: number) => `Сколько секунд ждать изменения (новый завершённый ход, применённая реплика владельца, изменение вопросов или ожидания, завершение сессии); не больше ${cap}`,
    waitSecInvalid: "waitSec должен быть конечным числом не меньше 0.",
    stopDesc: "Останавливает идущую сессию, в том числе запущенную из приложения или терминала, и возвращает её итоговое состояние.",
    stopFinished: (statusText: string) => `Сессия уже завершена: ${statusText}.`,
    stopNotDone: (statusText: string) => `Остановка не выполнена: ${statusText}.`,
    stopInterrupted: "Сессия прервана: её исполнитель не работает.",
    stopRequestedPending: "Остановка запрошена, сессия ещё завершается; проверьте council_status.",
    stopDone: "Сессия остановлена.",

    startDesc:
      "Запускает обсуждение нескольких моделей по теме и сразу возвращает sessionId; сессия идёт в фоне в своём процессе: закрытие агента её не прерывает, остановить можно через council_stop; состояние и итог читаются через council_status. " +
      "Запуск расходует подписки или деньги владельца и делается только с его согласия. Допустимые шаблоны, провайдеры и модели — в council_options. " +
      "Перед вызовом обязательно напиши владельцу отдельным сообщением тему, участников, лимит кругов и верхнюю границу числа вызовов моделей (участники × круги × 3; с независимыми черновиками — участники × (круги + 1) × 3), даже когда согласие не требуется." +
      " Файлы и папки владельца передаются в attachments: только названные владельцем или явно подразумеваемые, только абсолютными путями; в сообщении перед запуском назови число материалов и их объём — они уходят в каждый вызов и увеличивают расход." +
      " Папка принимается и тогда, когда она больше лимита материалов: в каждый вызов уходит только исходный набор (materials), остальные файлы участники читают по запросу из снимка папки — после запуска назови владельцу объём снимка (folder) и число не вошедших файлов (materials.left.count)." +
      " Потолок расхода задаётся в maxTotalTokens (токены, не деньги): сессия остановится сама, когда сумма токенов его достигнет." +
      " Ожидание владельца включается только явно: pauseAfterRound (пауза после каждого круга без итога) и waitForOwner (ждать ответа на вопрос владельцу), срок — ownerWaitSec. Без этих полей сессия не ждёт. Ожидание конечное: после срока обсуждение продолжается само; раньше его снимают ответ владельца (council_say) или council_continue — только по просьбе владельца." +
      " Запуск по именованному составу: поле lineupId из council_options вместо participants; участники, модели, роли и порядок берутся из состава без подмены; перед вызовом участники состава называются владельцу так же, как при обычном запуске." +
      " Экспериментальная фаза независимых черновиков: drafts=true (выключена по умолчанию, включается только по просьбе владельца) — сначала каждый участник пишет черновик, не видя чужих, затем обсуждение начинает синтезатор (synthesizerId, по умолчанию p1); synthesizerId без drafts=true — ошибка.",
    startFTopic: "Тема обсуждения",
    startFTemplateId: "Идентификатор шаблона из council_options; не указан — нейтральная рамка",
    startFProviderId: "Идентификатор провайдера из council_options",
    startFModel: "Модель; не указана — модель по умолчанию (только у провайдеров вида cli)",
    startFParticipants: "Участники по порядку очереди, не меньше двух; не указаны — участники по умолчанию",
    startFMaxRounds: (min: number, max: number) => `Лимит кругов, от ${min} до ${max}; не указан — из шаблона, иначе по умолчанию`,
    startFMaxTotalTokens: "Потолок суммарных токенов сессии (входные плюс выходные), целое не меньше 1: в сумму входят все вызовы моделей сессии, сообщившие токены, включая неудачные попытки, запросы файлов и черновики; когда сумма достигает потолка, сессия останавливается со статусом stopped и причиной token_cap. Проверка идёт между ходами, поэтому потолок может быть превышен на один ход. Не указан — значение из council_options (defaults.maxTotalTokens), а если его нет — потолка нет",
    startFPauseAfterRound: "Пауза после каждого круга без итога: сессия ждёт владельца до council_continue или до срока ownerWaitSec. По умолчанию выключено",
    startFWaitForOwner: "Ждать ответа владельца на вопрос участника перед ближайшим следующим ходом — до ответа (council_say с questionId), council_continue или срока ownerWaitSec. По умолчанию выключено",
    startFOwnerWaitSec: (max: number, def: number) => `Срок ожидания владельца в секундах, целое от 1 до ${max}; по истечении обсуждение продолжается само. Задаётся только вместе с pauseAfterRound или waitForOwner; не указан — ${def}`,
    startFLineupId: "Идентификатор именованного состава из council_options (lineups): участники, модели, роли и порядок берутся из состава; вместе с participants не указывается",
    startFDrafts: "Независимые черновики (эксперимент): перед обсуждением каждый участник пишет черновик, не видя чужих; все принятые черновики затем уходят в каждый обычный запрос. По умолчанию выключено; включай только по просьбе владельца",
    startFSynthesizerId: "Идентификатор синтезатора (p1, p2, …) — участника, который делает первый обычный ход после черновиков; только вместе с drafts=true; не указан — p1",
    startFAttachments: (snapshotChars: number) => `Абсолютные пути к файлам и папкам, которые владелец назвал или явно имел в виду; относительный путь — ошибка. Принимаются форматы: ${materialsMessages("ru").supportedFormats}. Файл другого формата отклоняется, если назван явно, и пропускается внутри папки, с причиной, называющей его вид (например аудио, видео, архив кроме ZIP, программа). Лимит исходного набора — defaults.materialsChars из council_options: явно названные файлы должны в него уложиться, из папки больше лимита берутся описания (нет описаний — файлы ближе к корню), остальные её файлы сохраняются в снимке (граница снимка — ${snapshotChars} знаков). Файлы окружения (.env) не принимаются`,
    startParticipant: "Участник обсуждения не может созывать обсуждение.",
    startLineupAndParticipants: "Поля lineupId и participants несовместимы: укажите что-то одно.",
    startRoundsBounds: (min: number, max: number) => `Лимит кругов должен быть от ${min} до ${max}.`,
    startTokenCap: "Потолок токенов (maxTotalTokens) должен быть целым числом не меньше 1.",
    startSynthesizerNeedsDrafts: "synthesizerId работает только вместе с drafts: true.",
    startOwnerWaitRange: (max: number) => `Срок ожидания владельца (ownerWaitSec) должен быть целым числом от 1 до ${max}.`,
    startOwnerWaitNeedsWait: "ownerWaitSec задаётся только вместе с pauseAfterRound или waitForOwner.",
    startRelativePaths: (names: string[]) => `Пути в attachments должны быть абсолютными: ${names.map((a) => `«${a}»`).join(", ")}. Рабочая папка сервера не совпадает с проектом владельца.`,
    startLineupNotFound: (id: string) => `Состав «${id}» не найден: список составов — в council_options.`,
    startLineupUnavailable: (name: string) => `Состав «${name}» недоступен:`,
    startLineupNote: (position: number, providerId: string, model: string, note: string) => `Позиция ${position} (${providerId}:${model}): ${note}`,
    startNoProviders: "Участников взять неоткуда: в реестре нет провайдеров. Укажите participants или опишите провайдера в config.json.",
    startScriptedNeedsModel: "Для сценарного участника нужен сценарий в поле model.",
    startProviderNotFound: (id: string, known: string[]) => `Провайдер «${id}» не найден в реестре: есть ${known.join(", ") || "провайдеров нет"}.`,
    startProviderNeedsModel: (id: string) => `Для провайдера «${id}» нужна модель.`,
    startProviderUnavailable: (label: string, reason: string | null | undefined) => `Провайдер «${label}» недоступен: ${reason ?? "причина неизвестна"}`,
    startExecutorFailed: (reason: string) => `Исполнитель сессии не запустился: ${reason}`,
    startExecutorTimeout: (sec: number) => `исполнитель не ответил за ${sec} с`,
    startNext: (hasMaterials: boolean, hasFolder: boolean) => `Если ещё не назвал владельцу участников, лимит кругов и верхнюю границу вызовов (maxCalls)${hasMaterials ? " и число и объём материалов (materials)" : ""}${hasFolder ? " и объём снимка папки (folder) и число не вошедших в исходный набор файлов (materials.left.count)" : ""}, назови сейчас одной строкой. Дальше council_status с этим sessionId и waitSec до 50, без сообщений на каждый ход; итог берётся только из его ответа.`,
    startNextLineupNotes: " Передай владельцу пометки о моделях состава (lineup.notes).",
    startNextDrafts: (synthesizerId: string, synthesizerName: string, byDefault: boolean, bound: number) => ` Включены независимые черновики (эксперимент): сначала каждый участник пишет черновик, не видя чужих, затем обычное обсуждение начинает синтезатор ${synthesizerId} (${synthesizerName})${byDefault ? ", выбранный по умолчанию" : ""}; назови владельцу синтезатора и границу вызовов ${bound} (участники × (круги + 1) × 3).`,
    startNextOwnerWait: (sec: number) => ` Включено ожидание владельца (срок ${sec} с, затем обсуждение продолжится само): когда в council_status появятся waiting или ownerQuestions, покажи их владельцу; council_say и council_continue — только по его просьбе.`,

    resumeDesc:
      "Продолжает сохранённую сессию со статусом interrupted, no_consensus или stopped в том же журнале, с прежним sessionId и сохранённым составом участников. " +
      "Сессия со статусом failed продолжается, только когда сбой — «активных участников меньше двух» (reasonCode insufficient_active_participants в council_status) и замены возвращают не меньше двух активных. " +
      "Состав меняется только через replacements: каждая замена называет выбывшего или недоступного участника и провайдера с моделью, которые его заменяют; замену называет владелец, провайдера и модель сам не выбирай, значения бери из council_options; по умолчанию никто не подставляется. Новый участник получает следующий идентификатор, место и роль прежнего; прежний остаётся в истории; все согласия сбрасываются. " +
      "Запуск (execute=true) расходует подписки или деньги владельца: вызовы моделей идут в пределах maxCalls. " +
      "Без execute — это план: ничего не пишет и модели не вызывает, возвращает состав, число кругов, точную верхнюю границу вызовов maxCalls (активные × круги × 3 плюс остаток вызовов незавершённых независимых черновиков, draftCalls), requiresConsent и planToken. " +
      "Перед execute назови владельцу тему, участников, круги и точную границу maxCalls, каждую замену (прежний → новый) и то, что все согласия сброшены, и, когда requiresConsent истинно, получи его согласие; затем повтори вызов с теми же параметрами, execute=true и planToken из плана. " +
      "Ошибка stale_plan значит, что сессия, замены, доступность участников или параметры изменились после плана: нужен новый план и новое согласие владельца. " +
      "Сессия со статусом consensus продолжается только с message: собственный ответ владельца его словами, только по его просьбе; без него сервер отказывает (consensus), с ним все согласия сбрасываются (agreementReset), а текст входит в planToken (другой текст — stale_plan). Сессии со статусом running и failed по другой причине не продолжаются. Ошибка replacement — замена отклонена (повтор, неизвестный или уже заменённый id, доступный участник, недоступный новый). " +
      "Как и сессия council_start, продолженная сессия идёт в фоне в своём процессе: закрытие агента её не прерывает, остановить можно через council_stop. Ответ execute приходит до итога обсуждения: ход читай в council_status по прежнему sessionId. Только по просьбе владельца.",
    resumeFRounds: (min: number, max: number) => `Сколько ещё кругов пройти, целое от ${min} до ${max}; не указано — остаток прежнего лимита`,
    resumeFMaxTotalTokens: "Новый потолок суммарных токенов, целое не меньше 1; null — снять потолок; не указано — прежний",
    resumeFExecute: "true — запустить продолжение; по умолчанию false (только план)",
    resumeFPlanToken: "Токен из плана; обязателен при execute=true",
    resumeFMessage: "Реплика владельца его словами; обязательна для продолжения сессии consensus, передаётся только по просьбе владельца и не сочиняется агентом; все согласия сбрасываются; текст входит в planToken",
    resumeConsensusHint: " Сессия consensus продолжается только с message — словами владельца, по его просьбе.",
    resumeFReplacements: "Замены выбывших или недоступных участников: кого (participantId) и на кого (providerId, model из council_options); новый участник получает следующий идентификатор, место и роль прежнего; все согласия сбрасываются",
    resumeParticipant: "Участник обсуждения не может продолжать обсуждение.",
    resumeBadRounds: (min: number, max: number) => `Число дополнительных кругов (rounds) должно быть целым от ${min} до ${max}.`,
    resumePlanRequired: "Сначала получите план: вызовите council_resume без execute, назовите владельцу состав и верхнюю границу вызовов, затем повторите вызов с execute=true и planToken из плана.",
    resumeStale: "План продолжения устарел: журнал сессии или параметры изменились после получения planToken. Получите новый план (council_resume без execute), заново назовите владельцу состав и верхнюю границу вызовов и получите согласие.",
    resumeStaleWithReason: (detail: string) => `План продолжения устарел: журнал сессии или параметры изменились после получения planToken. Получите новый план (council_resume без execute), заново назовите владельцу состав и верхнюю границу вызовов и получите согласие. Причина: ${detail}`,
    resumeCapHint: " В council_resume число кругов задаёт поле rounds, потолок — maxTotalTokens (null снимает потолок).",
    resumeJournalChanged: (id: string) => `Сессия ${id}: журнал изменился после проверки: повторите вызов.`,
    resumeReplacementUnavailable: (reason: string | undefined) => `недоступен: ${reason ?? "причина неизвестна"}`,
    resumeReplacementDropped: (reason: string | null | undefined) => `выбыл: ${reason ?? "причина неизвестна"}`,
    resumeNextPlan: (addedRounds: number, maxCalls: number, draftCalls: number, hasReplacements: boolean, hasMessage: boolean) => `Назови владельцу тему, участников, ещё ${addedRounds} кругов и верхнюю границу вызовов ${maxCalls} (активные × круги × 3${draftCalls > 0 ? ` плюс ${draftCalls} вызовов остатка независимых черновиков` : ""})${hasReplacements ? ", каждую замену (прежний → новый) и то, что все согласия сброшены и каждый активный участник должен согласиться заново" : hasMessage ? ", реплику владельца и то, что все согласия сброшены и каждый активный участник должен согласиться заново" : ""}; при requiresConsent дождись согласия владельца, затем повтори тот же вызов с execute=true и planToken из этого ответа.`,
    resumeNextAccepted: (sessionId: string, dropped: number) => `Читай ход через council_status с sessionId ${sessionId} и waitSec до 50; итог берётся только из его ответа.${dropped > 0 ? " Скажи владельцу: реплики из droppedOwnerRequests не применены, их нужно отправить заново." : ""}`,
  },
});
