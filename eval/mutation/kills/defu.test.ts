import { describe, expect, it } from "vitest";

import { defu, defuArrayFn, defuFn } from "../src/defu";
import { isPlainObject } from "../src/_utils";

describe("kill tests for labeled survivors", () => {
  it("fd1cb26bf311e647: an object whose prototype has a null prototype is plain", () => {
    expect(isPlainObject(Object.create(Object.create(null)))).toBe(true);
  });
  it("0b925ddfed1f6f84: an array as defaults adds no index keys", () => {
    expect(defu({ a: 1 }, ["x"] as never)).toEqual({ a: 1 });
  });
  it("721e6e2a4b649daa 85b9902b4b9b181b bd1ea7ebbfbe0d6b: an own __proto__ key does not set the prototype", () => {
    const result = defu(JSON.parse('{"__proto__":{"polluted":1}}'), {}) as Record<string, unknown>;
    expect(result.polluted).toBeUndefined();
  });
  it("e298c86b257f48cb 623152674061ab30: an own constructor key is skipped", () => {
    expect(Object.keys(defu({ constructor: 1 } as never, {}))).toEqual([]);
  });
  it("20db0222efa86d15: an undefined value keeps the default", () => {
    expect(defu({ a: undefined }, { a: 1 })).toEqual({ a: 1 });
  });
  it("3b19f549898deb12: a plain default does not replace a number", () => {
    expect(defu({ a: 5 } as never, { a: { x: 1 } })).toEqual({ a: 5 });
  });
  it("65deeab050d17108: defuFn keeps a value that is not a function", () => {
    expect(defuFn({ a: 1 }, { a: 2 })).toEqual({ a: 1 });
  });
  it("8ab0e06a35823bce: defuArrayFn concatenates arrays without a function", () => {
    expect(defuArrayFn({ a: [1] }, { a: [2] })).toEqual({ a: [1, 2] });
  });
});
