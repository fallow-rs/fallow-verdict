import { describe, expect, it } from "vitest";

import { Counter } from "../src/counter.ts";
import { largest, page } from "../src/list.ts";
import { themeOf } from "../src/settings.ts";
import { truncate } from "../src/text.ts";

describe("kill tests for labeled survivors", () => {
  it("e66b12a385a0c071: a detached read gives undefined", () => {
    const read = new Counter().read;
    expect(read()).toBeUndefined();
  });
  it("a60af096b11f6968 bc1a6d4aeb2bf5d4 de922067fa207ef7 20df8418de29f866 de0fbd2ea4270040: an empty page is a plain array", () => {
    class Tagged<T> extends Array<T> {}
    for (const [items, offset] of [
      [Tagged.from([1]), 5],
      [Tagged.from([1]), 1],
      [Tagged.from([]), 0],
    ] as const)
      expect(Object.getPrototypeOf(page(items, offset, 1))).toBe(Array.prototype);
  });
  it("c9cdd0a284339dca: a page holds size items", () => {
    expect(page([1, 2, 3], 0, 2)).toEqual([1, 2]);
  });
  it("d8d14c2ade9279b6: the first of equal values wins", () => {
    expect(largest([0, -0])).toBe(0);
  });
  it("07ea65f7c318c30a: stored null settings have no theme", () => {
    expect(themeOf("null")).toBeUndefined();
  });
  it("0ab0249adef9e6e3: a text of exactly max characters is not cut", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });
});
