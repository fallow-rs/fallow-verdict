import { describe, expect, it } from "vitest";

import { countWhere, largest, page } from "../src/list.ts";

describe("list", () => {
  it("pages", () => {
    expect(page([1, 2, 3, 4], 1, 2)).toEqual([2, 3]);
    expect(page([1, 2], 5, 2)).toEqual([]);
  });

  it("counts", () => {
    expect(countWhere([1, 2, 3, 4], (value) => value % 2 === 0)).toBe(2);
  });

  it("finds the largest value", () => {
    expect(largest([3, 9, 4])).toBe(9);
    expect(largest([])).toBeUndefined();
  });
});
