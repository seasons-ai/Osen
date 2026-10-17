#!/usr/bin/env node
// Stand service entry: like council.ts, but with a substitute link transport (a DNS table and routes to local ports).
// The production council.ts entry never passes a transport; this file lives only in the scenarios folder.
import "../language-ru.ts";
import { appendFileSync } from "node:fs";
import http from "node:http";
import { main } from "../../src/cli.ts";
import { loadEnv } from "../../src/store/env.ts";
import { URL_REQUEST_HEADERS } from "../../src/url/fetch.ts";
import type { UrlTransport } from "../../src/url/fetch.ts";

const raw = process.env.URL_STAND;
if (!raw) {
  console.error("The URL_STAND variable is not set (JSON with dns, routes, log): this is the stand service entry.");
  process.exit(2);
}
const stand = JSON.parse(raw) as { dns: Record<string, string[]>; routes: Record<string, number>; log: string };
const log = (o: object) => appendFileSync(stand.log, `${JSON.stringify(o)}\n`);

const urlTransport: UrlTransport = {
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

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), {
  stdout: console.log, stderr: console.error, env: loadEnv(process.env, process.cwd()), signal: controller.signal,
  chunk: (t) => process.stderr.write(t), urlTransport,
});
