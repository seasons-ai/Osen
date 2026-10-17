import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import { isPublicAddress } from "./address.ts";
import { materialsMessages } from "../messages/materials.ts";

export const URL_LIMITS = { ms: 15_000, redirects: 3, bytes: 2 * 2 ** 20 } as const;
export const URL_REQUEST_HEADERS = { accept: "text/html, text/plain, text/markdown", "accept-encoding": "identity", "user-agent": "model-council" } as const;
export const URL_TEXT_TYPES = ["text/plain", "text/markdown", "text/html"] as const;

export interface UrlAddress { address: string; family: 4 | 6 }
export interface UrlResponse { status: number; headers: IncomingHttpHeaders; body: AsyncIterable<Uint8Array>; destroy(): void }
export interface UrlTransport {
  resolve(hostname: string): Promise<readonly UrlAddress[]>;
  /** Request to an already checked address; Host and SNI come from url. */
  request(url: URL, address: UrlAddress, signal: AbortSignal): Promise<UrlResponse>;
}

export const nodeTransport: UrlTransport = {
  async resolve(hostname) {
    const found = await dns.promises.lookup(hostname, { all: true });
    return found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
  },
  request(url, address, signal) {
    return new Promise((resolve, reject) => {
      const lookup = ((_host: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) => {
        if (options?.all) cb(null, [{ address: address.address, family: address.family }]);
        else cb(null, address.address, address.family);
      }) as unknown as http.RequestOptions["lookup"];
      const make = url.protocol === "https:" ? https.request : http.request;
      const req = make(url, { method: "GET", headers: { ...URL_REQUEST_HEADERS }, agent: false, signal, lookup }, (res) =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, destroy: () => { res.destroy(); req.destroy(); } }),
      );
      req.on("error", reject);
      req.end();
    });
  },
};

export type UrlFailureCode = "invalid" | "scheme" | "credentials" | "dns" | "private" | "redirects" | "redirect" | "status" | "encoding" | "type" | "size" | "timeout" | "network";

export class UrlFetchError extends Error {
  override name = "UrlFetchError";
  readonly code: UrlFailureCode;
  readonly reason: string;
  constructor(code: UrlFailureCode, reason: string) {
    super(reason);
    this.code = code;
    this.reason = reason;
  }
}

export interface FetchedUrl { url: URL; bytes: Buffer; contentType: (typeof URL_TEXT_TYPES)[number]; charset: string | undefined }
export interface FetchUrlOptions { transport?: UrlTransport; limits?: { ms?: number; redirects?: number; bytes?: number }; deadline?: number }

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const clean = (v: string) => v.replace(/[^A-Za-z0-9._/+-]/g, "").slice(0, 40);
const fail = (code: UrlFailureCode, reason: string) => new UrlFetchError(code, reason);
const msg = materialsMessages;

function checkUrl(raw: string, base?: string): URL {
  let url: URL;
  try { url = new URL(raw, base); } catch { throw fail("invalid", msg().urlInvalid); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("scheme", msg().urlScheme);
  if (url.username || url.password) throw fail("credentials", msg().urlCredentials);
  return url;
}

export async function fetchUrl(raw: string, options: FetchUrlOptions = {}): Promise<FetchedUrl> {
  const transport = options.transport ?? nodeTransport;
  const limits: Record<keyof typeof URL_LIMITS, number> = { ...URL_LIMITS, ...options.limits };
  const requested = checkUrl(raw);
  const controller = new AbortController();
  const timeoutError = () => fail("timeout", msg().urlFetchTimeout(limits.ms / 1000));
  let current: UrlResponse | undefined;
  let timer: NodeJS.Timeout | undefined;
  let onTimeout: (e: UrlFetchError) => void = () => {};
  const expired = new Promise<never>((_, rej) => { onTimeout = rej; });
  expired.catch(() => {});
  timer = setTimeout(() => { onTimeout(timeoutError()); controller.abort(); current?.destroy(); }, Math.max(0, (options.deadline ?? Date.now() + limits.ms) - Date.now()));
  const race = <T>(p: Promise<T>) => Promise.race([p, expired]);
  try {
    let url = requested;
    for (let hop = 0; ; hop++) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      let addresses: readonly UrlAddress[];
      if (isIP(host)) addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
      else {
        try { addresses = await race(transport.resolve(host)); } catch (e) { if (e instanceof UrlFetchError) throw e; throw fail("dns", msg().urlDns); }
        if (!addresses.length) throw fail("dns", msg().urlDns);
      }
      const bad = addresses.find((a) => !isPublicAddress(a.address));
      if (bad) throw fail("private", hop === 0 ? msg().urlPrivate(bad.address) : msg().urlPrivateRedirect(bad.address));
      const res = await race(transport.request(url, addresses[0]!, controller.signal));
      current = res;
      if (REDIRECTS.has(res.status)) {
        res.destroy();
        const loc = res.headers.location;
        let next: URL;
        try { if (!loc) throw fail("invalid", ""); next = checkUrl(loc, url.href); } catch (e) {
          if (e instanceof UrlFetchError && e.code !== "invalid") throw e;
          throw fail("redirect", msg().urlRedirectBad);
        }
        if (hop >= limits.redirects) throw fail("redirects", msg().urlRedirects(limits.redirects));
        url = next;
        continue;
      }
      if (res.status !== 200) throw fail("status", msg().urlStatus(res.status));
      const enc = res.headers["content-encoding"];
      if (enc && enc.trim().toLowerCase() !== "identity") throw fail("encoding", msg().urlEncoding(clean(enc)));
      const [mimeRaw = "", ...params] = (res.headers["content-type"] ?? "").split(";");
      const mime = mimeRaw.trim().toLowerCase();
      const contentType = URL_TEXT_TYPES.find((t) => t === mime);
      if (!contentType) throw fail("type", msg().urlType(mime ? clean(mime) : undefined));
      const charset = params.map((p) => /^\s*charset\s*=\s*(.*?)\s*$/i.exec(p)?.[1]).find((c) => c !== undefined)?.replace(/^"|"$/g, "").toLowerCase() || undefined;
      const tooBig = () => fail("size", msg().urlSize(limits.bytes));
      const length = Number(res.headers["content-length"]);
      if (res.headers["content-length"] !== undefined && length > limits.bytes) throw tooBig();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const it = res.body[Symbol.asyncIterator]();
      for (;;) {
        const step = await race(it.next());
        if (step.done) break;
        total += step.value.length;
        if (total > limits.bytes) throw tooBig();
        chunks.push(step.value);
      }
      return { url: requested, bytes: Buffer.concat(chunks), contentType, charset };
    }
  } catch (e) {
    if (e instanceof UrlFetchError) throw e;
    const code = (e as { code?: unknown } | null)?.code;
    throw fail("network", msg().urlNetwork(typeof code === "string" ? clean(code) : undefined));
  } finally {
    clearTimeout(timer);
    current?.destroy();
  }
}
