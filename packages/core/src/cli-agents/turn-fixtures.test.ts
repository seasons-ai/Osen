import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseClaudeOutput, parseCodexOutput } from "./output-parse.ts";
import { anonymizeTurnOutput, findPersonalData, listTurnFixtures, missingTurnFixtures, NEUTRAL_REPLY, turnFixtureName } from "./turn-fixtures.ts";
import { BUILTIN_RECORD } from "./verified-record.ts";
import { TurnResponseSchema } from "../protocol/schema.ts";

const fixtures = listTurnFixtures();
const parse = (agent: "claude" | "codex", text: string, version: string) =>
  agent === "claude" ? parseClaudeOutput(text, version) : parseCodexOutput(text, version);

const planted = [
  "/Users/alice/work/project", "id 3F2B8C1E-5A4D-4E7F-9B6A-1C2D3E4F5A6B", "mail a@b.com", "key sk-ant-api03-abcdefghijklmnop1234",
].join("\n");

const rawClaude = JSON.stringify({
  type: "result", is_error: false, result: `Real answer from /home/bob/repo for a@b.com`, session_id: "3f2b8c1e-5a4d-4e7f-9b6a-1c2d3e4f5a6b",
  total_cost_usd: 0.5, usage: { input_tokens: 5, output_tokens: 6 }, note: "sk-abcdefghijklmnopqrstuvwxyz",
  structured_output: { stance: "object", reasoning: "secret /Users/alice/x", solution: null, answers: [], questions: [] },
});
const rawCodex = [
  JSON.stringify({ type: "thread.started", thread_id: "3f2b8c1e-5a4d-4e7f-9b6a-1c2d3e4f5a6b" }),
  "log line, not JSON",
  JSON.stringify({ type: "item.completed", item: { id: "i0", type: "reasoning", text: "thinking about /Users/alice/x" } }),
  JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "Real answer, mail a@b.com, key ghp_abcdefghijklmnopqrstuvwx" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 6 } }),
].join("\n");

describe("Fixtures of recorded versions", () => {
  it("Fixtures of recorded versions: every fixture parses with its agent parser into a valid reply with numeric usage", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      const out = parse(f.agent, readFileSync(f.file, "utf8"), f.version);
      expect(out.ok, f.file).toBe(true);
      if (!out.ok) continue;
      expect(TurnResponseSchema.safeParse(JSON.parse(out.text)).success, f.file).toBe(true);
      expect(typeof out.usage.inputTokens, f.file).toBe("number");
      expect(typeof out.usage.outputTokens, f.file).toBe("number");
    }
  });

  it("Fixtures of recorded versions: the built-in record has a fixture for every entry", () => {
    const missing = missingTurnFixtures(BUILTIN_RECORD, fixtures).map((e) => `${e.agent} ${e.version}`);
    expect(missing, `missing fixtures: ${missing.join(", ")}`).toEqual([]);
  });

  it("Fixtures of recorded versions: a record entry without a fixture is reported with agent and version", () => {
    const missing = missingTurnFixtures([...BUILTIN_RECORD, { agent: "claude", version: "9.9.9" }], fixtures);
    expect(missing).toEqual([{ agent: "claude", version: "9.9.9" }]);
  });

  it("Fixtures of recorded versions: file names follow the version and the synthetic mark", () => {
    expect(turnFixtureName("claude", "1.2.3", false)).toBe("claude-1.2.3-turn.json");
    expect(turnFixtureName("claude", "1.2.3", true)).toBe("claude-1.2.3-turn.synthetic.json");
    expect(turnFixtureName("codex", "0.1.2", true)).toBe("codex-0.1.2-turn.synthetic.jsonl");
    for (const f of fixtures) expect(f.file.endsWith(turnFixtureName(f.agent, f.version, f.synthetic))).toBe(true);
  });

  it("Fixtures of recorded versions: reports the number of synthetic fixtures", () => {
    const synthetic = fixtures.filter((f) => f.synthetic);
    expect(synthetic.length).toBe(fixtures.filter((f) => f.file.includes(".synthetic.")).length);
    console.log(`synthetic fixtures: ${synthetic.length} of ${fixtures.length}`);
  });

  it("Fixtures of recorded versions: no personal data in any fixture", () => {
    for (const f of fixtures) expect(findPersonalData(readFileSync(f.file, "utf8")), f.file).toEqual([]);
  });

  it("Fixtures of recorded versions: planted personal data of every kind is detected", () => {
    expect(findPersonalData(planted).sort()).toEqual(["email", "key", "user path", "uuid"]);
    expect(findPersonalData("C:\\Users\\bob\\x")).toEqual(["user path"]);
    expect(findPersonalData("/Users/<user>/x <email> <id-1> <key>")).toEqual([]);
  });

  it("Fixtures of recorded versions: anonymization cleans raw output, replaces the answer, stays parseable and deterministic", () => {
    for (const [agent, raw] of [["claude", rawClaude], ["codex", rawCodex]] as const) {
      expect(findPersonalData(raw).length).toBeGreaterThan(0);
      const clean = anonymizeTurnOutput(agent, raw);
      expect(findPersonalData(clean)).toEqual([]);
      expect(clean).not.toContain("Real answer");
      expect(clean).not.toContain("log line");
      const out = parse(agent, clean, "1.0.0");
      expect(out.ok).toBe(true);
      if (out.ok) expect(JSON.parse(out.text)).toEqual(NEUTRAL_REPLY);
      expect(anonymizeTurnOutput(agent, raw)).toBe(clean);
      expect(anonymizeTurnOutput(agent, clean)).toBe(clean);
    }
    expect(anonymizeTurnOutput("claude", rawClaude)).toContain("<id-1>");
  });
});
