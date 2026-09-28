import { z } from "zod";

import {
  VERDICT_SCHEMA,
  VERDICTS_SCHEMA,
  type FallowVerdict,
  type FallowVerdictsFile,
} from "../fallow/types.ts";
import type { FindingRecord } from "../state/schema.ts";

/** The evidence summary that the security adapter stores on each record. */
export const securityEvidenceSchema = z.object({
  truncated: z.boolean(),
  windows: z.number(),
  hasSource: z.boolean(),
  hasTrace: z.boolean(),
});

export type SecurityEvidence = z.infer<typeof securityEvidenceSchema>;

const toVerdict = (record: FindingRecord): FallowVerdict | null => {
  const { decision } = record;
  const parsed = securityEvidenceSchema.safeParse(record.evidence);
  // Missing or foreign evidence counts as not checked.
  const evidence = parsed.success ? parsed.data : null;
  if (record.status !== "judged" || decision === null) return null;
  return {
    schema_version: VERDICT_SCHEMA,
    // Taken from the stored candidate, never from the engine, so a response cannot redirect a verdict.
    finding_id: record.finding_id,
    verdict: decision.verdict,
    reason: decision.reason,
    confidence: decision.confidence.toFixed(2),
    impact: decision.impact
      ? `${decision.impact.label} (${decision.impact.score.toFixed(1)}/3)`
      : null,
    fix_direction: decision.fixDirection,
    dismissal_reason: decision.dismissalReason,
    evidence_checked: {
      source: evidence?.hasSource ?? false,
      sink: (evidence?.windows ?? 0) > 0,
      boundary: true,
      trace: evidence?.hasTrace ?? false,
      source_window: (evidence?.windows ?? 0) > 0,
    },
  };
};

/**
 * Builds the `fallow security survivors` input. fallow rejects verdicts for
 * finding ids it does not know, so the file is limited to the current candidate set.
 */
export const toVerdictsFile = (
  records: readonly FindingRecord[],
  candidateIds: ReadonlySet<string>,
): FallowVerdictsFile => ({
  schema_version: VERDICTS_SCHEMA,
  verdicts: records
    .filter((record) => candidateIds.has(record.finding_id))
    .map(toVerdict)
    .filter((verdict) => verdict !== null),
});
