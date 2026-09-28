import {
  VERDICT_SCHEMA,
  VERDICTS_SCHEMA,
  type FallowVerdict,
  type FallowVerdictsFile,
} from "../fallow/types.ts";
import { securityEvidenceSchema, type FindingRecord } from "../state/schema.ts";

/** `dismissal_reason` of a verdict that a person closed with `close`. */
export const CLOSED_DISMISSAL_REASON = "closed-by-person";

const evidenceChecked = (record: FindingRecord): FallowVerdict["evidence_checked"] => {
  const parsed = securityEvidenceSchema.safeParse(record.evidence);
  // Missing or foreign evidence counts as not checked.
  const evidence = parsed.success ? parsed.data : null;
  return {
    source: evidence?.hasSource ?? false,
    sink: (evidence?.windows ?? 0) > 0,
    boundary: true,
    trace: evidence?.hasTrace ?? false,
    source_window: (evidence?.windows ?? 0) > 0,
  };
};

/**
 * A person closed the finding. The caller removes closures whose evidence changed before the
 * export, so a closure on the record is valid. Fallow takes `reason` as free text.
 */
const toClosedVerdict = (record: FindingRecord, reason: string): FallowVerdict => ({
  schema_version: VERDICT_SCHEMA,
  finding_id: record.finding_id,
  verdict: "dismissed",
  reason: `Closed by a person: ${reason}`,
  confidence: (1).toFixed(2),
  impact: null,
  fix_direction: null,
  dismissal_reason: CLOSED_DISMISSAL_REASON,
  evidence_checked: evidenceChecked(record),
});

const toVerdict = (record: FindingRecord): FallowVerdict | null => {
  const { decision } = record;
  if (record.closed !== undefined) return toClosedVerdict(record, record.closed.reason);
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
    evidence_checked: evidenceChecked(record),
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
