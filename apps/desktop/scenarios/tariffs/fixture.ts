// Fixture journals and tariff files of the tariff estimation stand (the expected numbers are written in check.ts by hand).
import { appendEvent, createSessionJournal, tariffsPath } from "../../../../packages/core/src/index.ts";
import type { Session } from "../../../../packages/core/src/index.ts";
import { writeFileSync } from "node:fs";
import { done, started, toEvent } from "../usage/fixture.ts";

export const IDS = { A: "tariffs-a", B: "tariffs-b", C: "tariffs-c" } as const;

const created = (id: string, ps: Record<string, [string, string]>, at: string) => ({
  at, type: "session_created" as const, pid: 1,
  session: {
    id, createdAt: at, origin: "cli", topic: `Тема ${id}`, templateId: null, framing: "",
    participants: Object.entries(ps).map(([pid, [providerId, model]]) => ({ id: pid, name: pid, providerId, model, role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
  } satisfies Session,
});
const finish = (at: string) => ({ at, type: "session_finished" as const, status: "consensus" as const, version: 1, agreed: [], objectors: [] });
const T = (n: number) => `2026-10-09T10:0${n}:00Z`;

const JOURNALS = {
  [IDS.A]: [
    created(IDS.A, { p1: ["local-llm", "qwen3-coder"], p2: ["local-llm", "other-model"] }, T(0)),
    started(T(1), 1, "p1"), done(T(2), 1, { inputTokens: 1000000, outputTokens: 500000, costUsd: 3 }, "p1"),
    started(T(3), 2, "p2"), done(T(4), 2, { inputTokens: 300, outputTokens: 100 }, "p2"),
    started(T(5), 3, "p1"), done(T(6), 3, { inputTokens: 5600 }, "p1"),
    finish(T(7)),
  ],
  [IDS.B]: [
    created(IDS.B, { p1: ["eu-llm", "mistral-small"], p2: ["claude", "default"] }, T(0)),
    started(T(1), 1, "p1"), done(T(2), 1, { inputTokens: 200000, outputTokens: 100000 }, "p1"),
    started(T(3), 2, "p2"), done(T(4), 2, { inputTokens: 12400, outputTokens: 3100, costUsd: 0.421 }, "p2"),
    finish(T(5)),
  ],
  [IDS.C]: [ // the turn was completed by participant p9, who is not in the lineup: the record model is undefined
    created(IDS.C, { p1: ["local-llm", "qwen3-coder"], p2: ["local-llm", "qwen3-coder"] }, T(0)),
    started(T(1), 1, "p9"), done(T(2), 1, { inputTokens: 28, outputTokens: 28 }, "p9"),
    finish(T(3)),
  ],
};

export function seedJournals(dir: string): void {
  for (const [id, bodies] of Object.entries(JOURNALS)) {
    createSessionJournal(dir, id);
    bodies.forEach((b, i) => appendEvent(dir, id, toEvent(b, i + 1)));
  }
}

const t = (providerId: string, model: string, source: string, asOf: string, currency: string, i: number, o: number) =>
  ({ providerId, model, source, asOf, currency, inputPerMillion: i, outputPerMillion: o });
export const V1 = [
  t("local-llm", "qwen3-coder", "Локальная проверочная fixture", "2026-10-09", "USD", 2, 4),
  t("eu-llm", "mistral-small", "Локальная проверочная fixture, EUR", "2026-10-01", "EUR", 1.5, 2),
  t("claude", "default", "Тариф для default: применяться не должен", "2026-10-09", "USD", 3, 15),
];
export const writeTariffs = (dir: string, tariffs: unknown[]): void => writeFileSync(tariffsPath(dir), JSON.stringify({ tariffs }, null, 2));
