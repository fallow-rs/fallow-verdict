import { describe, expect, it } from "vitest";

import { clearAll, remember, sizeOf } from "../src/cache.ts";

describe("cache", () => {
  it("remembers sizes", () => {
    remember("a", 3);
    expect(sizeOf("a")).toBe(3);
  });

  it("clears", () => {
    remember("b", 1);
    expect(clearAll()).toBeGreaterThan(0);
  });
});
