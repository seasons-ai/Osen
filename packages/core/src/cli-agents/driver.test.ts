import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createCliDriver, parseClaudeOutput, parseCodexOutput, TURN_RESPONSE_JSON_SCHEMA } from "./driver.ts";
import { declaredFlags, parseCodexFeatures } from "./flags.ts";
import { participantSystemPrompt } from "./args.ts";
import { getProcessLanguage, setProcessLanguage } from "../i18n/process-language.ts";
import type { CliAgent, CliRuntime } from "./types.ts";
import { createSession, runSession } from "../engine.ts";
import { ParticipantCallError } from "../participants/driver.ts";
import type { TurnRequest } from "../participants/driver.ts";
import { TurnResponseSchema } from "../protocol/schema.ts";
import type { SessionEvent } from "../protocol/schema.ts";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const claudeFlags = declaredFlags(fx("claude-2.1.288-help.txt"));
const codexFlags = declaredFlags(fx("codex-0.159.2-exec-help.txt"));
const codexFeatures = parseCodexFeatures(fx("codex-0.159.2-features.txt"));

// Own temp folder: other test files create council-turn-* folders in the shared one at the same time.
const sharedTmp = tmpdir();
const ownTmp = mkdtempSync(join(sharedTmp, "driver-test-"));
process.env.TMPDIR = ownTmp;
const turnDirs = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("council-turn-")));
let before: Set<string>;
beforeAll(() => { before = turnDirs(); });
afterAll(() => {
  try {
    expect([...turnDirs()].filter((n) => !before.has(n))).toEqual([]);
  } finally {
    process.env.TMPDIR = sharedTmp;
    rmSync(ownTmp, { recursive: true, force: true });
  }
});

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); delete process.env.COUNCIL_TEST_MARKER; });

interface Stub { runtime: CliRuntime; proto: (name: string) => string; has: (name: string) => boolean }

/** CLI stub: writes the launch protocol to its own folder, prints the prepared output. */
function stub(agent: CliAgent, o: { stdout?: string; stderr?: string; code?: number; sleep?: number; flags?: Set<string> } = {}): Stub {
  const root = mkdtempSync(join(tmpdir(), "stub-"));
  roots.push(root);
  writeFileSync(join(root, "out"), o.stdout ?? "");
  writeFileSync(join(root, "err"), o.stderr ?? "");
  const sh = `#!/bin/sh
D="$(dirname "$0")"; P="$D/proto"; mkdir -p "$P"
echo $$ > "$P/pid"
: > "$P/args"; for a in "$@"; do printf '%s\\n' "$a" >> "$P/args"; done
cat > "$P/stdin"
printf '%s' "$COUNCIL_PARTICIPANT" > "$P/cp"
printf '%s\\n' "COUNCIL_PARTICIPANT=$COUNCIL_PARTICIPANT" "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" "DISABLE_AUTOUPDATER=$DISABLE_AUTOUPDATER" "DISABLE_UPDATES=$DISABLE_UPDATES" "CODEX_HOME=$CODEX_HOME" > "$P/pinvars"
printf '%s' "\${COUNCIL_TEST_MARKER-unset}" > "$P/marker"
pwd > "$P/pwd"; ls -A > "$P/ls"
prev=""; for a in "$@"; do [ "$prev" = "--output-schema" ] && cat "$a" > "$P/schema"; prev="$a"; done
${o.sleep ? `sleep ${o.sleep}` : ""}
cat "$D/out"; cat "$D/err" >&2
exit ${o.code ?? 0}
`;
  const path = join(root, "stub.sh");
  writeFileSync(path, sh);
  chmodSync(path, 0o755);
  const runtime: CliRuntime = {
    agent, path, env: { PATH: process.env.PATH },
    flags: o.flags ?? (agent === "claude" ? claudeFlags : codexFlags),
    ...(agent === "codex" ? { features: codexFeatures } : {}),
  };
  const proto = (name: string) => join(root, "proto", name);
  return { runtime, proto, has: (name) => existsSync(proto(name)) };
}

const lines = (s: Stub, name: string) => readFileSync(s.proto(name), "utf8").split("\n").slice(0, -1);
const turnDirOf = (s: Stub) => join(readFileSync(s.proto("pwd"), "utf8").trim(), "..");

function request(over: Partial<TurnRequest> & { model?: string } = {}) {
  const chunks: string[] = [];
  const req: TurnRequest = {
    participant: { id: "p1", name: "N1", providerId: "x", model: over.model ?? "default", role: null },
    prompt: "вопрос", language: "ru", timeoutSec: 30, signal: new AbortController().signal, onChunk: (t) => chunks.push(t), ...over,
  };
  return { req, chunks };
}
const run = (s: Stub, over: Parameters<typeof request>[0] = {}) => { const r = request(over); return { ...r, p: createCliDriver(s.runtime).call(r.req) }; };

const rejection = async (p: Promise<unknown>): Promise<ParticipantCallError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(ParticipantCallError);
  return e as ParticipantCallError;
};

const answer = { stance: "agree", reasoning: "r", solution: null, answers: [], questions: [] };
const claudeOut = (extra: Record<string, unknown> = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "текст", ...extra });
const codexOut = (...evs: unknown[]) => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";
const msg = (text: string) => ({ type: "item.completed", item: { id: "i", type: "agent_message", text } });
const done = (usage: unknown = { input_tokens: 100, cached_input_tokens: 50, output_tokens: 7 }) => ({ type: "turn.completed", usage });

describe("TURN_RESPONSE_JSON_SCHEMA", () => {
  it("consistent with TurnResponseSchema", () => {
    const gen = z.toJSONSchema(TurnResponseSchema, { io: "input" }) as any;
    const lit = TURN_RESPONSE_JSON_SCHEMA as any;
    // files has a default value: optional in the input schema of zod, required in the CLI schema
    const same = (a: any, b: any, optional: string[] = []) => {
      expect(Object.keys(a.properties).sort()).toEqual(Object.keys(b.properties).sort());
      expect([...a.required, ...optional].sort()).toEqual([...b.required].sort());
      expect(Object.keys(b.properties).sort()).toEqual([...b.required].sort());
      expect(b.additionalProperties).toBe(false);
    };
    same(gen, lit, ["files"]);
    same(gen.properties.answers.items, lit.properties.answers.items);
    same(gen.properties.questions.items, lit.properties.questions.items);
    expect("$schema" in lit).toBe(false);
  });
});

describe("claude", () => {
  it("1. structured_output: text, chunk, arguments, stdin", async () => {
    const s = stub("claude", { stdout: claudeOut({ structured_output: answer }) });
    const { p, chunks } = run(s, { prompt: "мой запрос" });
    const res = await p;
    expect(res.text).toBe(JSON.stringify(answer));
    expect(chunks).toEqual([JSON.stringify(answer)]);
    const args = lines(s, "args");
    expect(args).toContain("--json-schema");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("мой запрос");
    expect(readFileSync(s.proto("stdin"), "utf8")).toBe("мой запрос");
  });

  it("CLI participant system prompt in the session language from the request, not the process", async () => {
    const prev = getProcessLanguage();
    try {
      for (const [lang, proc] of [["en", "ru"], ["ru", "en"]] as const) {
        setProcessLanguage(proc);
        const s = stub("claude", { stdout: claudeOut({ structured_output: answer }) });
        await run(s, { language: lang }).p;
        const args = lines(s, "args");
        expect(args[args.indexOf("--system-prompt") + 1]).toBe(participantSystemPrompt(lang));
      }
    } finally {
      setProcessLanguage(prev);
    }
  });

  it("2. result only", async () => {
    const s = stub("claude", { stdout: claudeOut({ result: "просто текст" }) });
    expect((await run(s).p).text).toBe("просто текст");
  });

  it("3. usage", async () => {
    const full = stub("claude", { stdout: claudeOut({ total_cost_usd: 0.02, usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5 } }) });
    expect((await run(full).p).usage).toEqual({ inputTokens: 60, outputTokens: 5, costUsd: 0.02 });
    const noCost = stub("claude", { stdout: claudeOut({ usage: { input_tokens: 10, output_tokens: 5 } }) });
    const u = (await run(noCost).p).usage;
    expect(u).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect("costUsd" in u).toBe(false);
    expect((await run(stub("claude", { stdout: claudeOut() })).p).usage).toEqual({});
  });

  it("4. array of events", async () => {
    const s = stub("claude", { stdout: JSON.stringify([{ type: "system" }, { type: "result", is_error: false, result: "из массива" }]) });
    expect((await run(s).p).text).toBe("из массива");
  });

  it("11. login not completed", async () => {
    const s = stub("claude", { stdout: claudeOut({ is_error: true, result: "Invalid API key · Please run /login" }), code: 1 });
    const e = await rejection(run(s).p);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("/login");
  });
});

describe("codex", () => {
  it("5. success: last agent_message, usage, schema, argument -", async () => {
    const s = stub("codex", { stdout: codexOut({ type: "thread.started" }, msg("первое"), msg("итог"), done()) });
    const res = await run(s).p;
    expect(res.text).toBe("итог");
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 7 });
    expect("costUsd" in res.usage).toBe(false);
    expect(JSON.parse(readFileSync(s.proto("schema"), "utf8"))).toEqual(TURN_RESPONSE_JSON_SCHEMA);
    expect(lines(s, "args").at(-1)).toBe("-");
  });

  it("11. login not completed", async () => {
    const s = stub("codex", { stdout: codexOut({ type: "error", message: "Not logged in. Run the login command first." }), code: 1 });
    const e = await rejection(run(s).p);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("codex login");
  });

  it("12. limit", async () => {
    const m = "You’ve hit your usage limit. Upgrade to Pro or try again at 3:44 PM.";
    const s = stub("codex", { stdout: codexOut({ type: "error", message: m }, { type: "turn.failed", error: { message: m } }), code: 1 });
    const e = await rejection(run(s).p);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("3:44 PM");
  });

  it("15. tool call", async () => {
    const s = stub("codex", { stdout: codexOut({ type: "item.completed", item: { type: "command_execution", command: "ls" } }, msg("ответ"), done()) });
    const e = await rejection(run(s).p);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("command_execution");
  });
});

describe("pinned runtime", () => {
  const pinVars = { CLAUDE_CONFIG_DIR: "/pin/cfg", DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1" };
  const claudeOut = JSON.stringify({ type: "result", result: "ok", usage: {} });
  it("pin variables and COUNCIL_PARTICIPANT reach the process; the codex -c switch is passed", async () => {
    const s = stub("claude", { stdout: claudeOut });
    await run({ ...s, runtime: { ...s.runtime, env: { ...s.runtime.env, ...pinVars }, pinned: true } }).p;
    const seen = lines(s, "pinvars");
    for (const [k, v] of Object.entries(pinVars)) expect(seen).toContain(`${k}=${v}`);
    expect(seen).toContain("COUNCIL_PARTICIPANT=1");
    const x = stub("codex", { stdout: codexOut(msg("ok"), done()) });
    await run({ ...x, runtime: { ...x.runtime, pinned: true } }).p;
    expect(lines(x, "args")).toContain("check_for_update_on_startup=false");
  });
  it("an unpinned runtime has no pin variables and no -c", async () => {
    const s = stub("claude", { stdout: claudeOut });
    await run(s).p;
    const seen = lines(s, "pinvars");
    for (const k of Object.keys(pinVars)) expect(seen).toContain(`${k}=`);
    expect(seen).toContain("COUNCIL_PARTICIPANT=1");
    const x = stub("codex", { stdout: codexOut(msg("ok"), done()) });
    await run(x).p;
    expect(lines(x, "args")).not.toContain("-c");
  });
});

describe("isolation and launch", () => {
  it("6. special characters", async () => {
    const root = mkdtempSync(join(tmpdir(), "mark-"));
    roots.push(root);
    const mark = join(root, "created");
    const prompt = `"двойные" 'одинарные' $HOME $(touch ${mark}) \`touch ${mark}\`\nвторая строка\n\nКириллица ёЖ`;
    const s = stub("claude", { stdout: claudeOut() });
    await run(s, { prompt }).p;
    expect(readFileSync(s.proto("stdin"), "utf8")).toBe(prompt);
    expect(existsSync(mark)).toBe(false);
  });

  it("7. isolation: variable, empty cwd, cleanup on success and error", async () => {
    process.env.COUNCIL_TEST_MARKER = "leak";
    const ok = stub("claude", { stdout: claudeOut() });
    await run(ok).p;
    expect(readFileSync(ok.proto("cp"), "utf8")).toBe("1");
    expect(readFileSync(ok.proto("ls"), "utf8")).toBe("");
    expect(readFileSync(ok.proto("marker"), "utf8")).toBe("unset");
    expect(existsSync(turnDirOf(ok))).toBe(false);
    const bad = stub("claude", { stdout: "", stderr: "boom", code: 2 });
    await rejection(run(bad).p);
    expect(existsSync(turnDirOf(bad))).toBe(false);
  });

  it("8. model", async () => {
    const d = stub("claude", { stdout: claudeOut() });
    await run(d, { model: "default" }).p;
    expect(lines(d, "args")).not.toContain("--model");
    const h = stub("claude", { stdout: claudeOut() });
    await run(h, { model: "haiku" }).p;
    const args = lines(h, "args");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
  });

  it("9. no isolation flag", async () => {
    const s = stub("claude", { stdout: claudeOut(), flags: new Set([...claudeFlags].filter((f) => f !== "--tools")) });
    const e = await rejection(run(s).p);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("--tools");
    expect(s.has("args")).toBe(false);
  });

  it("10. command does not exist", async () => {
    const s = stub("claude");
    s.runtime.path = "/nonexistent/claude-xyz";
    const e = await rejection(run(s).p);
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("Команда не найдена: /nonexistent/claude-xyz");
  });

  it("13. other non-zero exit code", async () => {
    const s = stub("claude", { stderr: "a\nb\nc\nпоследняя", code: 3 });
    const e = await rejection(run(s).p);
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("3");
    expect(e.message).toContain("последняя");
  });

  it("14. interruption", async () => {
    const s = stub("claude", { sleep: 30 });
    const ac = new AbortController();
    const { p } = run(s, { signal: ac.signal });
    while (!s.has("ls")) await new Promise((r) => setTimeout(r, 20));
    setTimeout(() => ac.abort(), 200);
    const e = await rejection(p);
    expect(e.kind).toBe("timeout");
    const pid = Number(readFileSync(s.proto("pid"), "utf8"));
    const dead = async () => { for (let i = 0; i < 30; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise((r) => setTimeout(r, 100)); } return false; };
    expect(await dead()).toBe(true);
    expect(existsSync(turnDirOf(s))).toBe(false);
  });
});

describe("with the engine", () => {
  // a 1 s turn only where the timeout is the subject: a stub on a busy machine can take longer to answer
  const go = (drivers: ReturnType<typeof createCliDriver>[], turnTimeoutSec = 30) => {
    const session = createSession(
      {
        topic: "Тема", framing: "", origin: "cli", limits: { maxRounds: 3, turnTimeoutSec, contextChars: 20000 },
        participants: drivers.map((_, i) => ({ name: `N${i + 1}`, providerId: "x", model: "default", role: null })),
      },
      { maxParticipants: 8, id: "s1" },
    );
    return runSession({ session, drivers: Object.fromEntries(drivers.map((d, i) => [`p${i + 1}`, d])) });
  };
  const amend = { stance: "amend", reasoning: "r", solution: "v1", answers: [], questions: [] };
  const of = <T extends SessionEvent["type"]>(ev: SessionEvent[], t: T) => ev.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === t);

  it("16a. consensus, usage from output", async () => {
    const a = stub("claude", { stdout: claudeOut({ structured_output: amend, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 2 } }) });
    const b = stub("codex", { stdout: codexOut(msg(JSON.stringify(answer)), done({ input_tokens: 9, output_tokens: 3 })) });
    const { events } = await go([createCliDriver(a.runtime), createCliDriver(b.runtime)]);
    expect(of(events, "session_finished")[0]!.status).toBe("consensus");
    const usages = of(events, "turn_completed").map((e) => e.usage);
    expect(usages).toContainEqual({ inputTokens: 5, outputTokens: 2, costUsd: 0.01 });
    expect(usages).toContainEqual({ inputTokens: 9, outputTokens: 3 });
  }, 20000);

  it("16b. timeout and retry", async () => {
    const a = stub("claude", { sleep: 5 });
    const b = stub("codex", { stdout: codexOut(msg(JSON.stringify(answer)), done()) });
    const { events } = await go([createCliDriver(a.runtime), createCliDriver(b.runtime)], 1);
    const failed = of(events, "turn_failed");
    expect(failed[0]!.kind).toBe("timeout");
    expect(failed.some((e) => e.attempt === 2)).toBe(true);
  }, 30000);

  it("16c. limit: participant drops out without retry", async () => {
    const a = stub("codex", { stdout: codexOut({ type: "error", message: "You’ve hit your usage limit. try again at 3:44 PM." }), code: 1 });
    const b = stub("claude", { stdout: claudeOut({ structured_output: amend }) });
    const { events } = await go([createCliDriver(a.runtime), createCliDriver(b.runtime)]);
    expect(of(events, "turn_failed").filter((e) => e.participantId === "p1")).toHaveLength(1);
    const dropped = of(events, "participant_dropped").find((e) => e.participantId === "p1")!;
    expect(dropped.reason).toContain("Лимит");
    expect(dropped.reason).toContain("3:44 PM");
  }, 20000);
});

describe("parsers", () => {
  it("17. junk and noise", () => {
    expect(parseClaudeOutput("не json")).toEqual({ ok: false, diagnostic: "не json" });
    expect(parseClaudeOutput(JSON.stringify([{ type: "system" }])).ok).toBe(false);
    expect(parseClaudeOutput("x".repeat(3000))).toEqual({ ok: false, diagnostic: "x".repeat(2000) });
    expect(parseClaudeOutput(claudeOut({ result: "  " }))).toEqual({ ok: false, diagnostic: "claude не вернул текст ответа" });
    expect(parseClaudeOutput(claudeOut({ is_error: true, result: "плохо" }))).toEqual({ ok: false, diagnostic: "плохо" });
    const noisy = `2026 ERROR шум\n${JSON.stringify(msg("a"))}\nне json\n${JSON.stringify(msg("b"))}\n${JSON.stringify(done())}\n`;
    expect(parseCodexOutput(noisy)).toEqual({ ok: true, text: "b", usage: { inputTokens: 100, outputTokens: 7 } });
    expect(parseCodexOutput("мусор\n")).toEqual({ ok: false, diagnostic: "codex не вернул текст ответа" });
    expect(parseCodexOutput(codexOut({ type: "error", message: "e1" }, { type: "turn.failed", error: { message: "e2" } }))).toEqual({ ok: false, diagnostic: "e1\ne2" });
  });
});
