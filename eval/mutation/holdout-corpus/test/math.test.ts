import { describe, expect, it } from "vitest";

import { average, between, clampIndex } from "../src/math.ts";

describe("math", () => {
  it("clamps an index", () => {
    expect(clampIndex(-3, 4)).toBe(0);
    expect(clampIndex(9, 4)).toBe(3);
    expect(clampIndex(1, 0)).toBe(-1);
  });

  it("averages", () => {
    expect(average([2, 4])).toBe(3);
    expect(average([])).toBe(0);
  });

  it("checks a range", () => {
    expect(between(5, 1, 9)).toBe(true);
    expect(between(0, 1, 9)).toBe(false);
  });
});
