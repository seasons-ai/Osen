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
