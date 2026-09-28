import { createHash } from "node:crypto";

import type { BuiltEvidence } from "../kinds/adapter.ts";
import { numberLines } from "../packet/windows.ts";
import { estimateTokens } from "../util/tokens.ts";
import { sourceHash, unitLines, type ReviewUnit } from "./units.ts";

export const REVIEW_PACKET_SCHEMA = "fallow-verdict-review-input/v1";

/**
 * `fallow trace` gives the modules that import a symbol and the imports of its module. It gives no
 * function-level callers or callees, so the packet holds the module imports as the only context.
 */
export const CONTEXT_NOTE =
  "Fallow gives no function-level callers or callees. The imports of the module are the only context outside the function.";

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|\*\/)/;
const IMPORT_START = /^\s*import[\s{*"']/;
const IMPORT_END = /(from\s*["'][^"']*["']|^\s*import\s*["'][^"']*["']|;)\s*$/;

export type ReviewPacket = {
  schema_version: typeof REVIEW_PACKET_SCHEMA;
  unit: {
    path: string;
    name: string;
    start_line: number;
    end_line: number;
    cyclomatic: number;
    cognitive: number;
  };
  /** Numbered comment lines directly above the function, or null. */
  leading_comment: string | null;
  /** Numbered import statements of the module, or null. */
  imports: string | null;
  context_note: string;
  /** Numbered source of the function. */
  source: string;
  /** Parts that were left out to fit the token budget. */
  omitted: string[];
};

export type BuiltReview = BuiltEvidence & {
  packet: ReviewPacket;
  /** The source lines in the packet, for the `where` options. Empty when the source is missing. */
  lines: { start: number; end: number } | null;
  /** The function source differs from the source at scan time, or cannot be read. */
  sourceChanged: boolean;
};

const leadingComment = (file: readonly string[], line: number): string | null => {
  let first = line;
  while (first > 1 && COMMENT_LINE.test(file[first - 2] ?? "")) first -= 1;
  return first === line ? null : numberLines(file.slice(first - 1, line - 1), first);
};

const imports = (file: readonly string[], before: number): string | null => {
  const blocks: string[] = [];
  let open: { start: number; lines: string[] } | null = null;
  for (let index = 0; index < Math.min(file.length, before - 1); index += 1) {
    const text = file[index] ?? "";
    if (open === null && IMPORT_START.test(text)) open = { start: index + 1, lines: [] };
    if (open === null) continue;
    open.lines.push(text);
    if (IMPORT_END.test(text)) {
      blocks.push(numberLines(open.lines, open.start));
      open = null;
    }
  }
  return blocks.length === 0 ? null : blocks.join("\n");
};

const fingerprintOf = (packet: ReviewPacket): string =>
  createHash("sha256").update(JSON.stringify(packet)).digest("hex");

const finish = (
  packet: ReviewPacket,
  lines: BuiltReview["lines"],
  sourceChanged: boolean,
): BuiltReview => ({
  fingerprint: fingerprintOf(packet),
  stateTokens: estimateTokens(packet),
  packet,
  truncated: packet.omitted.length > 0,
  lines,
  sourceChanged,
});

/**
 * Builds the evidence for one function from the source on disk. When the packet exceeds the
 * token budget, the imports go first, then the leading comment, then source lines from the end.
 */
export const buildReviewPacket = async (
  unit: ReviewUnit,
  root: string,
  maxStateTokens: number,
): Promise<BuiltReview> => {
  const read = await unitLines(root, unit);
  const header: ReviewPacket = {
    schema_version: REVIEW_PACKET_SCHEMA,
    unit: {
      path: unit.path,
      name: unit.name,
      start_line: unit.line,
      end_line: unit.end_line,
      cyclomatic: unit.cyclomatic,
      cognitive: unit.cognitive,
    },
    leading_comment: null,
    imports: null,
    context_note: CONTEXT_NOTE,
    source: "",
    omitted: [],
  };
  if (read === null) return finish({ ...header, omitted: ["source"] }, null, true);

  const sourceChanged = sourceHash(read.lines) !== unit.source_hash;
  let packet: ReviewPacket = {
    ...header,
    leading_comment: leadingComment(read.file, unit.line),
    imports: imports(read.file, unit.line),
    source: numberLines(read.lines, unit.line),
  };
  const fits = (candidate: ReviewPacket): boolean => estimateTokens(candidate) <= maxStateTokens;
  if (!fits(packet) && packet.imports !== null)
    packet = { ...packet, imports: null, omitted: [...packet.omitted, "imports"] };
  if (!fits(packet) && packet.leading_comment !== null)
    packet = { ...packet, leading_comment: null, omitted: [...packet.omitted, "leading comment"] };
  let kept = read.lines.length;
  while (!fits(packet) && kept > 1) {
    kept = Math.max(1, Math.floor(kept * 0.8));
    packet = {
      ...packet,
      source: numberLines(read.lines.slice(0, kept), unit.line),
      omitted: [
        ...packet.omitted.filter((part) => !part.startsWith("source after")),
        `source after line ${unit.line + kept - 1}`,
      ],
    };
  }
  // A first line that alone exceeds the budget, for example minified code, is cut too.
  const [first = ""] = read.lines;
  let chars = first.length;
  while (!fits(packet) && chars > 0) {
    chars = Math.floor(chars * 0.8);
    packet = {
      ...packet,
      source: numberLines([first.slice(0, chars)], unit.line),
      omitted: [
        ...packet.omitted.filter(
          (part) => !part.startsWith("source after") && !part.startsWith("line "),
        ),
        `line ${unit.line} after character ${chars}`,
        ...(read.lines.length > 1 ? [`source after line ${unit.line}`] : []),
      ],
    };
  }
  return finish(packet, { start: unit.line, end: unit.line + kept - 1 }, sourceChanged);
};
