import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

export type WindowRole = "sink" | "source" | "trace" | "control";

export type Location = { path: string; line: number; role: WindowRole };

export type SourceWindow = {
  path: string;
  start_line: number;
  end_line: number;
  roles: WindowRole[];
  text: string;
};

type Span = { start: number; end: number; roles: Set<WindowRole> };

const LINE_NUMBER_WIDTH = 5;

/** Merges overlapping or adjacent spans so a line is never sent twice. */
const mergeSpans = (spans: Span[]): Span[] => {
  const sorted = spans.toSorted((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end + 1) {
      last.end = Math.max(last.end, span.end);
      for (const role of span.roles) last.roles.add(role);
    } else {
      merged.push({ start: span.start, end: span.end, roles: new Set(span.roles) });
    }
  }
  return merged;
};

const numberLines = (lines: readonly string[], start: number): string =>
  lines
    .map((line, index) => `${String(start + index).padStart(LINE_NUMBER_WIDTH)}| ${line}`)
    .join("\n");

/**
 * Candidate paths come from a JSON file on disk. Resolving through realpath keeps a
 * crafted or symlinked path from pulling files outside the project into a request.
 */
const readContained = async (root: string, relative: string): Promise<string[] | null> => {
  try {
    const realRoot = await realpath(root);
    const resolved = await realpath(path.resolve(realRoot, relative));
    if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) return null;
    return (await readFile(resolved, "utf8")).split(/\r?\n/);
  } catch {
    return null;
  }
};

export type WindowResult = { windows: SourceWindow[]; unreadable: string[] };

export const collectWindows = async (
  root: string,
  locations: readonly Location[],
  radius: number,
): Promise<WindowResult> => {
  const byPath = new Map<string, Location[]>();
  for (const location of locations) {
    const list = byPath.get(location.path) ?? [];
    list.push(location);
    byPath.set(location.path, list);
  }

  const windows: SourceWindow[] = [];
  const unreadable: string[] = [];
  for (const [file, fileLocations] of byPath) {
    const lines = await readContained(root, file);
    if (lines === null) {
      unreadable.push(file);
      continue;
    }
    const spans = fileLocations.map((location) => ({
      start: Math.max(1, location.line - radius),
      end: Math.min(lines.length, location.line + radius),
      roles: new Set<WindowRole>([location.role]),
    }));
    for (const span of mergeSpans(spans)) {
      windows.push({
        path: file,
        start_line: span.start,
        end_line: span.end,
        roles: [...span.roles].toSorted(),
        text: numberLines(lines.slice(span.start - 1, span.end), span.start),
      });
    }
  }
  return { windows, unreadable };
};
