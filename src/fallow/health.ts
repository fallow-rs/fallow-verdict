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
});

export type HealthFunction = z.infer<typeof healthFindingSchema>;

export type HealthResult = { version: string; functions: HealthFunction[] };

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
  return ok({ version: String(envelope.data.version), functions: functions.data });
};

/** Runs `fallow health` for complexity findings only, and returns the functions in scope. */
export const runHealthScan = async (
  options: HealthScanOptions,
): Promise<Result<HealthResult, VerdictError>> => {
  const binary = resolveFallowBinary(options.root, options.binary);
  const args = ["health", "--complexity", "--format", "json", "--quiet"];
  if (options.everyFunction) args.push("--max-cyclomatic", "0", "--max-cognitive", "0");
  if (options.changedSince !== undefined) args.push("--changed-since", options.changedSince);
  const paths = options.paths ?? [];
  // Fallow's positional scope takes one path; a union of paths is filtered locally below.
  const [only] = paths;
  if (paths.length === 1 && only !== undefined) args.push(only);

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
  if (!health.ok || paths.length === 0) return health;
  return ok({
    ...health.data,
    functions: health.data.functions.filter((fn) => inScope(options.root, paths, fn.path)),
  });
};
