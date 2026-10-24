// Live check of change 255 (real council processes against the in-process fake server, 0 model calls):
//   COUNCIL_DEV=1 node packages/core/scenarios/http-url-limits/check.ts
// 1. "Логин и пароль в адресе": provider `bad` has baseUrl http://user:SECRETPASS@<fake A>/v1, provider `good` points at fake B.
//    `council providers` and `--json` on en and ru: `bad` unavailable with a reason naming `bad` and `baseUrl`, no SECRETPASS
//    and no address of A, `good` available; a session with bad:fake-agree exits 2 with the same reason; fake A gets no request;
//    config.json is unchanged. After removing the userinfo `bad` is available.
// 2. "Строковый код лимита в потоке": fake-midstream-rate is recorded as a rate limit with one retry, no "HTTP 502".
// 3. fake-rate (429), fake-midstream-error (numeric 502) and fake-error (500) keep their texts.
// The stand creates .council-data/http-url-limits-* itself and deletes it on success.
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startFakeServer } from "../../src/http/fake-server.ts";

if (process.env.COUNCIL_DEV !== "1") { console.error("COUNCIL_DEV=1 is required"); process.exit(2); }
const repo = resolve(import.meta.dirname, "../../../..");
const council = join(repo, "packages/core/src/council.ts");
const work = join(repo, ".council-data", `http-url-limits-${Date.now()}`);
mkdirSync(work, { recursive: true });
const run = promisify(execFile);

let total = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n       ${detail.slice(0, 600)}` : ""}`);
}
async function cli(home: string, lang: string, args: string[]) {
  const p = run(process.execPath, [council, ...args], { timeout: 60_000, env: { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: home, COUNCIL_LANG: lang } });
  p.child.stdin?.end();
  try { const { stdout, stderr } = await p; return { code: 0, out: stdout + stderr }; }
  catch (e) { const x = e as { code?: number; stdout?: string; stderr?: string }; return { code: x.code ?? -1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` }; }
}
const events = (home: string): string => readdirSync(join(home, "sessions")).map((id) => readFileSync(join(home, "sessions", id, "events.jsonl"), "utf8")).join("");

const a = await startFakeServer();
const b = await startFakeServer();
try {
  const secretUrl = a.url.replace("http://", "http://user:SECRETPASS@");
  const config = (badUrl: string) => JSON.stringify({
    providers: [
      { id: "bad", kind: "openai-http", label: "Bad", models: [], baseUrl: badUrl, apiKeyEnv: "" },
      { id: "good", kind: "openai-http", label: "Good", models: [], baseUrl: b.url, apiKeyEnv: "" },
    ],
    defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, participants: [] },
  }, null, 2);
  const leaks = (out: string) => ["SECRETPASS", "user:", a.url.replace("http://", "")].filter((s) => out.includes(s));

  // ---------- 1. userinfo in baseUrl ----------
  const home1 = join(work, "userinfo");
  mkdirSync(home1);
  writeFileSync(join(home1, "config.json"), config(secretUrl));
  const before = readFileSync(join(home1, "config.json"), "utf8");
  for (const [lang, word] of [["en", "login or password"], ["ru", "логин или пароль"]] as const) {
    const text = await cli(home1, lang, ["providers"]);
    const badLine = text.out.split("\n").find((l) => l.startsWith("bad ")) ?? "";
    const goodLine = text.out.split("\n").find((l) => l.startsWith("good ")) ?? "";
    console.log(`       ${lang} providers: ${badLine}`);
    check(`${lang}: council providers — bad unavailable with the reason, good available, no secret`,
      text.code === 0 && badLine.includes("baseUrl") && badLine.includes(word) && goodLine.includes(b.url) && leaks(text.out).length === 0, text.out);
    const json = await cli(home1, lang, ["providers", "--json"]);
    const parsed = JSON.parse(json.out) as { providers: Array<{ id: string; available: boolean; reason: string | null; baseUrl: string | null }> };
    const bad = parsed.providers.find((p) => p.id === "bad");
    const good = parsed.providers.find((p) => p.id === "good");
    check(`${lang}: council providers --json — bad unavailable, baseUrl null, good available, no secret`,
      json.code === 0 && bad?.available === false && bad.baseUrl === null && !!bad.reason?.includes("bad") && !!bad.reason.includes("baseUrl")
        && good?.available === true && leaks(json.out).length === 0, json.out);
    const start = await cli(home1, lang, ["--topic", "x", "--participant", "bad:fake-agree", "--participant", "good:fake-agree", "--max-rounds", "1"]);
    console.log(`       ${lang} start: exit ${start.code}: ${start.out.trim().split("\n")[0]}`);
    check(`${lang}: session with bad exits 2 with the same reason, no secret, no session`,
      start.code === 2 && start.out.includes("baseUrl") && start.out.includes(word) && leaks(start.out).length === 0 && readdirSync(join(home1, "sessions")).length === 0, start.out);
  }
  check("fake A (the userinfo address) got no request", a.requests.length === 0, JSON.stringify(a.requests));
  check("config.json unchanged", readFileSync(join(home1, "config.json"), "utf8") === before);
  writeFileSync(join(home1, "config.json"), config(a.url));
  const fixed = await cli(home1, "en", ["providers"]);
  check("baseUrl without userinfo: bad available", (fixed.out.split("\n").find((l) => l.startsWith("bad ")) ?? "").includes(`available  ${a.url}`), fixed.out);

  // ---------- 2. string rate-limit code in the stream; 3. previous modes ----------
  for (const [model, expected] of [
    ["fake-midstream-rate", "Request limit exceeded (rate_limit_exceeded): Rate limit exceeded"],
    ["fake-rate", "Request limit exceeded (HTTP 429): Rate limit exceeded"],
    ["fake-midstream-error", "The endpoint answered HTTP 502: Provider returned error"],
    ["fake-error", "The endpoint answered HTTP 500: Internal server error"],
  ] as const) {
    const home = join(work, model);
    mkdirSync(home);
    writeFileSync(join(home, "config.json"), config(a.url));
    const r = await cli(home, "en", ["--topic", "x", "--participant", `good:${model}`, "--participant", "good:fake-agree", "--max-rounds", "1"]);
    const failures = events(home).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; attempt?: number; message?: string }).filter((e) => e.type === "turn_failed");
    console.log(`       ${model}: ${failures.map((f) => `attempt ${f.attempt}: ${f.message}`).join(" | ")}`);
    const noFake502 = model !== "fake-midstream-error" ? !r.out.includes("HTTP 502") && !events(home).includes("HTTP 502") : true;
    check(`${model}: two attempts (one retry) recorded as «${expected}»`,
      failures.length === 2 && failures.every((f) => f.message === expected) && failures.map((f) => f.attempt).join() === "1,2" && noFake502, r.out);
  }
} finally {
  await Promise.all([a.close(), b.close()]);
}

console.log(`${failed ? "FAIL" : "PASS"} 255 HTTP provider URL and limits: ${total - failed}/${total} checks`);
if (failed) { console.log(`       data kept in ${work}`); process.exit(1); }
rmSync(work, { recursive: true, force: true });
