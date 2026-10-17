import { describe, expect, it } from "vitest";
import { droppedPaths } from "./dropped.ts";

describe("droppedPaths", () => {
  it("order preserved, empty paths dropped", () => {
    expect(droppedPaths(["/a", "", "/b", ""], (f) => f)).toEqual(["/a", "/b"]);
  });
  it("an empty list — an empty array", () => {
    expect(droppedPaths([], (f: string) => f)).toEqual([]);
  });
});
