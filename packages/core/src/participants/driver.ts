import type { Participant, Usage } from "../protocol/schema.ts";
import type { Language } from "../i18n/language.ts";

export interface TurnRequest {
  participant: Participant;
  prompt: string;                    // the whole context of the turn; the participant keeps no state
  language: Language;                // session language: the prompt and the CLI participant's system prompt are built in it
  timeoutSec: number;
  signal: AbortSignal;               // abort: session stop or timeout
  onChunk: (text: string) => void;   // pieces of the reply text as they appear
}

export interface TurnResult { text: string; usage: Usage }

export interface ParticipantDriver { call(request: TurnRequest): Promise<TurnResult> }

export class ParticipantCallError extends Error {
  readonly kind: "call_error" | "timeout";
  readonly retryable: boolean;
  constructor(kind: "call_error" | "timeout", message: string, retryable: boolean = true) {
    super(message);
    this.name = "ParticipantCallError";
    this.kind = kind;
    this.retryable = retryable;
  }
}
