import { describe, expect, it } from "vitest";

import { clearAll, remember, sizeOf } from "../src/cache.ts";
import { portOf } from "../src/config.ts";
import { greeter } from "../src/greeter.ts";
import { between, clampIndex } from "../src/math.ts";

describe("kill tests for labeled survivors", () => {
  it("71a0d5bdd477257f: clearAll removes the entries", () => {
    remember("x", 2);
    clearAll();
    expect(sizeOf("x")).toBe(0);
  });
  it("d20d3a4fa97c12a2: a stored null config gives the default port", () => {
    expect(portOf("null")).toBe(8080);
  });
  it("6b37d7e9972efa0d: a detached greet greets a stranger", () => {
    const greet = greeter.greet;
    expect(greet()).toBe("Hello, stranger");
  });
  it("a98502bc3684e090 685607d3fccd00ec: a negative length gives -1", () => {
    expect(clampIndex(0, -2)).toBe(-1);
  });
  it("0e88ac1677bf46e6: an index inside the list stays", () => {
    expect(clampIndex(2, 4)).toBe(2);
  });
  it("e7b761b188fe1f5d: an index equal to the length becomes the last index", () => {
    expect(clampIndex(4, 4)).toBe(3);
  });
  it("2b8cb9a89087ae0d e80dddc58414bcf9 5e1d5ba14b7c00ee: both bounds are included", () => {
    expect(between(1, 1, 9)).toBe(true);
    expect(between(9, 1, 9)).toBe(true);
    expect(between(10, 1, 9)).toBe(false);
  });
});
