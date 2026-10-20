import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCliDriver } from "./driver.ts";
import { PARSE_BRANCHES, parseClaudeOutput, parseCodexOutput, selectBranch } from "./output-parse.ts";
import type { ParseBranch } from "./output-parse.ts";
import { ParticipantCallError } from "../participants/driver.ts";
import type { TurnRequest } from "../participants/driver.ts";
import { providerMessages } from "../messages/providers.ts";
import { setProcessLanguage } from "../i18n/process-language.ts";
import { declaredFlags, parseCodexFeatures } from "./flags.ts";
import type { CliAgent, CliRuntime } from "./types.ts";

beforeAll(() => setProcessLanguage("ru"));
const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const codexFlags = declaredFlags(fx("codex-0.159.2-exec-help.txt"));
const codexFeatures = parseCodexFeatures(fx("codex-0.159.2-features.txt"));

const claudeOut = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "text", ...extra });
const codexOut = (...evs: unknown[]) => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";
const msg = (text: unknown) => ({ type: "item.completed", item: { id: "i", type: "agent_message", text } });
const done = () => ({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 7 } });
const good = codexOut({ type: "thread.started", thread_id: "t" }, msg("b"), done());
const goodResult = { ok: true, text: "b", usage: { inputTokens: 100, outputTokens: 7 } };
const diag = (o: { ok: boolean; diagnostic?: string }) => (o.ok ? "" : o.diagnostic ?? "");

describe("Versioned parsing", () => {
  const b = (id: string, from: string, to: string): ParseBranch => ({ agent: "claude", id, from, to, parse: () => ({ ok: false, diagnostic: id }) });
  const table = [b("c", "3.0.0", "3.1.0"), b("a", "1.0.0", "1.9.9"), b("b", "2.0.0", "2.5.0"), { ...b("x", "0.0.0", "99.0.0"), agent: "codex" as const }];
  const pick = (v: string | undefined) => selectBranch("claude", v, table).id;

  it("Versioned parsing: version inside a range selects that branch", () => {
    expect([pick("1.5.0"), pick("2.0.0"), pick("2.5.0"), pick("3.1.0")]).toEqual(["a", "b", "b", "c"]);
  });
  it("Versioned parsing: version between ranges selects the nearest lower branch", () => {
    expect([pick("2.6.0"), pick("1.10.0")]).toEqual(["b", "a"]);
  });
  it("Versioned parsing: newer than all selects the last, older than all the oldest", () => {
    expect([pick("9.0.0"), pick("0.5.0")]).toEqual(["c", "a"]);
  });
  it("Versioned parsing: unknown or malformed version selects the newest", () => {
    expect([pick(undefined), pick("garbage"), pick("2.1")]).toEqual(["c", "c", "c"]);
  });
  it("Versioned parsing: versions compare numerically", () => {
    const t = [b("a", "2.9.0", "2.9.5"), b("b", "2.10.0", "2.10.5")];
    expect([selectBranch("claude", "2.10.1", t).id, selectBranch("claude", "2.9.7", t).id]).toEqual(["b", "a"]);
  });
  it("Versioned parsing: other agents' branches are ignored and a missing agent throws", () => {
    expect(selectBranch("codex", "1.0.0", table).id).toBe("x");
    expect(() => selectBranch("codex", "1.0.0", [b("a", "1.0.0", "2.0.0")])).toThrow();
  });
  it("Versioned parsing: unknown newer or missing versions still parse a valid output", () => {
    expect(PARSE_BRANCHES.map((x) => x.id)).toEqual(["claude-json-v1", "codex-jsonl-v1"]);
    const c = parseClaudeOutput(claudeOut(), "2.1.288");
    expect(c.ok).toBe(true);
    for (const v of ["9.9.9", undefined]) {
      expect(parseClaudeOutput(claudeOut(), v)).toEqual(c);
      expect(parseCodexOutput(good, v)).toEqual(parseCodexOutput(good, "0.159.2"));
    }
    expect(parseCodexOutput(good, "9.9.9")).toEqual(goodResult);
  });
});

describe("Strict required fields", () => {
  it("Strict required fields: claude result that is not a string and no structured_output is refused with the tail", () => {
    const raw = claudeOut({ result: 5 });
    const o = parseClaudeOutput(raw);
    expect(o.ok).toBe(false);
    expect(diag(o)).toContain(providerMessages().claudeNoText);
    expect(diag(o)).toContain(raw);
  });
  it("Strict required fields: claude is_error of a wrong type is refused", () => {
    for (const v of ["no", 1, null]) {
      const o = parseClaudeOutput(claudeOut({ is_error: v }));
      expect(o.ok).toBe(false);
      expect(diag(o)).toContain(providerMessages().claudeBadIsError(typeof v));
    }
  });
  it("Strict required fields: claude is_error true keeps the CLI's own message", () => {
    expect(parseClaudeOutput(claudeOut({ is_error: true, result: "bad" }))).toEqual({ ok: false, diagnostic: "bad" });
  });
  it("Strict required fields: invalid claude tokens and cost are dropped, the answer is accepted", () => {
    for (const t of [-1, 1.5, "10"]) {
      expect(parseClaudeOutput(claudeOut({ usage: { input_tokens: t, output_tokens: t } }))).toEqual({ ok: true, text: "text", usage: {} });
    }
    expect(parseClaudeOutput(claudeOut({ usage: { input_tokens: -1, cache_creation_input_tokens: 3400, output_tokens: 5 } }))).toEqual({ ok: true, text: "text", usage: { outputTokens: 5 } });
    expect(parseClaudeOutput(claudeOut({ usage: { input_tokens: 10, cache_read_input_tokens: "7", output_tokens: 5 } }))).toEqual({ ok: true, text: "text", usage: { outputTokens: 5 } });
    for (const t of [-1, 1.5, "10"]) {
      const out = [{ type: "item.completed", item: { id: "i", type: "agent_message", text: "text" } }, { type: "turn.completed", usage: { input_tokens: t, output_tokens: 3 } }];
      expect(parseCodexOutput(out.map((e) => JSON.stringify(e)).join("\n"))).toEqual({ ok: true, text: "text", usage: { outputTokens: 3 } });
    }
    for (const c of [-1, "0.1"]) expect(parseClaudeOutput(claudeOut({ total_cost_usd: c }))).toEqual({ ok: true, text: "text", usage: {} });
    expect(parseClaudeOutput(claudeOut({ total_cost_usd: 0.5 }))).toEqual({ ok: true, text: "text", usage: { costUsd: 0.5 } });
  });
  it("Strict required fields: codex agent message with a non-string text is refused", () => {
    const o = parseCodexOutput(codexOut(msg(42), done()));
    expect(o.ok).toBe(false);
    expect(diag(o)).toContain(providerMessages().codexBadText);
  });
  it("Strict required fields: codex without a message is refused with the tail", () => {
    const raw = codexOut(done());
    const o = parseCodexOutput(raw);
    expect(o.ok).toBe(false);
    expect(diag(o)).toContain(providerMessages().codexNoText);
    expect(diag(o)).toContain(raw.trim());
  });
});

describe("Unknown is skipped", () => {
  it("Unknown is skipped: claude noise lines around a valid JSON line", () => {
    const plain = parseClaudeOutput(claudeOut());
    expect(parseClaudeOutput(`2026 WARN noise\n${claudeOut()}\ntrailing log\n`)).toEqual(plain);
    expect(plain.ok).toBe(true);
  });
  it("Unknown is skipped: claude unknown fields and unknown events", () => {
    const base = parseClaudeOutput(claudeOut());
    expect(parseClaudeOutput(claudeOut({ brand_new: { a: 1 }, usage: { input_tokens: 1, weird: "x" } }))).toEqual({ ok: true, text: "text", usage: { inputTokens: 1 } });
    expect(parseClaudeOutput(JSON.stringify([{ type: "system", x: 1 }, { type: "future" }, JSON.parse(claudeOut()), { type: "tail" }]))).toEqual(base);
    expect(parseClaudeOutput(`WARN noise\n${JSON.stringify([{ type: "system" }, JSON.parse(claudeOut())])}\nnot json\n`)).toEqual(base);
  });
  it("Unknown is skipped: claude junk still gives the tail", () => {
    expect(parseClaudeOutput("not json")).toEqual({ ok: false, diagnostic: "not json" });
  });
  it("Unknown is skipped: codex non-JSON line between JSONL lines", () => {
    expect(parseCodexOutput(`log line\n${good.trim().split("\n").join("\nERROR noise\n")}\n`)).toEqual(goodResult);
  });
  it("Unknown is skipped: codex unknown fields and events", () => {
    const raw = codexOut({ type: "future.event", x: 1 }, { type: "item.completed", item: { type: "reasoning", text: "t" } },
      { type: "item.completed", item: { id: "i", type: "agent_message", text: "b", extra: 1 } }, { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 7, new: 1 } });
    expect(parseCodexOutput(raw)).toEqual(goodResult);
  });
});

describe("Errors and isolation events are not ignored", () => {
  it("Errors and isolation events are not ignored: message followed by turn.failed is refused with the error", () => {
    const o = parseCodexOutput(codexOut(msg("b"), { type: "turn.failed", error: { message: "boom" } }, done()));
    expect(o).toEqual({ ok: false, diagnostic: "boom" });
  });
  it("Errors and isolation events are not ignored: a started tool item without completion is a tool call", () => {
    const o = parseCodexOutput(codexOut({ type: "item.started", item: { id: "t", type: "command_execution" } }, msg("b"), done()));
    expect(o.ok).toBe(false);
    expect(!o.ok && o.toolCall).toBe("command_execution");
  });
  it("Errors and isolation events are not ignored: a tool item after the message and turn.completed is a tool call", () => {
    const o = parseCodexOutput(codexOut(msg("b"), done(), { type: "item.completed", item: { id: "t", type: "mcp_tool_call" } }));
    expect(!o.ok && o.toolCall).toBe("mcp_tool_call");
  });
});

describe("Driver level", () => {
  const sharedTmp = tmpdir();
  const ownTmp = mkdtempSync(join(sharedTmp, "output-parse-test-"));
  const roots: string[] = [];
  beforeAll(() => { process.env.TMPDIR = ownTmp; });
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  afterAll(() => { process.env.TMPDIR = sharedTmp; rmSync(ownTmp, { recursive: true, force: true }); });

  function runtime(agent: CliAgent, stdout: string, code: number, version?: string): CliRuntime {
    const root = mkdtempSync(join(tmpdir(), "stub-"));
    roots.push(root);
    writeFileSync(join(root, "out"), stdout);
    const path = join(root, "stub.sh");
    writeFileSync(path, `#!/bin/sh\ncat > /dev/null\ncat "$(dirname "$0")/out"\nexit ${code}\n`);
    chmodSync(path, 0o755);
    return { agent, path, env: { PATH: process.env.PATH }, flags: codexFlags, features: codexFeatures, ...(version ? { version } : {}) };
  }
  const req = (): TurnRequest => ({
    participant: { id: "p1", name: "N1", providerId: "x", model: "default", role: null },
    prompt: "q", language: "ru", timeoutSec: 30, signal: new AbortController().signal, onChunk: () => {},
  });

  it("Versioned parsing: runtime version newer than known still returns the answer", async () => {
    const res = await createCliDriver(runtime("codex", good, 0, "9.9.9")).call(req());
    expect(res.text).toBe("b");
  });
  it("Driver level: onOutput receives the raw stdout and exit code", async () => {
    const seen: unknown[] = [];
    await createCliDriver(runtime("codex", good, 0), { onOutput: (r) => seen.push(r) }).call(req());
    expect(seen).toEqual([{ stdout: good, stderr: "", exitCode: 0 }]);
  });
  it("Strict required fields: non-zero exit code with a valid output is a failure", async () => {
    const e = await createCliDriver(runtime("codex", good, 1)).call(req()).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(ParticipantCallError);
  });
});
