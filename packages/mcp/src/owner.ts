import { z } from "zod";
import { OwnerMessageRejectedError, OwnerReleaseRejectedError, requestOwnerMessage, requestOwnerRelease } from "@model-council/core";
import { defineTool, ToolError } from "./context.ts";
import { mcpMessages } from "./messages.ts";
import { load } from "./status.ts";

export const councilSay = defineTool({
  name: "council_say",
  get description() { return mcpMessages().sayDesc; },
  get inputSchema() {
    const m = mcpMessages();
    return {
      sessionId: z.string().describe(m.fSessionId),
      text: z.string().describe(m.sayFText),
      questionId: z.string().optional().describe(m.sayFQuestionId),
    };
  },
  async run(ctx, { sessionId, text, questionId }) {
    if (ctx.env.COUNCIL_PARTICIPANT === "1") throw new ToolError(mcpMessages().sayParticipant);
    load(ctx, sessionId);
    let requestId: string;
    try {
      ({ requestId } = requestOwnerMessage(ctx.dataDir, sessionId, text, questionId === undefined ? {} : { questionId }));
    } catch (e) {
      if (e instanceof OwnerMessageRejectedError) throw new ToolError(e.reason === "newer_version" ? `newer_version: ${e.message}` : e.message);
      throw e;
    }
    // the message text is not written to the journal: identifiers only
    ctx.logger.info(`Owner message queued: session ${sessionId}, request ${requestId}${questionId === undefined ? "" : `, question ${questionId}`}`);
    return {
      sessionId, requestId, questionId: questionId ?? null, queued: true,
      next: mcpMessages().sayNext,
    };
  },
});

export const councilContinue = defineTool({
  name: "council_continue",
  get description() { return mcpMessages().continueDesc; },
  get inputSchema() {
    const m = mcpMessages();
    return {
      sessionId: z.string().describe(m.fSessionId),
      waitId: z.string().describe(m.continueFWaitId),
    };
  },
  async run(ctx, { sessionId, waitId }) {
    if (ctx.env.COUNCIL_PARTICIPANT === "1") throw new ToolError(mcpMessages().continueParticipant);
    if (waitId.trim() === "") throw new ToolError(mcpMessages().continueNeedWaitId);
    load(ctx, sessionId);
    let requestId: string;
    try {
      ({ requestId } = requestOwnerRelease(ctx.dataDir, sessionId, { waitId }));
    } catch (e) {
      if (e instanceof OwnerReleaseRejectedError) throw new ToolError(e.reason === "newer_version" ? `newer_version: ${e.message}` : e.message);
      throw e;
    }
    ctx.logger.info(`Wait release request queued: session ${sessionId}, wait ${waitId}, request ${requestId}`);
    return {
      sessionId, requestId, waitId, queued: true,
      next: mcpMessages().continueNext,
    };
  },
});
