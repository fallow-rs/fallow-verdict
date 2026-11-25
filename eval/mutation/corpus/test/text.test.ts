import { describe, expect, it } from "vitest";

import { joinWords, startsWithIgnoreCase, truncate } from "../src/text.ts";

describe("text", () => {
  it("joins words", () => {
    expect(joinWords(["a", "", "b"])).toBe("a b");
  });

  it("matches a prefix", () => {
    expect(startsWithIgnoreCase("Hello", "he")).toBe(true);
    expect(startsWithIgnoreCase("Hello", "lo")).toBe(false);
  });

  it("truncates", () => {
    expect(truncate("abcdef", 3)).toBe("abc...");
    expect(truncate("ab", 3)).toBe("ab");
  });
});
