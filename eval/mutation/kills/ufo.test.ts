import { describe, expect, it } from "vitest";

import { toASCII } from "../src/punycode";
import {
  $URL,
  encodeQueryValue,
  hasProtocol,
  isEmptyURL,
  isScriptProtocol,
  parseQuery,
  parseURL,
  resolveURL,
  withBase,
  withoutTrailingSlash,
} from "../src";

describe("kill tests for labeled survivors", () => {
  it("0010e2de30c8ac7a: an overflow names its error", () => {
    expect(() => toASCII("\u0080\u{10FFFF}".repeat(3000))).toThrow("Overflow Error");
  });
  it("0011e7cdb4f8fad6 1766864c5d708f9f 3bc35792842649f7: parseQuery skips __proto__ and constructor", () => {
    expect(Object.keys(parseQuery("__proto__=1&constructor=2&a=3"))).toEqual(["a"]);
    expect(Object.keys(parseQuery("constructor=2"))).toEqual([]);
  });
  it("02ca010103780c50 1439c89a20e8a96c: withBase keeps an input whose query follows the base", () => {
    expect(withBase("/admin?x=1", "/admin")).toBe("/admin?x=1");
  });
  it("041a98025db9468e: href of a protocol-relative URL", () => {
    expect(new $URL("//a.com/x").href).toBe(new $URL("//a.com/x").fullpath);
  });
  it("0eac384c2bfa53e9: append with a query only keeps the path", () => {
    const base = new $URL("/foo");
    base.append(new $URL("?a=1"));
    expect(base.pathname).toBe("/foo");
  });
  it("0f1ca820082c601e: an empty query has no search", () => {
    expect(new $URL("/foo").search).toBe("");
  });
  it("11b4822a56643892 2c0937ec9be8c7da: a lone low surrogate after a normal character", () => {
    const value = toASCII("é\uDC00.com");
    expect(value).toMatchInlineSnapshot(`"xn--9ca8823i.com"`);
  });
  it("1598d8ed84812e3e: a strict protocol check accepts leading spaces only as whitespace", () => {
    expect(hasProtocol(" https://a.com", { strict: true })).toBe(true);
    expect(hasProtocol("é://a.com", { strict: true })).toBe(false);
  });
  it("1623f27327e66eaf: parseQuery without a question mark", () => {
    expect(parseQuery("foo=bar")).toEqual({ foo: "bar" });
  });
  it("1d32c899c2c1a577: code point 128 is not a basic character", () => {
    expect(toASCII("\u0080.com")).toMatchInlineSnapshot(`"xn--a.com"`);
  });
  it("26af341cf400c8e8: a backtick stays in a query value", () => {
    expect(encodeQueryValue("a`b")).toBe("a`b");
  });
  it("2894b7ed72bce116 2fcba0b110b54b5c: only a whole script protocol counts", () => {
    expect(isScriptProtocol("javascript:alert(1)")).toBe(false);
    expect(isScriptProtocol("xjavascript:")).toBe(false);
    expect(isScriptProtocol("javascript:")).toBe(true);
  });
  it("2bf3bbe85744a46c: withoutTrailingSlash keeps a query-only input", () => {
    expect(withoutTrailingSlash("?a=1", true)).toBe("?a=1");
    expect(withoutTrailingSlash("#frag", true)).toBe("#frag");
  });
  it("30c218410cf7fcb3: the user part of an address stays as it is", () => {
    expect(toASCII("ü@ex.com")).toBe("ü@ex.com");
  });
  it("33d645c647696fb5: an empty query of a segment adds no question mark", () => {
    expect(resolveURL("http://a.com", "b?")).toBe("http://a.com/b");
  });
  it("35cf1cbd26e4149d: a surrogate pair other than U+D800", () => {
    expect(toASCII("😀.com")).toMatchInlineSnapshot(`"xn--e28h.com"`);
  });
  it("3766c6167893ddf0: parseURL uses the default protocol", () => {
    expect(parseURL("foo.com/bar", "https://").host).toBe("foo.com");
  });
  it("3a8c452da1581960: resolveURL with a query-only segment", () => {
    expect(resolveURL("http://a.com/foo", "?x=1")).toBe("http://a.com/foo?x=1");
  });
  it("3e05ff77c59f698e: an empty URL", () => {
    expect(isEmptyURL("")).toBe(true);
    expect(isEmptyURL("/")).toBe(true);
  });
});
