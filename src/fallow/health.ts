import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { verdictError, type VerdictError } from "../util/errors.ts";
import { err, ok, type Result } from "../util/result.ts";
import {
  capture,
  DEFAULT_TIMEOUT_MS,
  parseJson,
  resolveFallowBinary,
  type FallowInvocation,
} from "./run.ts";

/** `fallow health` schema versions this release was verified against. */
export const SUPPORTED_HEALTH_SCHEMA_VERSIONS: readonly string[] = ["11"];

/** `fallow health` exits 1 when it reports a finding; the JSON is complete in both cases. */
const EXIT_CODES_WITH_OUTPUT: ReadonlySet<number> = new Set([0, 1]);

/** The fields of a `fallow health` complexity finding that review mode reads. */
const healthFindingSchema = z.looseObject({
  path: z.string().min(1),
  name: z.string().min(1),
  /** 1-based. */
  line: z.number().int().min(1),
  /** 1-based. */
  col: z.number().int().min(0),
  cyclomatic: z.number(),
  cognitive: z.number(),
  line_count: z.number().int().min(1),
  severity: z.enum(["moderate", "high", "critical"]),
  /** Which thresholds the function exceeds. `crap` alone is a coverage signal, not complexity. */
  exceeded: z.string().optional(),
});

/** A hotspot exceeds a complexity threshold; an entry for the CRAP score alone does not count. */
const CRAP_ONLY = "crap";

export type HealthFunction = z.infer<typeof healthFindingSchema>;

export type HealthResult = {
  /** Null when no Fallow run was needed, because every requested path is missing. */
  version: string | null;
  functions: HealthFunction[];
  /** Requested paths that exist, so the result covers them. */
  listed: string[];
  /** Requested paths that do not exist. They have no functions. */
  missing: string[];
};

export type HealthScanOptions = FallowInvocation & {
  changedSince?: string | undefined;
  paths?: readonly string[] | undefined;
  /**
   * List every function in scope, not only the functions above the project thresholds. Fallow
   * reports a function only when it exceeds a threshold, so thresholds of zero list them all.
   */
  everyFunction: boolean;
};

const inScope = (root: string, scopes: readonly string[], file: string): boolean =>
  scopes.some((scope) => {
    const relative = path.relative(path.resolve(root, scope), path.resolve(root, file));
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  });

const parseHealth = (value: unknown): Result<HealthResult, VerdictError> => {
  const envelope = z
    .looseObject({
      schema_version: z.unknown(),
      version: z.unknown(),
      findings: z.array(z.unknown()),
    })
    .safeParse(value);
  if (!envelope.success)
    return err(
      verdictError(
        "fallow_output_invalid",
        "Expected `fallow health --format json` output with a `findings` array.",
      ),
    );
  const version = String(envelope.data.schema_version);
  if (!SUPPORTED_HEALTH_SCHEMA_VERSIONS.includes(version))
    return err(
      verdictError(
        "fallow_schema_unsupported",
        `fallow health schema_version ${version} is not supported (supported: ${SUPPORTED_HEALTH_SCHEMA_VERSIONS.join(", ")}).`,
        "Upgrade fallow-verdict, or pin a fallow version it supports.",
      ),
    );
  const functions = z.array(healthFindingSchema).safeParse(envelope.data.findings);
  if (!functions.success)
    return err(
      verdictError(
        "fallow_output_invalid",
        "Each fallow health finding needs a path, a name, a line, a column and a line count.",
      ),
    );
  return ok({
    version: String(envelope.data.version),
    functions: functions.data,
    listed: [],
    missing: [],
  });
};

/** One `fallow health` run, with at most one positional path. */
const runOnce = async (
  options: HealthScanOptions,
  scope: string | null,
): Promise<Result<HealthResult, VerdictError>> => {
  const binary = resolveFallowBinary(options.root, options.binary);
  const args = ["health", "--complexity", "--format", "json", "--quiet"];
  if (options.everyFunction) args.push("--max-cyclomatic", "0", "--max-cognitive", "0");
  if (options.changedSince !== undefined) args.push("--changed-since", options.changedSince);
  if (scope !== null) args.push(scope);
  const captured = await capture(
    binary,
    args,
    options.root,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.signal,
  );
  if (!captured.ok) return captured;
  if (!EXIT_CODES_WITH_OUTPUT.has(captured.data.code)) {
    const detail = captured.data.stderr.trim() || captured.data.stdout.trim().slice(0, 400);
    return err(
      verdictError("fallow_failed", `fallow exited with ${captured.data.code}: ${detail}`),
    );
  }
  const parsed = parseJson(captured.data.stdout);
  if (!parsed.ok) return parsed;
  const health = parseHealth(parsed.data);
  if (!health.ok || options.everyFunction) return health;
  return ok({
    ...health.data,
    functions: health.data.functions.filter((fn) => fn.exceeded !== CRAP_ONLY),
  });
};

/**
 * Runs `fallow health` for complexity findings only, and returns the functions in scope. A
 * missing path has no functions and is never passed to Fallow, because Fallow rejects it. With
 * `everyFunction`, each path gets its own run, so the output covers only the requested paths.
 */
export const runHealthScan = async (
  options: HealthScanOptions,
): Promise<Result<HealthResult, VerdictError>> => {
  const requested = options.paths ?? [];
  const listed = requested.filter((scope) => existsSync(path.resolve(options.root, scope)));
  const missing = requested.filter((scope) => !listed.includes(scope));
  if (requested.length > 0 && listed.length === 0)
    return ok({ version: null, functions: [], listed, missing });

  // One run over the project suffices for hotspots; a list of every function stays per path.
  const scopes: (string | null)[] =
    listed.length === 0 ? [null] : listed.length === 1 || options.everyFunction ? listed : [null];
  const result: HealthResult = { version: null, functions: [], listed, missing };
  const seen = new Set<string>();
  for (const scope of scopes) {
    const run = await runOnce(options, scope);
    if (!run.ok) return run;
    result.version ??= run.data.version;
    for (const fn of run.data.functions) {
      const key = JSON.stringify([fn.path, fn.line, fn.col]);
      if (seen.has(key) || (listed.length > 0 && !inScope(options.root, listed, fn.path))) continue;
      seen.add(key);
      result.functions.push(fn);
    }
  }
  return ok(result);
};
