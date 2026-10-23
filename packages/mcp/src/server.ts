import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sweepLaunchDir } from "@model-council/core";
import { ToolError } from "./context.ts";
import type { Tool, ToolContext } from "./context.ts";
import { mcpMessages } from "./messages.ts";
import { councilOptions } from "./options.ts";
import { councilContinue, councilSay } from "./owner.ts";
import { councilResume } from "./resume.ts";
import { cleanupActiveLaunches, councilStart } from "./start.ts";
import { councilStatus, councilStop } from "./status.ts";

export const TOOLS = [councilOptions, councilStart, councilStatus, councilStop, councilSay, councilContinue, councilResume];

export function instructions(): string {
  const m = mcpMessages();
  return [m.instrIntro, m.instr1, m.instr2, m.instr3, m.instr4, m.instr5, m.instr6, m.instr7, m.instr8, m.instr9, m.instr10, m.instr11, m.instrOwnerLanguage].filter((l) => l !== "").join("\n");
}

const text = (t: string, isError?: true): CallToolResult => ({ ...(isError && { isError }), content: [{ type: "text", text: t }] });

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "osen", version: "0.0.0" }, { instructions: instructions() });
  for (const tool of TOOLS as Tool[]) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (input: unknown) => {
      try {
        return text(JSON.stringify(await tool.run(ctx, input as never), null, 2));
      } catch (e) {
        ctx.logger.error(`Tool error ${tool.name}`, e instanceof ToolError && e.logText !== undefined ? e.logText : e);
        return text(e instanceof Error ? e.message : String(e), true);
      }
    });
  }
  return server;
}

/** Shared start-up of both entry points (source and packaged): sweeps stale launch files, wires shutdown, serves MCP over stdio. */
export async function runServer(ctx: Omit<ToolContext, "shutdown">): Promise<void> {
  const swept = sweepLaunchDir(ctx.dataDir);
  if (swept > 0) ctx.logger.info(`Launch folder swept: ${swept} stale files removed`);
  const controller = new AbortController();
  // ponytail: quit removes the files of launches still waiting, exits the server and wakes its waits; every session (council_start, council_resume) runs in its own detached executor and survives
  const quit = (reason: string): void => {
    ctx.logger.info(`MCP server is stopping: ${reason}`);
    controller.abort();
    cleanupActiveLaunches();
    process.exit(0);
  };
  process.stdin.on("end", () => quit("stdin closed"));
  process.stdin.on("close", () => quit("stdin closed"));
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(s, () => quit(s));
  process.on("unhandledRejection", (e) => ctx.logger.error("Unhandled promise rejection", e));
  await createServer({ ...ctx, shutdown: controller.signal }).connect(new StdioServerTransport());
}
