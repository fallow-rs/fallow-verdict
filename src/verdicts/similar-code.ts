import {
  SIMILAR_CODE_VERDICT_SCHEMA,
  type SimilarCodeOutput,
  type SimilarCodeVerdictInput,
} from "../fallow/similar-code.ts";
import { UNCONFIRMED_RULES } from "../policy/confirm.ts";
import { SIMILAR_CODE_OUTCOMES, type SimilarCodeOutcome } from "../questions/similar-code.ts";
import type { FindingRecord } from "../state/schema.ts";

type Verdict = SimilarCodeVerdictInput["verdicts"][number];

/** Fallow accepts 1 through 4000 characters without control characters. */
const MAX_RATIONALE_CHARS = 4000;

/** Shared rules of a verdict that a second call did not confirm. */
const UNCONFIRMED: ReadonlySet<string> = new Set(Object.values(UNCONFIRMED_RULES));

const rationaleOf = (text: string): string => {
  // oxlint-disable-next-line no-control-regex -- Fallow rejects control characters.
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  const bounded = [...clean].slice(0, MAX_RATIONALE_CHARS).join("");
  return bounded.length > 0 ? bounded : "No assessment is available.";
};

const axisOf = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const outcomeOf = (value: unknown): SimilarCodeOutcome =>
  typeof value === "string" && (SIMILAR_CODE_OUTCOMES as readonly string[]).includes(value)
    ? (value as SimilarCodeOutcome)
    : "needs-human-review";

/** An abstention: every axis unknown. Fallow needs a verdict for each candidate. */
const abstain = (
  base: Pick<Verdict, "candidate_id" | "review_key">,
  rationale: string,
): Verdict => ({
  ...base,
  candidate_worthy: null,
  behaviorally_equivalent: null,
  refactor_safe: null,
  outcome: "needs-human-review",
  rationale: rationaleOf(rationale),
});

const toVerdict = (
  base: Pick<Verdict, "candidate_id" | "review_key">,
  record: FindingRecord | undefined,
): Verdict => {
  if (record === undefined) return abstain(base, "fallow-verdict has no record of this candidate.");
  // A person decided to keep both functions. The reason is theirs; the axes stay unknown.
  if (record.closed !== undefined)
    return {
      ...abstain(base, `Closed by a person: ${record.closed.reason}`),
      outcome: "intentional-duplication",
    };
  const { decision } = record;
  if (record.status !== "judged" || decision === null)
    return abstain(base, "Not assessed. Run fallow-verdict judge --kind similar-code.");
  // A verdict that a second call did not confirm says nothing certain about the axes.
  if (UNCONFIRMED.has(decision.rule)) return abstain(base, decision.reason);
  const data = decision.kindData ?? {};
  const outcome =
    decision.verdict === "needs-human-review" ? "needs-human-review" : outcomeOf(data["outcome"]);
  return {
    ...base,
    candidate_worthy: axisOf(data["candidate_worthy"]),
    behaviorally_equivalent: axisOf(data["behaviorally_equivalent"]),
    refactor_safe: axisOf(data["refactor_safe"]),
    outcome,
    rationale: rationaleOf(decision.reason),
  };
};

/**
 * Builds the `fallow similar-code review` input: one verdict for each candidate of the stored
 * discovery document, so `--require-verdict-for-each-candidate` holds. The ids and review keys
 * come from the discovery document, never from an engine response.
 */
export const toSimilarCodeVerdicts = (
  records: readonly FindingRecord[],
  candidateIds: ReadonlySet<string>,
  output: SimilarCodeOutput,
): SimilarCodeVerdictInput => {
  const byId = new Map(records.map((record) => [record.finding_id, record]));
  return {
    schema_version: SIMILAR_CODE_VERDICT_SCHEMA,
    verdicts: output.candidates
      .filter((candidate) => candidateIds.has(candidate.candidate_id))
      .map((candidate) =>
        toVerdict(
          { candidate_id: candidate.candidate_id, review_key: candidate.review_key },
          byId.get(candidate.candidate_id),
        ),
      ),
  };
};
