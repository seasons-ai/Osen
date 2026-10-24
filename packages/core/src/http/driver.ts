import { ParticipantCallError } from "../participants/driver.ts";
import type { ParticipantDriver, TurnRequest, TurnResult } from "../participants/driver.ts";
import type { Usage } from "../protocol/schema.ts";
import { providerMessages } from "../messages/providers.ts";
import { authHeaders, redact } from "./types.ts";
import type { HttpRuntime } from "./types.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const tokens = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
const parseJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

/** SSE parser: accepts bytes or strings in pieces however they come; calls onData for each event; `[DONE]` ends parsing. */
export function createSseParser(onData: (data: string) => void): { write(chunk: Uint8Array | string): void; end(): void; readonly done: boolean } {
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  let done = false;
  const line = (l: string) => {
    if (l === "") {
      if (!data.length) return;
      const d = data.join("\n");
      data = [];
      if (d.trim() === "[DONE]") done = true; else onData(d);
    } else if (l.startsWith("data:")) data.push(l.slice(5).replace(/^ /, ""));
  };
  const feed = (text: string) => {
    buf += text;
    const lines = buf.split(/\r\n|\n|\r/);
    buf = lines.pop() ?? "";
    for (const l of lines) { if (done) return; line(l); }
  };
  return {
    write: (chunk) => { if (!done) feed(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })); },
    end: () => { if (done) return; feed(decoder.decode()); if (buf) line(buf); buf = ""; line(""); },
    get done() { return done; },
  };
}

const serverText = (body: string, runtime: HttpRuntime): string => {
  const data = parseJson(body);
  const err = isObj(data) ? data.error : undefined;
  const text = isObj(err) && typeof err.message === "string" ? err.message : typeof err === "string" ? err : body;
  return redact(text, runtime).replace(/\s*[\r\n]+\s*/g, " ").trim().slice(0, 300);
};

export function classifyHttpFailure(input: { status: number; body: string; model: string; runtime: HttpRuntime }): { message: string; retryable: boolean } {
  const { status, body, model, runtime } = input;
  const text = serverText(body, runtime);
  const tail = text ? `: ${text}` : "";
  const m = providerMessages();
  if (status === 401 || status === 403) { // the server text is not included: servers echo the sent key back in it
    const hint = runtime.apiKeyEnv ? m.httpKeyHint(runtime.apiKeyEnv, runtime.keyFile) : m.httpKeyRequired;
    return { message: m.httpAuthDenied(status, hint), retryable: false };
  }
  const data = parseJson(body);
  const code = isObj(data) && isObj(data.error) ? data.error.code : undefined;
  if (status === 429) return { message: m.httpRateLimit("HTTP 429", tail), retryable: true };
  if (code === "rate_limit_exceeded" || code === "insufficient_quota") return { message: m.httpRateLimit(code, tail), retryable: true };
  // ponytail: heuristics over OpenAI/OpenRouter/Ollama texts; revisit when a provider with another format appears
  const notFound = code === "model_not_found" || status === 404 ||
    (status === 400 && /model/i.test(text) && /not found|does not exist|not a valid|unknown|no endpoints/i.test(text));
  if (notFound) return { message: m.httpModelNotFound(model, runtime.baseUrl, status, tail), retryable: false };
  return { message: m.httpStatus(status, tail), retryable: status >= 500 || status === 408 };
}

export function createHttpDriver(runtime: HttpRuntime): ParticipantDriver {
  const fail = (kind: "call_error" | "timeout", message: string, retryable: boolean) =>
    new ParticipantCallError(kind, redact(message, runtime), retryable);
  return {
    async call(request: TurnRequest): Promise<TurnResult> {
      const model = request.participant.model;
      if (runtime.apiKeyEnv && !runtime.apiKey) {
        throw fail("call_error", providerMessages().httpKeyUnset(runtime.apiKeyEnv, runtime.keyFile), false);
      }
      const classified = (status: number, body: string) => {
        const f = classifyHttpFailure({ status, body, model, runtime });
        return fail("call_error", f.message, f.retryable);
      };
      let text = "";
      let usage: Json | undefined;
      const take = (obj: Json) => { if (isObj(obj.usage)) usage = obj.usage; };
      try {
        const res = await fetch(`${runtime.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders(runtime) },
          body: JSON.stringify({ model, messages: [{ role: "user", content: request.prompt }], stream: true, stream_options: { include_usage: true } }),
          signal: request.signal,
        });
        if (!res.ok) throw classified(res.status, await res.text());
        if ((res.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
          const parser = createSseParser((d) => {
            const ev = parseJson(d);
            if (!isObj(ev)) return;
            if (ev.error !== undefined) throw classified(isObj(ev.error) && typeof ev.error.code === "number" ? ev.error.code : 502, d);
            take(ev);
            const choice = Array.isArray(ev.choices) ? ev.choices[0] : undefined;
            const content = isObj(choice) && isObj(choice.delta) ? choice.delta.content : undefined;
            if (typeof content === "string" && content) { text += content; request.onChunk(content); }
          });
          const reader = res.body?.getReader();
          try {
            while (reader && !parser.done) {
              const { done, value } = await reader.read();
              if (done) break;
              parser.write(value);
            }
            parser.end();
          } finally { await reader?.cancel().catch(() => {}); }
        } else {
          const data = parseJson(await res.text());
          if (isObj(data)) {
            take(data);
            const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
            const content = isObj(choice) && isObj(choice.message) ? choice.message.content : undefined;
            if (typeof content === "string" && content.trim()) { text = content; request.onChunk(content); }
          }
        }
      } catch (e) {
        if (request.signal.aborted) throw fail("timeout", providerMessages().httpAborted, true);
        if (e instanceof ParticipantCallError) throw e;
        const err = e as Error & { cause?: { code?: unknown; message?: unknown } };
        const why = [err.cause?.code, err.cause?.message, err.message].find((v) => typeof v === "string" && v) as string;
        throw fail("call_error", providerMessages().httpUnreachable(runtime.baseUrl, why), true);
      }
      if (!text.trim()) throw fail("call_error", providerMessages().httpNoText, true);
      const inputTokens = tokens(usage?.prompt_tokens);
      const outputTokens = tokens(usage?.completion_tokens);
      const cost = usage?.cost;
      const result: Usage = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(typeof cost === "number" && cost >= 0 ? { costUsd: cost } : {}),
      };
      return { text, usage: result };
    },
  };
}
