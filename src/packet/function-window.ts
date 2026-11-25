/** The 1-based line range of a function. `cut`: the range does not hold the whole function. */
export type LineRange = { start: number; end: number; cut: boolean };

/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER_WORD: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/** Characters after which a `/` starts a regular expression. */
const REGEX_AFTER_CHAR = new Set("(,=:[!&|?{};+-*%<>~^");

const OPEN = new Set("([{");
const CLOSE = new Set(")]}");

const skipRegex = (line: string, start: number): number => {
  let index = start + 1;
  let inClass = false;
  while (index < line.length) {
    const char = line[index];
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) break;
    index += 1;
  }
  while (/[a-z]/i.test(line[index + 1] ?? "")) index += 1;
  return index;
};
const skipQuoted = (line: string, start: number, quote: string): number => {
  let index = start + 1;
  while (index < line.length && line[index] !== quote) index += line[index] === "\\" ? 2 : 1;
  return index;
};
/**
 * Tracks the bracket depth of JavaScript and TypeScript code line by line. It skips strings,
 * template text, comments and regular expressions, so a bracket inside them does not count.
 */
const createScanner = () => {
  let depth = 0;
  let blockComment = false;
  /** One entry for each open template literal: the bracket depth of its current `${`, or -1 in text. */
  const templates: number[] = [];
  let previous = "";

  const regexAllowed = (line: string, index: number): boolean => {
    if (previous === "" || REGEX_AFTER_CHAR.has(previous)) return true;
    const word = /([A-Za-z_$][\w$]*)\s*$/.exec(line.slice(0, index));
    return word !== null && /[A-Za-z_$]/.test(previous) && REGEX_AFTER_WORD.has(word[1] ?? "");
  };

  /** Scans one line in template text. Returns the index after the text, or the line length. */
  const scanTemplate = (line: string, start: number): number => {
    let index = start;
    while (index < line.length) {
      const char = line[index];
      if (char === "\\") index += 2;
      else if (char === "`") {
        templates.pop();
        previous = "`";
        return index + 1;
      } else if (char === "$" && line[index + 1] === "{") {
        templates[templates.length - 1] = depth;
        depth += 1;
        previous = "{";
        return index + 2;
      } else index += 1;
    }
    return index;
  };

  const closeBracket = (char: string): void => {
    depth -= 1;
    // The `}` that closes a `${` returns to the template text.
    if (char === "}" && templates.length > 0 && templates.at(-1) === depth)
      templates[templates.length - 1] = -1;
  };

  /**
   * Skips a comment, a string, a template start or a regular expression at `index`. Returns the
   * next index, or null when no such token starts there.
   */
  const skipToken = (line: string, index: number): number | null => {
    const char = line[index] ?? "";
    const next = line[index + 1];
    if (char === "/" && next === "/") return line.length;
    if (char === "/" && next === "*") {
      blockComment = true;
      return index + 2;
    }
    if (char === '"' || char === "'") {
      previous = char;
      return skipQuoted(line, index, char) + 1;
    }
    if (char === "`") {
      templates.push(-1);
      return index + 1;
    }
    if (char !== "/" || !regexAllowed(line, index)) return null;
    previous = "/";
    return skipRegex(line, index) + 1;
  };

  /** Scans one code token at `index`. Returns the next index. */
  const scanCode = (line: string, index: number): number => {
    const skipped = skipToken(line, index);
    if (skipped !== null) return skipped;
    const char = line[index] ?? "";
    if (OPEN.has(char)) depth += 1;
    else if (CLOSE.has(char)) closeBracket(char);
    if (!/\s/.test(char)) previous = char;
    return index + 1;
  };

  /** Skips to the end of a block comment. Returns the next index, or the line length. */
  const scanComment = (line: string, index: number): number => {
    const end = line.indexOf("*/", index);
    if (end === -1) return line.length;
    blockComment = false;
    return end + 2;
  };

  /** Scans one line and returns the bracket depth after it. */
  const scan = (line: string): number => {
    let index = 0;
    while (index < line.length) {
      if (blockComment) index = scanComment(line, index);
      else if (templates.at(-1) === -1) index = scanTemplate(line, index);
      else index = scanCode(line, index);
    }
    return depth;
  };

  return { scan };
};

const indentation = (line: string): number => line.length - line.trimStart().length;

/**
 * Finds the end of the function that starts at `functionLine` and holds `mutantLine`. The
 * function ends at the first line at or after the mutant where the brackets are balanced and
 * the next code line is not indented more than the first line. A function longer than
 * `maxLines` is cut at that limit.
 */
export const functionWindow = (
  lines: readonly string[],
  functionLine: number,
  mutantLine: number,
  maxLines: number,
): LineRange => {
  const start = functionLine;
  const baseIndent = indentation(lines[start - 1] ?? "");
  const scanner = createScanner();
  const last = Math.min(lines.length, start + maxLines - 1);
  for (let line = start; line <= last; line += 1) {
    const depth = scanner.scan(lines[line - 1] ?? "");
    if (depth < 0) return { start, end: line, cut: mutantLine > line };
    if (line < mutantLine || depth > 0) continue;
    const following = lines.slice(line).find((text) => text.trim().length > 0);
    if (following === undefined || indentation(following) <= baseIndent)
      return { start, end: line, cut: false };
  }
  return { start, end: last, cut: true };
};
