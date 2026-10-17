import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

export interface FakeServerOptions {
  port?: number;
  apiKey?: string;
  chunkDelayMs?: number;
}
export interface FakeRequest { method: string; path: string; authorization: string | undefined; body: unknown }
export interface FakeServer {
  url: string;
  requests: FakeRequest[];
  closedEarly: number;
  close(): Promise<void>;
}

export const FAKE_MODELS: readonly string[] = [
  "fake-amend", "fake-agree", "fake-plain", "fake-cost", "fake-auth", "fake-rate", "fake-error", "fake-hang", "fake-slow", "fake-midstream-error",
];
export const FAKE_USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } as const;
export const FAKE_AMEND = JSON.stringify({ stance: "amend", reasoning: "I propose the first version of the solution: the name should be short and suit a ginger cat.", solution: "Name the cat Ginger.", answers: [], questions: [] });
export const FAKE_AGREE = JSON.stringify({ stance: "agree", reasoning: "I agree with the current version of the solution.", solution: null, answers: [], questions: [] });

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const err = (message: string, type?: string, code?: string) => ({ error: { message, ...(type ? { type } : {}), ...(code ? { code } : {}) } });
const readBody = (req: IncomingMessage) => new Promise<string>((resolve) => {
  const parts: Buffer[] = [];
  req.on("data", (c: Buffer) => parts.push(c));
  req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
  req.on("error", () => resolve(""));
});

export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const delay = options.chunkDelayMs ?? 0;
  const requests: FakeRequest[] = [];
  const state = { closedEarly: 0 };

  const stream = async (res: ServerResponse, model: string, text: string, usage: object, mode: "full" | "slow" | "error") => {
    let alive = true;
    let wake: (() => void) | undefined;
    res.on("close", () => { alive = false; clearTimeout(timer); wake?.(); });
    let timer: NodeJS.Timeout | undefined;
    const pause = () => (delay > 0 && alive ? new Promise<void>((r) => { wake = r; timer = setTimeout(r, delay); }) : Promise.resolve());
    const send = (choices: unknown[], extra: object = {}) =>
      res.write(`data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model, choices, ...extra })}\n\n`);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
    res.write(": fake keep-alive\n\n");
    const chars = Array.from(text);
    const pieces: string[] = [];
    for (let i = 0; i < chars.length; i += 16) pieces.push(chars.slice(i, i + 16).join(""));
    if (mode !== "full") pieces.length = 1;
    for (const piece of pieces) {
      if (!alive) return;
      send([{ index: 0, delta: { role: "assistant", content: piece }, finish_reason: null }]);
      await pause();
    }
    if (!alive || mode === "slow") return; // slow: wait for the client to drop or the server to close
    if (mode === "error") {
      res.write(`data: ${JSON.stringify({ error: { message: "Provider returned error", code: 502 } })}\n\n`);
    } else {
      send([{ index: 0, delta: {}, finish_reason: "stop" }]);
      send([], { usage });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  };

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const raw = req.method === "POST" ? await readBody(req) : "";
    let body: unknown;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    const authorization = req.headers.authorization;
    requests.push({ method: req.method ?? "", path, authorization, body });
    const authError = () => json(res, 401, err(`Incorrect API key provided: ${authorization ?? "(none)"}`, "invalid_request_error", "invalid_api_key"));

    if (options.apiKey && authorization !== `Bearer ${options.apiKey}`) return authError();
    if (req.method === "GET" && path === "/v1/models") {
      return json(res, 200, { object: "list", data: FAKE_MODELS.map((id) => ({ id, object: "model" })) });
    }
    if (req.method !== "POST" || path !== "/v1/chat/completions") return json(res, 404, err("Not found"));

    res.on("close", () => { if (!res.writableEnded) state.closedEarly++; });
    const model = (body as { model?: unknown } | undefined)?.model;
    if (typeof model !== "string") return json(res, 400, err("Invalid request body", "invalid_request_error"));
    switch (model) {
      case "fake-amend": return stream(res, model, FAKE_AMEND, FAKE_USAGE, "full");
      case "fake-agree": return stream(res, model, FAKE_AGREE, FAKE_USAGE, "full");
      case "fake-cost": return stream(res, model, FAKE_AGREE, { ...FAKE_USAGE, cost: 0.00012 }, "full");
      case "fake-slow": return stream(res, model, FAKE_AMEND, FAKE_USAGE, "slow");
      case "fake-midstream-error": return stream(res, model, FAKE_AMEND, FAKE_USAGE, "error");
      case "fake-plain":
        return json(res, 200, { id: "chatcmpl-fake", object: "chat.completion", created: 0, model, choices: [{ index: 0, message: { role: "assistant", content: FAKE_AMEND }, finish_reason: "stop" }], usage: FAKE_USAGE });
      case "fake-auth": return authError();
      case "fake-rate": return json(res, 429, err("Rate limit exceeded", "rate_limit_error", "rate_limit_exceeded"), { "Retry-After": "1" });
      case "fake-error": return json(res, 500, err("Internal server error", "server_error"));
      case "fake-hang": return; // no reply: the connection hangs until it drops
      default: return json(res, 404, err(`The model \`${model}\` does not exist`, "invalid_request_error", "model_not_found"));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    get closedEarly() { return state.closedEarly; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "8787" }, "api-key": { type: "string" }, "chunk-delay": { type: "string", default: "150" } } });
  const srv = await startFakeServer({ port: Number(values.port), apiKey: values["api-key"], chunkDelayMs: Number(values["chunk-delay"]) });
  console.log(`Fake server: ${srv.url}`);
  if (values["api-key"]) console.log("Key required: yes");
  process.on("SIGINT", () => void srv.close().then(() => process.exit(0)));
}
