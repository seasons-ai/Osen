import { z } from "zod";
import { providerMessages } from "../messages/providers.ts";
import { authHeaders, redact } from "./types.ts";
import type { HttpRuntime } from "./types.ts";

export interface HttpModels { models: string[]; confirmed: boolean; reason?: string; unavailable?: boolean }

const ModelsBody = z.object({ data: z.array(z.object({ id: z.unknown() })) });

/** Model list of the endpoint. Does not throw; the body text of the reply does not get into the reason. */
export async function listHttpModels(runtime: HttpRuntime, timeoutMs: number = 10_000): Promise<HttpModels> {
  const fail = (reason: string, unavailable = false): HttpModels => ({ models: [], confirmed: false, ...(unavailable ? { unavailable } : {}), reason: redact(reason, runtime) });
  let res: Response;
  try {
    res = await fetch(`${runtime.baseUrl}/models`, { headers: authHeaders(runtime), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    return fail(providerMessages().httpUnreachable(runtime.baseUrl, String(err.cause?.code ?? err.cause?.message ?? err.message)), true);
  }
  if (res.status === 401 || res.status === 403) {
    const m = providerMessages();
    const how = runtime.apiKeyEnv ? m.httpKeyHint(runtime.apiKeyEnv, runtime.keyFile) : m.httpKeyRequired;
    return fail(m.httpAuthDenied(res.status, how), true);
  }
  if (!res.ok) return fail(providerMessages().httpNoModelList(res.status));
  const body = ModelsBody.safeParse(await res.json().catch(() => undefined));
  if (!body.success) return fail(providerMessages().httpBadModelList);
  const models = body.data.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id !== "");
  return { models, confirmed: true };
}
