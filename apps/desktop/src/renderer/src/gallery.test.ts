import { describe, expect, it } from "vitest";
import { initialGallery, reduceGallery } from "./gallery.ts";

const asked = reduceGallery(initialGallery, { type: "ask", id: "a", mode: "delete" });

describe("reduceGallery", () => {
  it("ask opens the confirmation", () => {
    expect(asked.confirming).toEqual({ id: "a", mode: "delete" });
  });
  it("ask clears the previous error", () => {
    const failed = reduceGallery(initialGallery, { type: "failed", id: "b", message: "м" });
    expect(reduceGallery(failed, { type: "ask", id: "a", mode: "reset" })).toEqual({ confirming: { id: "a", mode: "reset" }, removing: false, failure: null });
  });
  it("cancel closes the confirmation", () => {
    expect(reduceGallery(asked, { type: "cancel" })).toEqual(initialGallery);
  });
  it("cancel during removing changes nothing", () => {
    const busy = reduceGallery(asked, { type: "removing" });
    expect(busy.removing).toBe(true);
    expect(reduceGallery(busy, { type: "cancel" })).toBe(busy);
  });
  it("removed closes the confirmation and clears the flag", () => {
    const busy = reduceGallery(asked, { type: "removing" });
    expect(reduceGallery(busy, { type: "removed" })).toEqual(initialGallery);
  });
  it("failed clears the flag, closes the confirmation and remembers the reason", () => {
    const busy = reduceGallery(asked, { type: "removing" });
    expect(reduceGallery(busy, { type: "failed", id: "a", message: "нельзя" })).toEqual({ confirming: null, removing: false, failure: { id: "a", message: "нельзя" } });
  });
  it("dismiss clears the error", () => {
    const failed = reduceGallery(initialGallery, { type: "failed", id: null, message: "м" });
    expect(reduceGallery(failed, { type: "dismiss" }).failure).toBeNull();
  });
});
