import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { getProcessLanguage, setProcessLanguage } from "../i18n/process-language.ts";
import { describeIssue } from "./zod.ts";

const before = getProcessLanguage();
afterEach(() => setProcessLanguage(before));

const issue = () => {
  const r = z.number().max(7).safeParse(8);
  if (r.success) throw new Error("issue expected");
  return r.error.issues[0]!;
};

describe("describeIssue: too_big (change 108)", () => {
  it("number above the limit: en and ru, no English zod text", () => {
    setProcessLanguage("en");
    expect(describeIssue(issue())).toBe("expected a number not greater than 7");
    setProcessLanguage("ru");
    expect(describeIssue(issue())).toBe("ожидается число не больше 7");
  });
});

describe("Core messages in the selected language: plural in a schema check message (change 253)", () => {
  const minIssue = (n: number) => {
    const r = z.array(z.string()).min(n).safeParse([]);
    if (r.success) throw new Error("issue expected");
    return r.error.issues[0]!;
  };

  it("ru and en agree the noun with the number", () => {
    const ru: Record<number, string> = { 1: "не меньше 1 элемента", 2: "не меньше 2 элементов", 5: "не меньше 5 элементов", 21: "не меньше 21 элемента", 22: "не меньше 22 элементов" };
    for (const [n, text] of Object.entries(ru)) expect(describeIssue(minIssue(Number(n)), "ru")).toBe(`ожидается ${text}`);
    expect(describeIssue(minIssue(1), "en")).toBe("expected at least 1 item");
    expect(describeIssue(minIssue(2), "en")).toBe("expected at least 2 items");
    expect(describeIssue(minIssue(21), "en")).toBe("expected at least 21 items");
  });

  it("ru form for every n in 1..1000 matches the Russian genitive rule", () => {
    for (let n = 1; n <= 1000; n++) {
      const form = n % 10 === 1 && n % 100 !== 11 ? "элемента" : "элементов";
      expect(describeIssue(minIssue(n), "ru")).toBe(`ожидается не меньше ${n} ${form}`);
    }
  });

  it("without a language the process language is used", () => {
    setProcessLanguage("ru");
    expect(describeIssue(minIssue(1))).toBe("ожидается не меньше 1 элемента");
    setProcessLanguage("en");
    expect(describeIssue(minIssue(1))).toBe("expected at least 1 item");
  });
});
