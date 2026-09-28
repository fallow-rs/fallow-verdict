import type { FindingRecord } from "../state/schema.ts";

export const REVIEW_VERDICTS_SCHEMA = "fallow-verdict-review-verdicts/v1";

export type ReviewVerdict = {
  finding_id: string;
  path: string;
  line: number;
  verdict: "survivor" | "dismissed" | "needs-human-review";
  rule: string;
  confidence: number;
  /** Model estimates: `has_bug`, `does_what_it_claims` and `rule:<name>` for each rule in scope. */
  probabilities: Record<string, number>;
  /** Kind data of the decision: function name, line range, `where` and rule breaches. */
  details: Record<string, unknown>;
  /** The reason of a person who closed the unit with `close`, or null. */
  closed_reason: string | null;
};

export type ReviewVerdictsFile = {
  schema_version: typeof REVIEW_VERDICTS_SCHEMA;
  /** Review mode is advisory. Fallow has no join command for these verdicts. */
  advisory: true;
  verdicts: ReviewVerdict[];
};

/**
 * The review verdict contract. Review units are not Fallow findings, so there is no Fallow join
 * and the file lives only in the fallow-verdict state directory. Ids come from the stored units.
 */
export const toReviewVerdicts = (
  records: readonly FindingRecord[],
  candidateIds: ReadonlySet<string>,
): ReviewVerdictsFile => ({
  schema_version: REVIEW_VERDICTS_SCHEMA,
  advisory: true,
  verdicts: records
    .filter(
      (record) =>
        candidateIds.has(record.finding_id) &&
        record.status === "judged" &&
        record.decision !== null,
    )
    .toSorted((a, b) => a.finding_id.localeCompare(b.finding_id))
    .flatMap((record) =>
      record.decision === null
        ? []
        : [
            {
              finding_id: record.finding_id,
              path: record.path,
              line: record.line,
              verdict: record.decision.verdict,
              rule: record.decision.rule,
              confidence: record.decision.confidence,
              probabilities: record.decision.probabilities,
              details: record.decision.kindData ?? {},
              closed_reason: record.closed?.reason ?? null,
            },
          ],
    ),
});
