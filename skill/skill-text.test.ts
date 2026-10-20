import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { mcpMessages } from "../packages/mcp/src/messages.ts";

const text = readFileSync(join(import.meta.dirname, "osen", "SKILL.md"), "utf8");
const lines = text.split("\n");
const lineWith = (...re: RegExp[]) => lines.some((l) => re.every((r) => r.test(l)));
const description = lines.find((l) => l.startsWith("description: "))!.slice("description: ".length);
const body = text.split("\n---\n")[1] ?? "";
const block = (from: string, to: string) => text.split(from)[1]?.split(to)[0] ?? "";

describe("osen skill text", () => {
  for (const word of ["lineups", "lineupId", "lineup.notes", "lineupsError", "modelNote", "ownerSelection"]) {
    it(`mentions ${word}`, () => expect(text, `missing "${word}"`).toContain(word));
  }

  for (const anchor of ["council_options", "council_start", "council_status", "council_stop", "## Steps", "## Message before the start", "## Report", "## Failure modes"]) {
    it(`keeps the anchor ${anchor}`, () => expect(text, `lost "${anchor}"`).toContain(anchor));
  }

  it("the text is English: Cyrillic only in the description", () => {
    expect(body).not.toMatch(/[а-яё]/i);
  });

  it("the app is Osen, no former names or model-council", () => {
    for (const old of ["Model Council", "Мозговой штурм", "model-council"]) expect(text, `"${old}" is still there`).not.toContain(old);
    expect(text).toMatch(/^name: osen$/m);
    expect(lineWith(/Osen app/, /History/)).toBe(true);
    for (const t of ["council_options", "council_start", "council_status", "council_stop"]) expect(text).toContain(`mcp__osen__${t}`);
    expect(text).toContain("`.osen-install`");
  });

  it("tells to reply in the language of the owner's request and to translate template labels", () => {
    expect(lineWith(/Reply to the owner in the language of the owner's request/, /translate their labels/)).toBe(true);
  });

  it("forbids passing participants together with lineupId", () => {
    expect(lineWith(/lineupId/, /participants/, /together/), "no line with lineupId, participants and \"together\"").toBe(true);
  });

  it("forbids substituting participants of an unavailable lineup", () => {
    expect(lineWith(/available: false/, /do not substitute/), "нет строки с available: false и «do not substitute»").toBe(true);
  });

  it("the message before the start is always required", () => {
    expect(lineWith(/message before the start/i, /always/)).toBe(true);
    expect(lineWith(/Calling `council_start` without this message is a violation/)).toBe(true);
  });

  it("a consensus session is resumed only with the owner's message, verbatim, with the plan and the same message at execute", () => {
    expect(lineWith(/`consensus` session is resumed with `council_resume` only when the owner asks/, /`message` verbatim/, /never invent or paraphrase/)).toBe(true);
    expect(lineWith(/code `consensus`/, /`agreementReset`/, /same `message`/, /`stale_plan`/)).toBe(true);
  });

  it("consent to spend for cli and openai-http", () => {
    expect(lineWith(/`cli`/, /`openai-http`/, /wait for the answer/, /do not call `council_start`/)).toBe(true);
  });

  it("kinds of spend: cli — subscription, openai-http — paid, scripted — free", () => {
    expect(lineWith(/`cli` consumes the owner's subscription/, /`openai-http` is paid/, /`scripted` is free/)).toBe(true);
  });

  it("silence between council_status calls, waitSec 50", () => {
    expect(text).toContain("`{ sessionId, waitSec: 50 }`");
    expect(lineWith(/does not wait longer than 50 seconds/)).toBe(true);
    expect(lineWith(/Between `council_status` calls write nothing to the owner/)).toBe(true);
  });

  it("the Lineup line in the message and report templates", () => {
    for (const [from, to] of [["## Message before the start", "## Report"], ["## Report", "## Failure modes"]] as const) {
      expect(block(from, to).split("\n").some((l) => l.startsWith("Lineup:")), `нет строки «Lineup:» в ${from}`).toBe(true);
    }
  });

  // After change 65 the wording matches the English instructions of the MCP server.
  const instructions = Object.entries(mcpMessages("en")).filter(([k, v]) => k.startsWith("instr") && typeof v === "string").map(([, v]) => v).join("\n");
  for (const phrase of [
    "upper bound on the number of model calls",
    "Pass the topic in the owner's words",
    "add nothing of your own",
    "do not present the last version as an agreed decision",
    "it is the owner's choice made in the app: give it separately from the status and do not call it the models' consensus",
    "Materials go into every call of every participant and increase the spend",
    "A folder can be attached even when it is larger than the limit: only the initial set",
  ]) {
    it(`matches the MCP instructions: "${phrase}"`, () => {
      expect(instructions, "the phrase is not in the MCP server instructions").toContain(phrase);
      expect(text, "the phrase is not in the skill").toContain(phrase);
    });
  }
});

describe("skill description: phrases in two languages", () => {
  it("the former Russian trigger and exclusion phrases verbatim", () => {
    for (const p of ["«собери совет моделей»", "«обсуди с несколькими моделями»", "«пусть модели поспорят»", "«мозговой штурм моделей»", "«созови совет»", "«пусть Claude и Codex обсудят и договорятся»", "«обсуди со мной»", "«что думаешь»", "«давай набросаем идеи для названия»"]) {
      expect(description, `missing ${p}`).toContain(p);
    }
  });

  it("English equivalents of the trigger and exclusion phrases", () => {
    for (const p of ["«convene a council of models»", "«discuss with several models»", "«let the models argue»", "«brainstorm of models»", "«let Claude and Codex discuss and agree»", "«discuss with me»", "«what do you think»", "«let's brainstorm names»"]) {
      expect(description, `missing ${p}`).toContain(p);
    }
  });

  it("the description is at most 1024 characters (skill description limit)", () => {
    expect([...description].length).toBeLessThanOrEqual(1024);
  });

  const phrases = readFileSync(join(import.meta.dirname, "trigger-phrases.md"), "utf8");
  const rows = (section: string) => (phrases.split(section)[1] ?? "").split("\n## ")[0]!.split("\n")
    .filter((l) => l.startsWith("| «")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const fire = rows("## Скилл должен сработать"), skip = rows("## Скилл не должен сработать");

  it("check phrases: at least eight Russian and eight English in each list", () => {
    for (const list of [fire, skip]) {
      expect(list.filter(([p]) => /[а-яё]/i.test(p!)).length).toBeGreaterThanOrEqual(8);
      expect(list.filter(([p]) => !/[а-яё]/i.test(p!)).length).toBeGreaterThanOrEqual(8);
    }
  });

  it("the phrase about opening the app names Osen", () => {
    expect(skip.map(([p]) => p)).toEqual(expect.arrayContaining(["«Открой приложение Osen»", "«Open the Osen app»"]));
  });

  it("the anchor of each exclusion phrase is in the description", () => {
    for (const [p, , anchor] of skip) expect(description.toLowerCase(), `${p}: no anchor "${anchor}"`).toContain(anchor!.toLowerCase());
  });
});
