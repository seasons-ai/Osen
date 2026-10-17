import { describe, expect, it } from "vitest";
import { partialView } from "./partial.ts";

describe("partialView", () => {
  it("null and undefined — the journal was read entirely", () => {
    expect(partialView(null)).toBeNull();
    expect(partialView(undefined, "ru")).toBeNull();
  });
  it("newer_version, ru", () => {
    const v = partialView({ reason: "newer_version", lastEvent: 7 }, "ru")!;
    expect(v).toMatchObject({ reason: "newer_version", lastEvent: 7, badge: "нужна новая версия", mark: "прочитано до события №7", icon: "i-alert", tone: "warn" });
    expect(v.message).toBe("Сессия записана более новой версией приложения. Показано начало журнала до события №7. Обновите приложение, чтобы увидеть её целиком.");
  });
  it("newer_version, en", () => {
    const v = partialView({ reason: "newer_version", lastEvent: 7 }, "en")!;
    expect(v).toMatchObject({ badge: "newer version needed", mark: "read up to event No. 7" });
    expect(v.message).toContain("event No. 7");
  });
  it("corrupted", () => {
    expect(partialView({ reason: "corrupted", lastEvent: 3 }, "ru")).toMatchObject({ badge: "журнал повреждён", message: "Журнал повреждён: показано начало до события №3" });
    expect(partialView({ reason: "corrupted", lastEvent: 3 }, "en")).toMatchObject({ badge: "journal corrupted", message: "The journal is corrupted: showing the start up to event No. 3" });
  });
});
