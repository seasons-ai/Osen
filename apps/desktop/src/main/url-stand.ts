import { appendFileSync } from "node:fs";
import http from "node:http";
import { URL_REQUEST_HEADERS } from "@model-council/core";
import type { UrlTransport } from "@model-council/core";

// A service seam only for the stand and the live window check (enabled by COUNCIL_DEV=1 and COUNCIL_URL_STAND in index.ts):
// a DNS table substitutes a public address, the request goes to a local port. The core address check is not replaced.
export function standTransport(raw: string): UrlTransport {
  const stand = JSON.parse(raw) as { dns: Record<string, string[]>; routes: Record<string, number>; log?: string };
  const log = (o: object) => { if (stand.log) appendFileSync(stand.log, `${JSON.stringify(o)}\n`); };
  return {
    async resolve(hostname) {
      log({ t: "resolve", host: hostname });
      const list = stand.dns[hostname];
      if (!list) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    request(url, address, signal) {
      log({ t: "request", host: url.host, path: url.pathname, address: address.address });
      const port = stand.routes[address.address];
      if (port === undefined) {
        log({ t: "unrouted", address: address.address });
        return Promise.reject(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
      }
      return new Promise((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: url.pathname + url.search, method: "GET", headers: { ...URL_REQUEST_HEADERS, host: url.host }, agent: false, signal },
          (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, destroy: () => { res.destroy(); req.destroy(); } }),
        );
        req.on("error", reject);
        req.end();
      });
    },
  };
}
