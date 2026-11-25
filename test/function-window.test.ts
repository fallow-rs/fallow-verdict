import { describe, expect, it } from "vitest";

import { functionWindow } from "../src/packet/function-window.ts";

const lines = (text: string): string[] => text.split("\n");

describe("functionWindow", () => {
  it.each([
    [
      "a block body",
      [
        "export const page = (items, offset) => {",
        "  if (offset >= items.length) return [];",
        "  return items;",
        "};",
        "",
        "export const next = 1;",
      ],
      1,
      2,
      { start: 1, end: 4, cut: false },
    ],
    [
      "a one-line arrow body",
      [
        "export const a = 1;",
        "export const themeOf = (text) => load(text)?.theme;",
        "export const b = 2;",
      ],
      2,
      2,
      { start: 2, end: 2, cut: false },
    ],
    [
      "an arrow body on the next line",
      ["export const f = (a: number) =>", "  a + 1;", "export const g = 2;"],
      1,
      2,
      { start: 1, end: 2, cut: false },
    ],
    [
      "a method inside a class",
      ["class C {", "  value = 0;", "", "  read() {", "    return this?.value;", "  }", "}"],
      4,
      5,
      { start: 4, end: 6, cut: false },
    ],
    [
      "braces in strings, templates, comments and regular expressions",
      [
        "export const f = (s) => {",
        '  const a = "}";',
        "  const b = `${s}}`; // }",
        "  /* } */ const c = /[}\\/]+/.test(s);",
        "  return a + b + c;",
        "};",
        "export const g = 1;",
      ],
      1,
      5,
      { start: 1, end: 6, cut: false },
    ],
    [
      "a division, not a regular expression",
      [
        "export const f = (a, b) => {",
        "  const half = a / b / 2;",
        "  return { half };",
        "};",
        "const x = 1;",
      ],
      1,
      2,
      { start: 1, end: 4, cut: false },
    ],
  ])("finds %s", (_name, source, functionLine, mutantLine, expected) => {
    expect(functionWindow(source, functionLine, mutantLine, 50)).toEqual(expected);
  });

  it("cuts a function that is longer than the limit", () => {
    const body = Array.from({ length: 30 }, (_, index) => `  const v${index} = ${index};`);
    const source = ["export const f = () => {", ...body, "};"];
    expect(functionWindow(source, 1, 3, 10)).toEqual({ start: 1, end: 10, cut: true });
    expect(functionWindow(source, 1, 3, 40)).toEqual({ start: 1, end: 32, cut: false });
  });

  it("reports a cut window when the mutant line is outside the function", () => {
    const source = lines("const f = () => 1;\nconst g = 2;\nconst h = 3;");
    expect(functionWindow(source, 1, 9, 50).cut).toBe(true);
  });
});
