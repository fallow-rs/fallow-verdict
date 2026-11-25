import { describe, expect, it } from "vitest";

import { Counter, readAll } from "../src/counter.ts";

describe("Counter", () => {
  it("reads the value after increments", () => {
    const counter = new Counter();
    counter.increment();
    counter.increment();
    expect(counter.read()).toBe(2);
  });

  it("reads through bound readers", () => {
    const a = new Counter();
    a.increment();
    expect(readAll([() => a.read()])).toEqual([1]);
  });
});
