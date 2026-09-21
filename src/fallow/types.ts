import type { SecurityFinding, SecurityOutput, SecuritySurvivorsOutput } from "fallow/types";

export type { SecurityFinding, SecurityOutput, SecuritySurvivorsOutput };

/** `fallow security` schema versions this release was verified against. */
export const SUPPORTED_SECURITY_SCHEMA_VERSIONS: readonly string[] = ["8"];

export const VERDICT_SCHEMA = "fallow-security-verdict/v1";
export const VERDICTS_SCHEMA = "fallow-security-verdicts/v1";

export type VerdictStatus = "survivor" | "dismissed" | "needs-human-review";

/** Common `fix_direction` values from the fallow verification recipe. */
export const FIX_DIRECTIONS = [
  "delete-dead-code",
  "validate-input",
  "escape-output",
  "avoid-shell",
  "restrict-url",
  "add-authz-check",
  "harden-config",
  "needs-design-review",
] as const;

export type FixDirection = (typeof FIX_DIRECTIONS)[number];

/**
 * Input contract of `fallow security survivors`. `evidence_checked` and
 * `dismissal_reason` are accepted by fallow but not rendered.
 */
export type FallowVerdict = {
  schema_version: typeof VERDICT_SCHEMA;
  finding_id: string;
  verdict: VerdictStatus;
  reason: string;
  confidence: string;
  impact: string | null;
  fix_direction: string | null;
  dismissal_reason: string | null;
  evidence_checked: {
    source: boolean;
    sink: boolean;
    boundary: boolean;
    trace: boolean;
    source_window: boolean;
  };
};

export type FallowVerdictsFile = {
  schema_version: typeof VERDICTS_SCHEMA;
  verdicts: FallowVerdict[];
};
