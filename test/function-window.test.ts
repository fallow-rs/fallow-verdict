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

/**
 * The function closes on the same line as the token. A token that hides the rest of the line,
 * or a bracket that the scanner counts by mistake, moves or loses the end.
 */
const body = (middle: string): string[] => [
  "export const f = (s) => {",
  `  ${middle} }`,
  "export const g = 1;",
];

describe("functionWindow token handling", () => {
  it.each([
    ["a regular expression with a slash in a class", "return /[/}]+/g.test(s);"],
    ["a regular expression with an escaped slash", "return /a\\/}/.test(s);"],
    ["a regular expression with a bracket after its class", "return /[a]}/.test(s);"],
    ["a regular expression at the start of a line", "/}/.test(s);"],
    ["a regular expression after typeof", "return typeof /}/;"],
    ["a regular expression after a keyword in a condition", "if (s) void /}/;"],
    ["a regular expression with flags", "return /}/gi;"],
    ["a division by a name", "return s / 2;"],
    ["a division after a closing bracket", "return (s) / 2;"],
    ["an escaped quote in a string", 'return "a\\"}";'],
    ["an escaped backslash at the end of a string", 'return "\\\\";'],
    ["a single-quoted string", "return '}';"],
    ["a brace inside a template expression", "return `${s}}`;"],
    ["an object inside a template expression", "return `${ { a: 1 }.a }}`;"],
    ["a dollar sign without a brace in a template", "return `$}`;"],
    ["an escaped character in a template", "return `\\`}`;"],
    ["a template after a template", "return `}` + `}`;"],
    ["a template inside a template expression", "return `${ `}` }`;"],
    ["a block comment on one line", "/* } */ return s;"],
  ])("handles %s", (_name, middle) => {
    expect(functionWindow(body(middle), 1, 2, 50)).toEqual({ start: 1, end: 2, cut: false });
  });

  it.each([
    ["a template inside a template expression", "  return `${ `}` }`;"],
    ["a closing brace in the text after a template expression", "  return `${s} }`;"],
  ])("keeps the function open over %s", (_name, middle) => {
    const source = ["export const f = (s) => {", middle, "};", "export const g = 1;"];
    expect(functionWindow(source, 1, 2, 50)).toEqual({ start: 1, end: 3, cut: false });
  });

  it("stops at a line comment", () => {
    const source = ["export const f = () => {", "  return 1; // }", "};", "const g = 1;"];
    expect(functionWindow(source, 1, 2, 50)).toEqual({ start: 1, end: 3, cut: false });
  });

  it("ignores braces in a block comment over several lines", () => {
    const source = [
      "export const f = () => {",
      "  /* {",
      "     { */",
      "  return 1;",
      "};",
      "export const g = 1;",
    ];
    expect(functionWindow(source, 1, 4, 50)).toEqual({ start: 1, end: 5, cut: false });
  });

  it("ends at the brace that closes the enclosing block", () => {
    const source = ["class C {", "  m() {", "    return 1;", "  } }", "const x = 1;"];
    expect(functionWindow(source, 2, 3, 50)).toEqual({ start: 2, end: 4, cut: false });
    expect(functionWindow(source, 2, 5, 50)).toEqual({ start: 2, end: 4, cut: true });
  });

  it("continues over a blank line and an indented continuation", () => {
    const source = [
      "  export const f = (a) =>",
      "",
      "    a",
      "      .trim();",
      "  export const g = 1;",
    ];
    expect(functionWindow(source, 1, 3, 50)).toEqual({ start: 1, end: 4, cut: false });
  });
});
