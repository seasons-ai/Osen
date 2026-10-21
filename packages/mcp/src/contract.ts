// MCP contract of the osen server: pinned protocol version, exact SDK pin and the shapes of tool responses.
// Shared by contract.test.ts and the stand packages/mcp/scenarios/contract/check.ts.
//
// Normalization rules (normalize): a response keeps its keys, nesting, array order and isError strictly;
// only unstable values are replaced by type markers, everything else (free text included) is compared as is.
// A key-based marker is set only when the value has the expected type; a value of another type is left as is,
// so the type difference shows up in the comparison.
//   - key sessionId (string)                                  -> "<sessionId>"
//   - keys requestId, waitId, planToken, questionId (string)  -> "<token>" (null stays null)
//   - keys deadline, selectedAt, createdAt, ts (string)       -> "<time>"
//   - key pid, or ending in Pid (number)                      -> "<pid>"
//   - keys ending in Ms, and keys elapsed, duration (number)  -> "<duration>"
//   - inside any string: a session id (20200101-000000-xxxx or a UUID) -> "<sessionId>", an ISO timestamp -> "<time>",
//     an absolute path (starts with "/" or a drive letter, not preceded by a word character; spaces only inside directory names) -> "<path>";
//     the rest of the string stays
//   - numbers, booleans, null stay unless a key rule above applies
//   - council_options: each list keeps its first element only, with its values reduced to types (lists are data)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// A literal on purpose: never the latest-version constant exported by the SDK, otherwise an SDK shift silently moves the reference.
export const EXPECTED_PROTOCOL_VERSION = "2025-11-25";
export const UNKNOWN_PROTOCOL_VERSION = "1900-01-01";

export type Finding = { check: string; ok: boolean; detail: string };

// ---- protocol ----

type Init = { protocolVersion?: unknown; name?: unknown; error?: string };

// One initialize over a real stdio server; the child is ended (stdin closed, then forced after 2 s) before resolving.
function initialize(root: string, env: Record<string, string>, version: string): Promise<Init> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "packages/mcp/src/main.ts")], { cwd: root, env, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    let done = false;
    let exited = false;
    let onExit: (() => void) | null = null;
    // subscribed before anything is written: a process that exits early must not leave finish() waiting for an event that already fired
    child.once("exit", (code, signal) => {
      exited = true;
      onExit?.();
      finish({ error: `server exited with ${code === null ? `signal ${String(signal)}` : `code ${code}`} before answering initialize` });
    });
    const finish = (r: Init): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (exited) return resolve(r);
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      onExit = () => { clearTimeout(force); resolve(r); };
      child.stdin.end();
    };
    const timer = setTimeout(() => finish({ error: "no initialize response in 15 s" }), 15_000);
    // a process that never started (no cwd, no binary) emits "error" and no "exit"
    child.on("error", (e) => { if (child.pid === undefined) exited = true; finish({ error: e.message }); });
    child.stdin.on("error", () => { /* EPIPE: the exit handler reports it */ });
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        try {
          const m = JSON.parse(line) as { id?: number; result?: { protocolVersion?: unknown; serverInfo?: { name?: unknown } } };
          if (m.id === 1 && m.result) return finish({ protocolVersion: m.result.protocolVersion, name: m.result.serverInfo?.name });
        } catch { /* partial line */ }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "contract", version: "0" } } }) + "\n");
  });
}

export async function checkProtocol(root: string, env: Record<string, string>): Promise<Finding[]> {
  const known = await initialize(root, env, EXPECTED_PROTOCOL_VERSION);
  const unknown = await initialize(root, env, UNKNOWN_PROTOCOL_VERSION);
  const verdict = (check: string, r: Init): Finding => r.error
    ? { check, ok: false, detail: r.error }
    : { check, ok: r.protocolVersion === EXPECTED_PROTOCOL_VERSION, detail: `expected ${EXPECTED_PROTOCOL_VERSION}, got ${String(r.protocolVersion)}` };
  return [
    verdict("protocol", known),
    verdict("protocol (unknown client version)", unknown),
    { check: "server name", ok: known.name === "osen", detail: `expected osen, got ${String(known.name)}` },
  ];
}

// ---- SDK pin ----

export function checkSdkPin(root: string): Finding[] {
  const pkg = JSON.parse(readFileSync(join(root, "packages/mcp/package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
  const out: Finding[] = [];
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (!name.startsWith("@modelcontextprotocol/")) continue;
    const locked = lock.packages[`node_modules/${name}`]?.version;
    const exact = /^\d+\.\d+\.\d+$/.test(range);
    out.push({ check: `sdk pin ${name}`, ok: exact && range === locked, detail: !exact ? `${name} is "${range}", expected an exact version without a range` : `${name} is ${range}, lock file has ${String(locked)}` });
  }
  if (out.length === 0) out.push({ check: "sdk pin", ok: false, detail: "no @modelcontextprotocol/* dependency in packages/mcp/package.json" });
  return out;
}

// ---- normalization and comparison ----

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_ID = `\\d{8}-\\d{6}-[A-Za-z0-9]+|${UUID}`;
const ISO_TIME = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})?";
// A directory name may contain spaces (a data folder like "Мозговой штурм"), the last name of a path may not, so the wording after a path is compared.
// ponytail: a last name with a space ("/a/my file") is masked only up to the space, and "word/" after a spaced name ("/tmp/ok and/or x") is taken as a directory;
// both are ambiguous without knowing the real folders, and no response embeds a path today. Pass the data folder to normalize if that changes
const SEG = "[^\\s/\\\\\"'`<>]+";
const ABS_PATH = `(?<![\\p{L}\\p{N}_.~-])(?:/|[A-Za-z]:[\\\\/])(?:${SEG}(?: +${SEG})*[\\\\/])*(?:${SEG})?`;
const EMBEDDED: [RegExp, string][] = [
  [new RegExp(`\\b(?:${SESSION_ID})\\b`, "g"), "<sessionId>"],
  [new RegExp(ISO_TIME, "g"), "<time>"],
  [new RegExp(ABS_PATH, "gu"), "<path>"],
];
const NUMERIC_MARKERS = new Set(["<pid>", "<duration>"]);
const TOKEN_KEYS = new Set(["requestId", "waitId", "planToken", "questionId"]);
const TIME_KEYS = new Set(["deadline", "selectedAt", "createdAt", "ts"]);

function marker(key: string, v: unknown): string | null {
  if (typeof v === "number") return key === "pid" || key.endsWith("Pid") ? "<pid>" : key.endsWith("Ms") || key === "elapsed" || key === "duration" ? "<duration>" : null;
  if (typeof v !== "string") return null;
  if (key === "sessionId") return "<sessionId>";
  if (TOKEN_KEYS.has(key)) return "<token>";
  if (TIME_KEYS.has(key)) return "<time>";
  return EMBEDDED.reduce((t, [re, m]) => t.replace(re, m), v);
}

export function normalize(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((x) => normalize(x, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalize(v, k)]));
  }
  return marker(key, value) ?? value;
}

const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export function shapeDiff(label: string, expected: unknown, actual: unknown, path = ""): string[] {
  const at = path === "" ? "value" : path;
  const ke = kind(expected);
  const ka = kind(actual);
  // a numeric marker stands for a number: name both types instead of a bare value difference
  if (typeof expected === "string" && NUMERIC_MARKERS.has(expected) && actual !== expected && ka !== "number") return [`${label}: type of ${at}: expected number (${expected}), got ${ka}`];
  if (ke !== ka) return [`${label}: type of ${at}: expected ${ke}, got ${ka}`];
  if (ke === "array") {
    const e = expected as unknown[];
    const a = actual as unknown[];
    const out = e.length !== a.length ? [`${label}: length of ${at}: expected ${e.length}, got ${a.length}`] : [];
    for (let i = 0; i < Math.min(e.length, a.length); i++) out.push(...shapeDiff(label, e[i], a[i], `${path}[${i}]`));
    return out;
  }
  if (ke === "object") {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const at2 = (k: string) => (path === "" ? k : `${path}.${k}`);
    const out: string[] = [];
    for (const k of Object.keys(e)) out.push(...(k in a ? shapeDiff(label, e[k], a[k], at2(k)) : [`${label}: key ${at2(k)} is missing`]));
    for (const k of Object.keys(a)) if (!(k in e)) out.push(`${label}: key ${at2(k)} is unexpected`);
    return out;
  }
  return expected === actual ? [] : [`${label}: value of ${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

// ---- snapshots ----

export const SNAPSHOTS = ["council_options", "council_start", "council_status-running", "council_say", "council_continue", "council_stop", "council_status-finished", "council_resume-plan"] as const;
export type SnapshotName = (typeof SNAPSHOTS)[number];
export const GOLDEN_DIR = join(import.meta.dirname, "__golden__/responses");

type Res = { isError?: boolean; content: { type: string; text: string }[] };

// council_options lists templates, providers and scenario files: data, not contract. Each list keeps only its first element,
// and inside a list element every value is its type ("<string>", "<number>", "<boolean>"; null stays): a new template or scenario changes nothing.
const typeOnly = (v: unknown): unknown =>
  Array.isArray(v) ? v.slice(0, 1).map(typeOnly)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeOnly(x)]))
    : v === null ? null : `<${typeof v}>`;
const firstOnly = (v: unknown): unknown =>
  Array.isArray(v) ? v.slice(0, 1).map(typeOnly)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, firstOnly(x)]))
    : v;

export async function collectResponses(client: Client): Promise<Record<SnapshotName, unknown>> {
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Res;
  const body = (r: Res): any => { try { return JSON.parse(r.content[0]!.text); } catch { return normalize(r.content[0]!.text); } };
  const snap = (r: Res) => normalize({ isError: r.isError === true, body: body(r) });
  // polls council_status (long wait, no snapshot) until pred holds
  const until = async (sessionId: string, pred: (s: any) => boolean): Promise<any> => {
    for (let i = 0; i < 20; i++) {
      const s = body(await call("council_status", { sessionId, waitSec: 5 }));
      if (pred(s)) return s;
    }
    throw new Error("the scripted session did not reach the expected state");
  };

  const options = await call("council_options");
  // Scenario contract/p1 amends and contract/p2 objects every round: no consensus, a pause after each round.
  const start = await call("council_start", {
    topic: "Cat name", participants: ["contract/p1.json", "contract/p2.json"].map((model) => ({ providerId: "scripted", model })),
    maxRounds: 3, pauseAfterRound: true, ownerWaitSec: 600,
  });
  const { sessionId } = body(start);
  const first = await until(sessionId, (s) => s.waiting !== null && s.round >= 1);
  // a call without waitSec: wait.changed is false, the response does not depend on timing
  const running = await call("council_status", { sessionId });
  const say = await call("council_say", { sessionId, text: "Prefer short names" });
  const cont = await call("council_continue", { sessionId, waitId: first.waiting.waitId });
  await until(sessionId, (s) => s.waiting !== null && s.waiting.waitId !== first.waiting.waitId);
  const stop = await call("council_stop", { sessionId });
  // the finished council_status is the stopped session (it keeps a current solution and the stats block)
  const finished = await call("council_status", { sessionId });
  const plan = await call("council_resume", { sessionId });
  return {
    council_options: firstOnly(snap(options)), council_start: snap(start), "council_status-running": snap(running), council_say: snap(say),
    council_continue: snap(cont), council_stop: snap(stop), "council_status-finished": snap(finished), "council_resume-plan": snap(plan),
  };
}

export function compareWithGolden(snapshots: Record<string, unknown>, dir = GOLDEN_DIR): string[] {
  const out: string[] = [];
  for (const name of SNAPSHOTS) {
    const file = join(dir, `${name}.json`);
    if (!existsSync(file)) { out.push(`${name}: golden file ${file} is missing`); continue; }
    out.push(...shapeDiff(name, JSON.parse(readFileSync(file, "utf8")), snapshots[name]));
  }
  return out;
}

// The reference is updated only by a dedicated change; contract.test.ts calls this under UPDATE_MCP_GOLDEN=1.
export function writeGolden(snapshots: Record<string, unknown>, dir = GOLDEN_DIR): void {
  mkdirSync(dir, { recursive: true });
  for (const name of SNAPSHOTS) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(snapshots[name], null, 2)}\n`);
}
