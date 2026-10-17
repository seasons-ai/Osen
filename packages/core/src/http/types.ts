import { providerMessages } from "../messages/providers.ts";
/** Everything needed for requests to the HTTP endpoint: gathered when the provider is inspected, consumed by the driver. */
export interface HttpRuntime {
  baseUrl: string;      // without a trailing "/"
  apiKeyEnv?: string;   // name of the key variable; not set — requests without authorization
  apiKey?: string;      // key value: lives only inside the process, is not handed out
  keyFile: string;      // path of the .env file of the data folder — for error texts
}

export const authHeaders = (r: HttpRuntime): Record<string, string> => (r.apiKey ? { Authorization: `Bearer ${r.apiKey}` } : {});

/** Any text leaving the HTTP adapter (errors, reasons) goes through this function. */
export const redact = (text: string, r: HttpRuntime): string => (r.apiKey ? text.split(r.apiKey).join(providerMessages().hidden) : text);
