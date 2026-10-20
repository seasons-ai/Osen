import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliAgent } from "./types.ts";

/** Folder of the recorded (real or synthetic) turn outputs of the CLI versions. */
export const TURN_FIXTURE_DIR: string = fileURLToPath(new URL("./fixtures/", import.meta.url));

export function turnFixtureName(agent: CliAgent, version: string, synthetic: boolean): string {
  return `${agent}-${version}-turn${synthetic ? ".synthetic" : ""}.${agent === "claude" ? "json" : "jsonl"}`;
}

export interface TurnFixture { agent: CliAgent; version: string; synthetic: boolean; file: string }

const FIXTURE_NAME = /^(claude|codex)-(\d+\.\d+\.\d+)-turn(\.synthetic)?\.(json|jsonl)$/;

export function listTurnFixtures(dir: string = TURN_FIXTURE_DIR): TurnFixture[] {
  const found: TurnFixture[] = [];
  for (const name of readdirSync(dir).sort()) {
    const m = FIXTURE_NAME.exec(name);
    if (!m) continue;
    const agent = m[1] as CliAgent;
    if (m[4] !== (agent === "claude" ? "json" : "jsonl")) continue;
    found.push({ agent, version: m[2]!, synthetic: m[3] !== undefined, file: join(dir, name) });
  }
  return found;
}

/** Entries that have neither a real nor a synthetic fixture. */
export function missingTurnFixtures(
  entries: readonly { agent: CliAgent; version: string }[],
  fixtures: readonly TurnFixture[],
): { agent: CliAgent; version: string }[] {
  return entries
    .filter((e) => !fixtures.some((f) => f.agent === e.agent && f.version === e.version))
    .map((e) => ({ agent: e.agent, version: e.version }));
}

/** A valid participant reply that replaces every real answer in a fixture. */
export const NEUTRAL_REPLY = { stance: "agree", reasoning: "Anonymized reasoning.", solution: null, answers: [], questions: [], files: [] };

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const USER_PATH = /(?:\/Users|\/home)\/[^/\s"'<>]+/g;
const WIN_USER_PATH = /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"'<>]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const KEY = /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b|Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/g;

const KINDS: [string, RegExp][] = [["user path", USER_PATH], ["user path", WIN_USER_PATH], ["uuid", UUID], ["email", EMAIL], ["key", KEY]];

/** Kinds of personal data found in the text; an empty list means clean. */
export function findPersonalData(text: string): string[] {
  const kinds: string[] = [];
  for (const [kind, re] of KINDS) {
    re.lastIndex = 0;
    if (re.test(text) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const NEUTRAL_REASONING = "Anonymized reasoning.";

function neutralize(agent: CliAgent, ev: unknown): void {
  if (!isObj(ev)) return;
  if (agent === "claude" && ev.type === "result") {
    ev.result = JSON.stringify(NEUTRAL_REPLY);
    if ("structured_output" in ev) ev.structured_output = { ...NEUTRAL_REPLY };
  }
  if (agent === "codex" && (ev.type === "item.completed" || ev.type === "item.started") && isObj(ev.item)) {
    if (ev.item.type === "agent_message") ev.item.text = JSON.stringify(NEUTRAL_REPLY);
    else if (ev.item.type === "reasoning") ev.item.text = NEUTRAL_REASONING;
  }
}

function tryJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

/** Deterministic: the same raw output gives the same text. Non-JSON codex lines are dropped. */
export function anonymizeTurnOutput(agent: CliAgent, raw: string): string {
  const ids = new Map<string, number>();
  const scrub = (s: string): string =>
    s
      .replace(UUID, (id) => {
        const key = id.toLowerCase();
        if (!ids.has(key)) ids.set(key, ids.size + 1);
        return `<id-${ids.get(key)}>`;
      })
      .replace(USER_PATH, (p) => p.slice(0, p.indexOf("/", 1) + 1) + "<user>")
      .replace(WIN_USER_PATH, (p) => p.replace(/Users(\\{1,2})[^\\]+$/, "Users$1<user>"))
      .replace(EMAIL, "<email>")
      .replace(KEY, "<key>");
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const docs: unknown[] = [];
  const whole = agent === "claude" ? tryJson(raw) : undefined;
  if (whole !== undefined) docs.push(whole);
  else for (const line of raw.split("\n")) { const d = tryJson(line.trim()); if (d !== undefined) docs.push(d); }
  return docs.map((d) => {
    for (const ev of Array.isArray(d) ? d : [d]) neutralize(agent, ev);
    return JSON.stringify(walk(d)) + "\n";
  }).join("");
}
