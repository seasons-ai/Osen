import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliOutput, parseClaudeOutput, parseCodexOutput } from "./output-parse.ts";
import { type TurnFixture, listTurnFixtures } from "./turn-fixtures.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rnd = () => number;
type Json = Record<string, unknown>;
const CASES = 500;
// Tool item kinds are set by the requirement, not taken from the parser.
const TOOL_KINDS = ["command_execution", "mcp_tool_call", "web_search", "file_change"];

const int = (rnd: Rnd, n: number) => Math.floor(rnd() * n);
const pick = <T>(rnd: Rnd, xs: readonly T[]): T => xs[int(rnd, xs.length)]!;
const id = (rnd: Rnd) => int(rnd, 1e9).toString(36);

const PIECES = ["", " ", "a", "Привет, мир", "😀🚀👨‍👩‍👧", "é́́ ä", "שלום עולם ‮ abc ‏", "\u0000\u001f\"\\/'`", "{\"type\":\"error\"}", "null", "x"];
function str(rnd: Rnd, lineSafe = false): string {
  let s = Array.from({ length: int(rnd, 4) }, () => pick(rnd, PIECES)).join("");
  if (rnd() < 0.05) s = (s || "z").repeat(Math.ceil(10_000 / (s || "z").length) + int(rnd, 50));
  return lineSafe ? s.replace(/[\n\r]/g, " ") : s;
}

function value(rnd: Rnd, depth = 0): unknown {
  const k = int(rnd, depth >= 5 ? 6 : 8);
  if (k === 0) return str(rnd);
  if (k === 1) return pick(rnd, [0, -1, 1, 3.14, 1e21, -0, Number.MAX_SAFE_INTEGER, 1e-7]);
  if (k === 2) return null;
  if (k === 3) return rnd() < 0.5;
  if (k === 4) return "";
  if (k === 5) return int(rnd, 100);
  if (k === 6) return Array.from({ length: int(rnd, 4) }, () => value(rnd, depth + 1));
  return unknownFields(rnd, depth + 1);
}

const UNICODE_KEYS = ["поле", "😀", "ключ́", "מפתח", ""];
function unknownFields(rnd: Rnd, depth = 0): Json {
  const o: Json = {};
  for (let i = int(rnd, 4); i > 0; i--) o[rnd() < 0.2 ? pick(rnd, UNICODE_KEYS) : `x_${id(rnd)}`] = value(rnd, depth);
  return o;
}

/** Adds unknown fields (never a key the parser reads) to the object itself and to its `item` and `usage`. */
function decorate(rnd: Rnd, ev: Json): void {
  if (rnd() < 0.6) Object.assign(ev, unknownFields(rnd));
  for (const k of ["item", "usage"]) {
    const sub = ev[k];
    if (typeof sub === "object" && sub !== null && !Array.isArray(sub) && rnd() < 0.6) Object.assign(sub, unknownFields(rnd));
  }
}

/** Position 0 and n are over-weighted: first and last lines are the edge cases. */
const where = (rnd: Rnd, n: number) => (rnd() < 0.25 ? 0 : rnd() < 0.33 ? n : int(rnd, n + 1));
const noiseLine = (rnd: Rnd) => (rnd() < 0.2 ? "" : `${pick(rnd, ["WARN", "ERROR:", "note", "Z"])} ${str(rnd, true)}`);
const nonStringType = (rnd: Rnd) => pick(rnd, [5, null, true, ["error"], { a: 1 }]);

interface Entry { line: string; tool?: string }

function unknownCodexEvent(rnd: Rnd): Json {
  if (rnd() < 0.4) return { type: `x.${id(rnd)}`, ...unknownFields(rnd) };
  if (rnd() < 0.15) return { type: nonStringType(rnd), ...unknownFields(rnd) };
  const itemType = rnd() < 0.2 ? undefined : rnd() < 0.2 ? 7 : `x_item_${id(rnd)}`;
  const item: unknown = rnd() < 0.1 ? pick(rnd, [null, "agent_message", [1]]) : {
    id: `item_${id(rnd)}`, ...(itemType === undefined ? {} : { type: itemType }),
    ...(rnd() < 0.5 ? { text: str(rnd) } : {}), ...unknownFields(rnd),
  };
  return { type: pick(rnd, ["item.started", "item.completed"]), item };
}

/** Base lines with unknown fields, plus unknown events and non-JSON lines inserted at random positions. */
function noisyCodex(rnd: Rnd, lines: string[]): Entry[] {
  const entries: Entry[] = lines.map((l) => {
    const ev = JSON.parse(l) as Json;
    decorate(rnd, ev);
    return { line: JSON.stringify(ev) };
  });
  for (let i = 1 + int(rnd, 6); i > 0; i--) {
    const line = rnd() < 0.4 ? noiseLine(rnd) : JSON.stringify(unknownCodexEvent(rnd));
    entries.splice(where(rnd, entries.length), 0, { line });
  }
  return entries;
}

function badCodexEvent(rnd: Rnd): Entry {
  const k = int(rnd, 3);
  if (k === 0) return { line: JSON.stringify({ type: "error", message: str(rnd), ...(rnd() < 0.3 ? unknownFields(rnd) : {}) }) };
  if (k === 1) return { line: JSON.stringify({ type: `${rnd() < 0.2 ? "" : `x_${id(rnd)}`}.failed`, error: { message: str(rnd) }, ...(rnd() < 0.3 ? unknownFields(rnd) : {}) }) };
  const tool = pick(rnd, TOOL_KINDS);
  const item = { id: `item_${id(rnd)}`, type: tool, ...unknownFields(rnd) };
  return { line: JSON.stringify({ type: pick(rnd, ["item.started", "item.completed"]), item }), tool };
}

function noisyClaude(rnd: Rnd, result: Json): string {
  decorate(rnd, result);
  const events = (): unknown[] => Array.from({ length: int(rnd, 4) }, () => {
    const r = rnd();
    if (r < 0.1) return value(rnd);
    return { type: r < 0.2 ? nonStringType(rnd) : r < 0.5 ? pick(rnd, ["system", "assistant"]) : `x.${id(rnd)}`, ...unknownFields(rnd) };
  });
  const noise = () => Array.from({ length: int(rnd, 3) }, () => noiseLine(rnd));
  const form = int(rnd, 4);
  if (form === 0) return JSON.stringify(result) + (rnd() < 0.5 ? "\n" : "");
  if (form === 1) return [...noise(), JSON.stringify(result), ...noise()].join("\n");
  if (form === 2) return JSON.stringify([...events(), result, ...events()]);
  // one JSON document per line, with noise lines in between
  const docs = [...events().map((e) => JSON.stringify(e)), JSON.stringify(result), ...events().map((e) => JSON.stringify(e))];
  return docs.flatMap((d) => [...noise(), d]).join("\n");
}

const fixtures = listTurnFixtures().map((f) => ({ f, text: readFileSync(f.file, "utf8") }));
const parse = (f: TurnFixture, stdout: string): CliOutput =>
  f.agent === "claude" ? parseClaudeOutput(stdout, f.version) : parseCodexOutput(stdout, f.version);
const codexLines = (text: string) => text.split("\n").filter((l) => l.trim() !== "");

describe("CLI output parsing", () => {
  it("has turn fixtures for both agents", () => {
    expect(new Set(fixtures.map((x) => x.f.agent))).toEqual(new Set(["claude", "codex"]));
  });

  it(`Unknown in CLI output is skipped (property, ${CASES} cases): unknown fields, events, items and non-JSON lines do not change the result`, () => {
    for (const { f, text } of fixtures) {
      const base = parse(f, text);
      expect(base.ok, basename(f.file)).toBe(true);
      for (let seed = 1; seed <= CASES; seed++) {
        const rnd = mulberry32(seed);
        const stdout = f.agent === "claude"
          ? noisyClaude(rnd, JSON.parse(text) as Json)
          : noisyCodex(rnd, codexLines(text)).map((e) => e.line).join("\n") + (rnd() < 0.5 ? "\n" : "");
        expect(parse(f, stdout), `seed ${seed} ${basename(f.file)}`).toEqual(base);
      }
    }
  });

  it(`Errors and isolation events are not ignored (property, ${CASES} cases): is_error, error events, .failed events and tool items give a refusal`, () => {
    for (const { f, text } of fixtures) {
      for (let seed = 1; seed <= CASES; seed++) {
        const rnd = mulberry32(seed);
        const where_ = `seed ${seed} ${basename(f.file)}`;
        if (f.agent === "claude") {
          const result = JSON.parse(text) as Json;
          result.is_error = rnd() < 0.4 ? true : pick(rnd, ["true", "", str(rnd), 1, 0, null, { a: true }, [true]]);
          const out = parse(f, noisyClaude(rnd, result));
          expect(out.ok, where_).toBe(false);
        } else {
          const entries = noisyCodex(rnd, codexLines(text));
          for (let i = 1 + int(rnd, 3); i > 0; i--) entries.splice(where(rnd, entries.length), 0, badCodexEvent(rnd));
          const out = parse(f, entries.map((e) => e.line).join("\n") + (rnd() < 0.5 ? "\n" : ""));
          expect(out.ok, where_).toBe(false);
          if (!out.ok) expect(out.toolCall, where_).toBe(entries.find((e) => e.tool)?.tool);
        }
      }
    }
  });
});
