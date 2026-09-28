import { createHash } from "node:crypto";

import { z } from "zod";

import type { LoadedConfig } from "../config/load.ts";
import { runHealthScan, type HealthFunction, type HealthScanOptions } from "../fallow/health.ts";
import type { ScanScope } from "../kinds/adapter.ts";
import { readContained } from "../packet/windows.ts";
import { verdictError, type VerdictError } from "../util/errors.ts";
import { err, ok, type Result } from "../util/result.ts";

export const REVIEW_UNITS_SCHEMA = "fallow-verdict-review-units/v1";

/**
 * Why a function is in the review scope. `hotspot`: Fallow health reports it above the project
 * complexity thresholds. `changed`: it is in a file changed since `--changed-since`. `path`: it is
 * in a file or directory named on the command line.
 */
const selectedSchema = z.enum(["hotspot", "changed", "path"]);
const hotspotSchema = z.enum(["critical", "high", "moderate"]);

const unitSchema = z.object({
  /** Path, name, source hash, and an occurrence number when the same three repeat in a file. */
  finding_id: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  /** 1-based first line of the function, from Fallow. */
  line: z.number().int().min(1),
  /** 1-based column of the function, from Fallow. */
  col: z.number().int().min(0),
  end_line: z.number().int().min(1),
  cyclomatic: z.number(),
  cognitive: z.number(),
  /** The Fallow health severity when the function is a hotspot, otherwise null. */
  hotspot: hotspotSchema.nullable(),
  selected: z.array(selectedSchema).min(1),
  /** SHA-256 of the function source at scan time. An edit gives a new unit. */
  source_hash: z.string().min(1),
});

export const reviewOutputSchema = z.object({
  schema_version: z.literal(REVIEW_UNITS_SCHEMA),
  /** Version of the Fallow binary that selected the units. */
  fallow_version: z.string(),
  /** Functions in scope before `review.maxUnits` was applied. */
  in_scope: z.number().int().min(0),
  units: z.array(unitSchema),
});

export type ReviewUnit = z.infer<typeof unitSchema>;
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;
export type Hotspot = z.infer<typeof hotspotSchema>;
type Selected = z.infer<typeof selectedSchema>;

const HOTSPOT_RANK: Readonly<Record<Hotspot, number>> = { critical: 0, high: 1, moderate: 2 };
/** After every hotspot severity. */
const NO_HOTSPOT_RANK = 3;
const HASH_LENGTH = 12;

export const hotspotRank = (hotspot: Hotspot | null): number =>
  hotspot === null ? NO_HOTSPOT_RANK : HOTSPOT_RANK[hotspot];

/** Every function in one scope, and the reason that the scope selects them. */
export type ScopedFunctions = { functions: readonly HealthFunction[]; reason: Selected };

/** A function in scope, before its source is read. */
export type Selection = Omit<ReviewUnit, "finding_id" | "source_hash">;

const toSelection = (fn: HealthFunction, hotspot: boolean, reason: Selected): Selection => ({
  path: fn.path,
  name: fn.name,
  line: fn.line,
  col: fn.col,
  end_line: fn.line + fn.line_count - 1,
  cyclomatic: fn.cyclomatic,
  cognitive: fn.cognitive,
  hotspot: hotspot ? fn.severity : null,
  selected: [reason],
});

const byRisk = (a: Selection, b: Selection): number =>
  hotspotRank(a.hotspot) - hotspotRank(b.hotspot) ||
  b.cognitive - a.cognitive ||
  b.cyclomatic - a.cyclomatic ||
  b.end_line - b.line - (a.end_line - a.line) ||
  a.path.localeCompare(b.path) ||
  a.line - b.line;

const merge = (target: Selection, other: Selection): void => {
  if (hotspotRank(other.hotspot) < hotspotRank(target.hotspot)) target.hotspot = other.hotspot;
  for (const reason of other.selected)
    if (!target.selected.includes(reason)) target.selected.push(reason);
  target.cognitive = Math.max(target.cognitive, other.cognitive);
  target.cyclomatic = Math.max(target.cyclomatic, other.cyclomatic);
};

/**
 * Keeps the outermost functions. A nested function is part of the source of the function around
 * it, so it adds no unit; its hotspot severity and its selection reasons move to the outer one.
 */
const outermost = (selections: readonly Selection[]): Selection[] => {
  const sorted = selections.toSorted(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || b.end_line - a.end_line,
  );
  const kept: Selection[] = [];
  for (const selection of sorted) {
    const outer = kept.findLast(
      (candidate) =>
        candidate.path === selection.path &&
        candidate.line <= selection.line &&
        candidate.end_line >= selection.end_line,
    );
    if (outer === undefined) kept.push({ ...selection, selected: [...selection.selected] });
    else merge(outer, selection);
  }
  return kept;
};

/**
 * Selects the functions to review: the hotspots, plus every function in the scoped files when a
 * scope is given. Highest risk first: hotspot severity, then cognitive and cyclomatic complexity.
 */
export const selectUnits = (
  hotspots: readonly HealthFunction[],
  scopes: readonly ScopedFunctions[],
): Selection[] => {
  const byLocation = new Map<string, Selection>();
  const add = (selection: Selection): void => {
    const key = JSON.stringify([selection.path, selection.line, selection.col]);
    const known = byLocation.get(key);
    if (known === undefined) byLocation.set(key, selection);
    else merge(known, selection);
  };
  for (const fn of hotspots) add(toSelection(fn, true, "hotspot"));
  for (const scoped of scopes)
    for (const fn of scoped.functions) add(toSelection(fn, false, scoped.reason));
  return outermost([...byLocation.values()]).toSorted(byRisk);
};

export const sourceHash = (lines: readonly string[]): string =>
  createHash("sha256").update(lines.join("\n")).digest("hex");

/** The source lines of a unit, or null when the file cannot be read or is shorter now. */
export const unitLines = async (
  root: string,
  unit: Pick<ReviewUnit, "path" | "line" | "end_line">,
): Promise<{ file: string[]; lines: string[] } | null> => {
  const file = await readContained(root, unit.path);
  if (file === null || unit.line > file.length) return null;
  return { file, lines: file.slice(unit.line - 1, Math.min(unit.end_line, file.length)) };
};

/** Adds the source hash and the finding id. A unit whose file cannot be read is left out. */
export const identify = async (
  root: string,
  selections: readonly Selection[],
): Promise<ReviewUnit[]> => {
  const units: ReviewUnit[] = [];
  const seen = new Map<string, number>();
  for (const selection of selections) {
    const source = await unitLines(root, selection);
    if (source === null) continue;
    const hash = sourceHash(source.lines);
    const base = `review:${selection.path}:${selection.name}:${hash.slice(0, HASH_LENGTH)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    units.push({
      ...selection,
      finding_id: count === 1 ? base : `${base}#${count}`,
      source_hash: hash,
    });
  }
  return units;
};

export const parseReviewOutput = (value: unknown): Result<ReviewOutput, VerdictError> => {
  const parsed = reviewOutputSchema.safeParse(value);
  if (!parsed.success)
    return err(
      verdictError("state_corrupt", "The saved review units are invalid. Run scan again."),
    );
  const ids = parsed.data.units.map((unit) => unit.finding_id);
  if (new Set(ids).size !== ids.length)
    return err(verdictError("state_corrupt", "The saved review units repeat a finding id."));
  return ok(parsed.data);
};

const scopedRun = async (
  invocation: Omit<HealthScanOptions, "everyFunction" | "paths">,
  paths: readonly string[] | undefined,
  reason: Selected,
): Promise<Result<ScopedFunctions, VerdictError>> => {
  const listed = await runHealthScan({ ...invocation, paths, everyFunction: true });
  return listed.ok ? ok({ functions: listed.data.functions, reason }) : listed;
};

/**
 * Runs Fallow health once for the hotspots and, with a scope, once for every function in scope.
 * The result is capped at `review.maxUnits`, highest risk first. The cap never drops a function
 * in a file of `scope.complete`, so `check` sees every function of its target files.
 */
export const runReviewScan = async (
  loaded: LoadedConfig,
  scope: ScanScope,
): Promise<Result<ReviewOutput, VerdictError>> => {
  const invocation = {
    root: loaded.root,
    binary: loaded.config.fallow.binary,
    timeoutMs: loaded.config.fallow.timeoutMs,
    changedSince: scope.changedSince,
    signal: scope.signal,
  };
  const hotspots = await runHealthScan({ ...invocation, paths: scope.paths, everyFunction: false });
  if (!hotspots.ok) return hotspots;
  const scopes: ScopedFunctions[] = [];
  if (scope.changedSince !== undefined || (scope.paths?.length ?? 0) > 0) {
    const reason = scope.changedSince === undefined ? "path" : "changed";
    const listed = await scopedRun(invocation, scope.paths, reason);
    if (!listed.ok) return listed;
    scopes.push(listed.data);
  }
  const complete = scope.complete ?? [];
  if (complete.length > 0) {
    const listed = await scopedRun({ ...invocation, changedSince: undefined }, complete, "path");
    if (!listed.ok) return listed;
    scopes.push(listed.data);
  }
  const selections = selectUnits(hotspots.data.functions, scopes);
  const inComplete = (selection: Selection): boolean =>
    complete.some((file) => selection.path === file || selection.path.startsWith(`${file}/`));
  const kept = selections.filter(
    (selection, index) => index < loaded.config.review.maxUnits || inComplete(selection),
  );
  return ok({
    schema_version: REVIEW_UNITS_SCHEMA,
    fallow_version: hotspots.data.version,
    in_scope: selections.length,
    units: await identify(loaded.root, kept),
  });
};
