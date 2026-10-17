import { z } from "zod";
import { MAX_CALLS_PER_TURN } from "./folder.ts";
import { protocolMessages } from "../messages/protocol.ts";
import { promptMessages } from "../messages/prompt.ts";
import { LANGUAGES } from "../i18n/language.ts";
import type { Language } from "../i18n/language.ts";

const nonBlank = z.string().refine((s) => s.trim().length > 0, { error: () => protocolMessages().blank });
const posInt = z.number().int().min(1);
const isoDate = z.iso.datetime({ offset: true });

export const StanceSchema = z.enum(["amend", "agree", "object"]);
export type Stance = z.infer<typeof StanceSchema>;

export const ParticipantSchema = z.object({
  id: z.string().regex(/^p[1-9]\d*$/),
  name: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  role: z.string().nullable(),
  replaces: z.string().regex(/^p[1-9]\d*$/).optional(), // identifier of the replaced participant; only on replacers during resume
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const ReplacementSchema = z.object({
  oldParticipantId: z.string().regex(/^p[1-9]\d*$/),
  participant: ParticipantSchema,
});
export type SessionReplacement = z.infer<typeof ReplacementSchema>;

export const MaterialMetaSchema = z.object({
  id: z.string().regex(/^m[1-9]\d*$/),
  name: nonBlank,
  chars: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type MaterialMeta = z.infer<typeof MaterialMetaSchema>;

export const LimitsSchema = z.object({
  maxRounds: posInt,
  turnTimeoutSec: posInt,
  contextChars: posInt,
  materialsChars: posInt.optional(),
  maxTotalTokens: posInt.optional(),
});
export type Limits = z.infer<typeof LimitsSchema>;

export const OWNER_WAIT_DEFAULT_SEC = 300; // wait time if it is not set while the mode is on
export const OWNER_WAIT_MAX_SEC = 86400;
// Largest turn timeout: sec * 1000 must not exceed 2147483647 ms, otherwise setTimeout fires after 1 ms.
export const MAX_TURN_TIMEOUT_SEC = 2147483;
export const OwnerWaitSettingsSchema = z.object({
  pauseAfterRound: z.boolean().optional(), // pause after every non-terminal round
  waitForOwner: z.boolean().optional(),    // wait for an answer to a question to the owner
  timeoutSec: z.number().int().min(1).max(OWNER_WAIT_MAX_SEC).optional(),
});
export type OwnerWaitSettings = z.infer<typeof OwnerWaitSettingsSchema>;

export const OwnerWaitReasonSchema = z.enum(["round_boundary", "owner_question"]);
export type OwnerWaitReason = z.infer<typeof OwnerWaitReasonSchema>;
const waitId = z.string().regex(/^w[1-9]\d*$/);

export const SessionSchema = z
  .object({
    id: z.string().min(1),
    createdAt: isoDate,
    origin: z.enum(["desktop", "mcp", "cli"]),
    topic: nonBlank,
    templateId: z.string().nullable(),
    framing: z.string(),
    participants: z.array(ParticipantSchema).min(2),
    materials: z.array(MaterialMetaSchema).optional(),
    workspace: z.object({ files: posInt, chars: z.number().int().min(0) }).optional(),
    limits: LimitsSchema,
    ownerWait: OwnerWaitSettingsSchema.optional(), // absent = both owner wait modes are off
    drafts: z.object({ enabled: z.literal(true), synthesizerId: z.string() }).optional(), // absent = no independent drafts phase
    language: z.enum(LANGUAGES).optional(), // language of model requests; written at creation and not changed; absent = ru
  })
  .superRefine((s, ctx) => {
    if (s.drafts && !s.participants.some((p) => p.id === s.drafts!.synthesizerId)) {
      ctx.addIssue({
        code: "custom",
        path: ["drafts", "synthesizerId"],
        message: protocolMessages().synthesizerNotListed(s.drafts.synthesizerId),
      });
    }
    s.participants.forEach((p, i) => {
      if (p.id !== `p${i + 1}`) {
        ctx.addIssue({
          code: "custom",
          path: ["participants", i, "id"],
          message: protocolMessages().participantIdAt(i + 1, p.id),
        });
      }
      if (p.replaces !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["participants", i, "replaces"],
          message: protocolMessages().noReplacement(p.id),
        });
      }
    });
    s.materials?.forEach((m, i) => {
      if (m.id !== `m${i + 1}`) {
        ctx.addIssue({
          code: "custom",
          path: ["materials", i, "id"],
          message: protocolMessages().materialIdAt(i + 1, m.id),
        });
      }
    });
  });
export type Session = z.infer<typeof SessionSchema>;

/** Session language: recorded at creation; a journal without the field is a Russian session. */
export function sessionLanguage(session: Pick<Session, "language">): Language {
  return session.language ?? "ru";
}

// Messages of the model reply schema go into a repeated request (parse.ts) in the session language; the built-in zod texts are not translated.
function makeTurnResponseSchema(language: Language) {
  const m = promptMessages(language);
  const responseNonBlank = z.string().refine((s) => s.trim().length > 0, m.blank);
  return z
    .object({
      stance: StanceSchema,
      reasoning: responseNonBlank,
      solution: z.string().nullable(),
      answers: z.array(z.object({ questionId: z.string().min(1), text: responseNonBlank })),
      questions: z.array(z.object({ to: z.string().min(1), text: responseNonBlank })),
      files: z.array(z.string()).default([]),
    })
    .superRefine((r, ctx) => {
      const has = r.solution !== null && r.solution.trim().length > 0;
      if (r.stance === "amend" && !has) ctx.addIssue({ code: "custom", path: ["solution"], message: m.amendNeedsText });
      if (r.stance !== "amend" && has) ctx.addIssue({ code: "custom", path: ["solution"], message: m.notAmendNoText(r.stance) });
    })
    .transform((r) => ({ ...r, solution: r.solution !== null && r.solution.trim().length > 0 ? r.solution : null }));
}

const TURN_RESPONSE_SCHEMAS = { en: makeTurnResponseSchema("en"), ru: makeTurnResponseSchema("ru") };
/** Participant reply schema; the language affects only the texts of its own messages, not whether the reply is accepted. */
export const turnResponseSchema = (language: Language) => TURN_RESPONSE_SCHEMAS[language];
export const TurnResponseSchema = TURN_RESPONSE_SCHEMAS.ru;
export type TurnResponse = z.infer<typeof TurnResponseSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const FailureKindSchema = z.enum(["call_error", "timeout", "invalid_response"]);
export type FailureKind = z.infer<typeof FailureKindSchema>;

export const FinalStatusSchema = z.enum(["consensus", "no_consensus", "stopped", "failed"]);
export type FinalStatus = z.infer<typeof FinalStatusSchema>;

// reason of the session_finished event on a stop by the token cap
export const TOKEN_CAP_REASON = "token_cap";
// reason of the session_finished event when the synthesizer is unavailable and when the context limit is exceeded by drafts
export const SYNTHESIZER_UNAVAILABLE_REASON = "synthesizer_unavailable";
export const DRAFT_CONTEXT_LIMIT_REASON = "draft_context_limit";
// reasonCode of the session_finished event: fewer than two active participants
export const INSUFFICIENT_ACTIVE_REASON_CODE = "insufficient_active_participants";

const base = { seq: posInt, ts: isoDate };

const TurnCompletedSchema = z
  .object({
    ...base,
    type: z.literal("turn_completed"),
    turn: posInt,
    round: posInt,
    participantId: z.string(),
    stance: StanceSchema,
    normalized: z.boolean(),
    reasoning: nonBlank,
    solution: z.string().nullable(),
    version: posInt,
    questions: z.array(z.object({ id: z.string().regex(/^q[1-9]\d*$/), to: z.string(), text: z.string() })),
    answers: z.array(z.object({ questionId: z.string(), text: z.string() })),
    attempts: posInt,
    usage: UsageSchema,
    durationMs: z.number().int().min(0),
    filesRead: z.array(z.object({ name: z.string(), chars: z.number().int().min(0), shown: z.number().int().min(0) })).optional(),
  })
  .refine((e) => (e.solution !== null) === (e.stance === "amend"), {
    path: ["solution"],
    error: () => protocolMessages().solutionIffAmend,
  });

const draftId = z.string().regex(/^d[1-9]\d*$/);
const draftAttempt = z.number().int().min(1).max(MAX_CALLS_PER_TURN);

export const SessionEventSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("session_created"), session: SessionSchema, pid: z.number().int() }),
  z.object({
    ...base, type: z.literal("session_resumed"), pid: z.number().int(), maxRounds: posInt, maxTotalTokens: posInt.nullable().optional(),
    replacements: z.array(ReplacementSchema).min(1).optional(), // participant replacements on resume
  }).refine(
    (e) => {
      const r = e.replacements ?? [];
      return new Set(r.map((x) => x.oldParticipantId)).size === r.length && new Set(r.map((x) => x.participant.id)).size === r.length;
    },
    { path: ["replacements"], error: () => protocolMessages().replacementsRepeat },
  ),
  z.object({ ...base, type: z.literal("turn_started"), turn: posInt, round: posInt, participantId: z.string() }),
  TurnCompletedSchema,
  z.object({
    ...base,
    type: z.literal("turn_failed"),
    turn: posInt,
    round: posInt,
    participantId: z.string(),
    attempt: posInt,
    kind: FailureKindSchema,
    message: z.string(),
    raw: z.string().optional(),
    usage: UsageSchema.optional(),
  }),
  // turn call that answered with a file request for the folder: its usage (empty usage — not reported)
  z.object({ ...base, type: z.literal("turn_files_served"), turn: posInt, round: posInt, participantId: z.string(), attempt: posInt, usage: UsageSchema }),
  z.object({ ...base, type: z.literal("participant_dropped"), participantId: z.string(), reason: z.string() }),
  z.object({
    ...base,
    type: z.literal("question_closed"),
    questionId: z.string(),
    reason: z.enum(["answered", "unanswered"]),
  }),
  z.object({
    ...base,
    type: z.literal("session_finished"),
    status: FinalStatusSchema,
    version: posInt.nullable(),
    agreed: z.array(z.string()),
    objectors: z.array(z.object({ participantId: z.string(), reasoning: z.string().nullable() })),
    reason: z.string().optional(),
    reasonCode: z.string().min(1).optional(),
  }),
  z.object({
    ...base, type: z.literal("owner_message"),
    id: z.string().regex(/^o[1-9]\d*$/),   // o1, o2, … in order within the session
    text: nonBlank,                         // full text of the owner message
    afterTurn: z.number().int().min(0),     // number of the last started turn at the time of application
    requestId: z.string().min(1),           // identifier of the request file: protection against repeated application
    answers: z.array(z.object({ questionId: z.string().min(1), text: nonBlank })).min(1).optional(), // answers to participants' questions to the owner
  }),
  z.object({
    ...base, type: z.literal("owner_selected_version"),
    version: posInt,                      // number of an existing solution version
    statusAtSelection: FinalStatusSchema, // session outcome at the time of selection
    note: nonBlank.optional(),            // owner's note
  }),
  z.object({
    ...base, type: z.literal("owner_wait_started"),
    waitId,                                                      // w1, w2, … in order within the session
    reasons: z.array(OwnerWaitReasonSchema).min(1),              // why the engine waits
    questionIds: z.array(z.string().min(1)),                     // owner questions being held
    afterTurn: z.number().int().min(0),                          // number of the last started turn
    deadline: isoDate,                                           // absolute wait deadline
  }),
  z.object({
    ...base, type: z.literal("owner_wait_updated"),
    waitId,
    reasons: z.array(OwnerWaitReasonSchema).min(1),
    questionIds: z.array(z.string().min(1)),
  }),
  z.object({
    ...base, type: z.literal("owner_wait_finished"),
    waitId,
    reason: z.enum(["continued", "answered", "expired", "stopped"]),
    requestId: z.string().min(1).optional(),                     // request that released the wait: protection against repeated application
  }),
  z.object({ ...base, type: z.literal("draft_attempt_started"), draftId, participantId: z.string(), attempt: draftAttempt }),
  z.object({
    ...base, type: z.literal("draft_attempt_failed"),
    draftId, participantId: z.string(), attempt: draftAttempt,
    kind: FailureKindSchema, message: z.string(), raw: z.string().optional(), usage: UsageSchema.optional(),
  }),
  z.object({ ...base, type: z.literal("draft_files_served"), draftId, participantId: z.string(), attempt: draftAttempt, usage: UsageSchema }),
  z.object({
    ...base, type: z.literal("draft_completed"),
    draftId, participantId: z.string(), attempts: posInt, durationMs: z.number().int().min(0), usage: UsageSchema,
    chars: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/), reasoning: nonBlank,
    usageIncomplete: z.literal(true).optional(), // the slot had an attempt with unknown usage (cut off in an earlier segment)
    filesRead: z.array(z.object({ name: z.string(), chars: z.number().int().min(0), shown: z.number().int().min(0) })).optional(),
  }),
  z.object({ ...base, type: z.literal("drafts_finished") }),
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

export type SessionCreatedEvent = Extract<SessionEvent, { type: "session_created" }>;
export type SessionResumedEvent = Extract<SessionEvent, { type: "session_resumed" }>;
export type TurnStartedEvent = Extract<SessionEvent, { type: "turn_started" }>;
export type TurnCompletedEvent = Extract<SessionEvent, { type: "turn_completed" }>;
export type TurnFailedEvent = Extract<SessionEvent, { type: "turn_failed" }>;
export type TurnFilesServedEvent = Extract<SessionEvent, { type: "turn_files_served" }>;
export type ParticipantDroppedEvent = Extract<SessionEvent, { type: "participant_dropped" }>;
export type QuestionClosedEvent = Extract<SessionEvent, { type: "question_closed" }>;
export type SessionFinishedEvent = Extract<SessionEvent, { type: "session_finished" }>;
export type OwnerMessageEvent = Extract<SessionEvent, { type: "owner_message" }>;
export type OwnerSelectedVersionEvent = Extract<SessionEvent, { type: "owner_selected_version" }>;
export type OwnerWaitStartedEvent = Extract<SessionEvent, { type: "owner_wait_started" }>;
export type OwnerWaitUpdatedEvent = Extract<SessionEvent, { type: "owner_wait_updated" }>;
export type OwnerWaitFinishedEvent = Extract<SessionEvent, { type: "owner_wait_finished" }>;
export type DraftAttemptStartedEvent = Extract<SessionEvent, { type: "draft_attempt_started" }>;
export type DraftAttemptFailedEvent = Extract<SessionEvent, { type: "draft_attempt_failed" }>;
export type DraftFilesServedEvent = Extract<SessionEvent, { type: "draft_files_served" }>;
export type DraftCompletedEvent = Extract<SessionEvent, { type: "draft_completed" }>;
export type DraftsFinishedEvent = Extract<SessionEvent, { type: "drafts_finished" }>;
