import { verdictError, type VerdictError } from "../util/errors.ts";
import { err, ok, type Result } from "../util/result.ts";

/** Add-only. Each name has exactly one adapter in `src/kinds/registry.ts`. */
export const ANALYSIS_KINDS = ["security", "review", "similar-code"] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];

/**
 * The name of any analysis kind, registered or not. A kind name is also a directory name under
 * `kinds/` in the state directory, so it must be a safe path segment.
 */
export type KindName = string;

export const KIND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Records without a `kind` field were written before kinds existed and are security records. */
export const DEFAULT_KIND: AnalysisKind = "security";

export const parseKind = (raw: string): Result<AnalysisKind, VerdictError> =>
  (ANALYSIS_KINDS as readonly string[]).includes(raw)
    ? ok(raw as AnalysisKind)
    : err(
        verdictError(
          "config_invalid",
          `Unknown analysis kind \`${raw}\`. Known kinds: ${ANALYSIS_KINDS.join(", ")}.`,
        ),
      );
