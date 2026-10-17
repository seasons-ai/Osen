import { describe, it, expect } from "vitest";
import { finishReasonText } from "./finish-reason.ts";
import { INSUFFICIENT_ACTIVE_REASON_CODE } from "./schema.ts";
import { finishMessages } from "../messages/finish.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RU = "Активных участников осталось меньше двух.";
const EN = "Fewer than two active participants remain.";

function gen(seed: number) {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const str = () => Array.from({ length: 1 + int(30) }, () => String.fromCharCode(32 + int(0x4e0))).join("");
  const reason = [RU, EN, str(), null][int(4)]!;
  const known = rnd() < 0.5;
  const reasonCode = known ? INSUFFICIENT_ACTIVE_REASON_CODE : [str(), "token_cap", null][int(3)]!;
  return { reason, reasonCode, known: reasonCode === INSUFFICIENT_ACTIVE_REASON_CODE };
}

describe("Failure codes and identifiers do not depend on language: failures with a code are shown by code", () => {
  it("600 random finish records", () => {
    for (let seed = 1; seed <= 600; seed++) {
      const f = gen(seed);
      const msg = `seed ${seed}`;
      const en = finishReasonText(f, "en");
      const ru = finishReasonText(f, "ru");
      if (f.known) {
        expect(en, msg).toBe(finishMessages("en").insufficientActive);
        expect(ru, msg).toBe(finishMessages("ru").insufficientActive);
        expect(en, msg).not.toBe(ru);
        expect(en, msg).toBe(EN);
        expect(ru, msg).toBe(RU);
      } else {
        expect(en, msg).toBe(f.reason);
        expect(ru, msg).toBe(f.reason);
      }
    }
  });

  it("a record in Russian under en is shown in English", () => {
    expect(finishReasonText({ reason: RU, reasonCode: INSUFFICIENT_ACTIVE_REASON_CODE }, "en")).toBe(EN);
  });

  it("an English record under ru is shown the same way as a Russian record", () => {
    const fromEn = finishReasonText({ reason: EN, reasonCode: INSUFFICIENT_ACTIVE_REASON_CODE }, "ru");
    expect(fromEn).toBe(finishReasonText({ reason: RU, reasonCode: INSUFFICIENT_ACTIVE_REASON_CODE }, "ru"));
    expect(fromEn).toBe(RU);
  });

  it("an unknown code shows the recorded text", () => {
    expect(finishReasonText({ reason: "что-то записано", reasonCode: "future_code" }, "en")).toBe("что-то записано");
    expect(finishReasonText({ reason: null, reasonCode: "future_code" }, "ru")).toBeNull();
  });
});
