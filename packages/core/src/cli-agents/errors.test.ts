import { describe, expect, it } from "vitest";
import { ParticipantCallError } from "../participants/driver.ts";
import { classifyFailure, toCallError } from "./errors.ts";

const base = { command: "/usr/bin/claude", exitCode: 1, signal: null } as const;

describe("classifyFailure", () => {
  it("ENOENT: not found, no retry, with path", () => {
    const f = classifyFailure("claude", { ...base, exitCode: null, text: "", spawnError: Object.assign(new Error("x"), { code: "ENOENT" }) });
    expect(f).toMatchObject({ kind: "not_found", retryable: false });
    expect(f.message).toContain("/usr/bin/claude");
  });
  it("other launch error is retried", () => {
    const f = classifyFailure("codex", { ...base, exitCode: null, text: "", spawnError: Object.assign(new Error("boom"), { code: "EMFILE" }) });
    expect(f).toMatchObject({ kind: "exit_code", retryable: true, message: "Не удалось запустить codex: boom" });
  });
  it.each([
    ["claude", "Invalid API key · Please run /login", "/login"],
    ["claude", "Not logged in. Run the login command first.", "/login"],
    ["codex", "401 Unauthorized: invalid API key", "codex login"],
  ] as const)("вход %s: %s", (agent, text, hint) => {
    const f = classifyFailure(agent, { ...base, text });
    expect(f).toMatchObject({ kind: "not_logged_in", retryable: false });
    expect(f.message).toContain(hint);
  });
  it.each([
    ["You’ve hit your usage limit … try again at 3:44 PM", "3:44 PM"],
    ["You've hit your usage limit. Try again later.", undefined],
    ["Usage limit reached; resets later today.", undefined],
    ["You are out of credits. Add funds to continue.", undefined],
  ])("лимит: %s", (text, resetsAt) => {
    const f = classifyFailure("codex", { ...base, text });
    expect(f.kind).toBe("limit_exhausted");
    expect(f.retryable).toBe(false);
    expect(f.resetsAt).toBe(resetsAt);
    expect(f.message).toContain(resetsAt ? `сброс: ${resetsAt}` : "время сброса CLI не сообщил");
  });
  it.each(["429 Too Many Requests", "429 rate limit"])("short limit is retried: %s", (text) => {
    expect(classifyFailure("claude", { ...base, text })).toMatchObject({ kind: "exit_code", retryable: true });
  });
  it("plain code: code and no more than 5 last lines", () => {
    const text = Array.from({ length: 8 }, (_, i) => `line${i}`).join("\n") + "\n\n";
    const f = classifyFailure("claude", { ...base, exitCode: 3, text });
    expect(f).toMatchObject({ kind: "exit_code", retryable: true });
    expect(f.message).toBe("claude завершился с кодом 3: line3 | line4 | line5 | line6 | line7");
  });
  it("line is trimmed to 300 characters", () => {
    expect(classifyFailure("claude", { ...base, text: "x".repeat(400) }).message).toBe(`claude завершился с кодом 1: ${"x".repeat(300)}`);
  });
  it("signal without code, empty text", () => {
    const f = classifyFailure("codex", { ...base, exitCode: null, signal: "SIGKILL", text: "" });
    expect(f.message).toBe("codex завершился по сигналу SIGKILL");
  });
  it("toCallError", () => {
    const e = toCallError({ kind: "exit_code", message: "m", retryable: false });
    expect(e).toBeInstanceOf(ParticipantCallError);
    expect(e).toMatchObject({ kind: "call_error", retryable: false, message: "m" });
  });
});
