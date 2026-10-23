import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "../i18n/process-language.ts";
import type { Language } from "../i18n/language.ts";
import { writeAcceptanceStub } from "./acceptance-stub.fixture.ts";
import { PROBES, runAcceptance } from "./acceptance.ts";
import type { AcceptancePlan } from "./acceptance.ts";
import { DEFAULT_MODEL } from "./types.ts";

// The real inspectPinned against a node stub: the reason of a failed help read is in the chosen language.
let root: string;
beforeEach(() => {
  setProcessLanguage("en");
  root = mkdtempSync(join(tmpdir(), "accept-reason-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function reasonOf(mode: string, language: Language, limits: { timeoutMs?: number; maxBytes?: number }, help = ""): Promise<string> {
  const stub = writeAcceptanceStub(root, help ? { help } : {});
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const plan: AcceptancePlan = { agent: "claude", version: "2.1.288", path: stub, sha256: createHash("sha256").update(readFileSync(stub)).digest("hex"), configDir, model: DEFAULT_MODEL, probes: PROBES, bound: 7 };
  const env = { PATH: "/usr/bin:/bin", STUB_MODE: mode, STUB_PIDFILE: join(root, "child.pid") };
  const out = await runAcceptance(join(root, "data"), plan, { env, language, inspectLimits: limits });
  return out.outcomes[0]!.reason!;
}

describe("Сообщения ядра на выбранном языке: причина сбоя чтения справки", () => {
  it("non-zero exit: ru has no English frame, keeps stderr and the code", async () => {
    const ru = await reasonOf("help_fail", "ru", {});
    expect(ru).toContain("не удалось прочитать справку или возможности CLI");
    expect(ru).not.toMatch(/exited with|no answer within|output is larger/);
    expect(ru).toContain("boom");
    expect(ru).toContain("завершился с кодом 3: boom");
    const en = await reasonOf("help_fail", "en", {});
    expect(en).toContain("exited with code 3: boom");
  });
  it("time limit: ru text with the number, en keeps English", async () => {
    const ru = await reasonOf("help_hang", "ru", { timeoutMs: 400 });
    expect(ru).not.toMatch(/exited with|no answer within|output is larger/);
    expect(ru).toContain("нет ответа за 400 мс");
    expect(await reasonOf("help_hang", "en", { timeoutMs: 400 })).toContain("no answer within 400 ms");
  }, 30_000);
  it("too much output: ru text with the number, en keeps English", async () => {
    const help = "x".repeat(500);
    const ru = await reasonOf("good", "ru", { maxBytes: 64 }, help);
    expect(ru).not.toMatch(/exited with|no answer within|output is larger/);
    expect(ru).toContain("вывод больше 64 байт");
    expect(await reasonOf("good", "en", { maxBytes: 64 }, help)).toContain("output is larger than 64 bytes");
  });
});
