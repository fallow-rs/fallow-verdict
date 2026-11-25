import { MUTATION_VERDICT_SCHEMA } from "../fallow/mutation.ts";
import type { FindingRecord } from "../state/schema.ts";

/** One entry of Fallow's mutation verdict document. Fallow refuses unknown fields. */
export type MutationVerdict = { review_key: string; verdict: "equivalent"; note: string };

/** The proposal file: Fallow's verdict document schema, for a person to read and copy from. */
export type MutationProposals = {
  schema_version: typeof MUTATION_VERDICT_SCHEMA;
  verdicts: MutationVerdict[];
};

/** The name of the proposal file in the state directory. */
export const PROPOSALS_FILE = "mutation-verdicts.proposed.json";

const PROPOSED_RULE = "likely-equivalent";

const cleanNote = (text: string): string => text.replace(/\p{Cc}+/gu, " ").trim();

const noteOf = (record: FindingRecord): string => {
  const decision = record.decision;
  const option = decision?.dismissalReason ?? "unknown";
  const behavior = decision?.probabilities["behavior_changes"];
  const strength = decision?.probabilities[`equivalence:${option}`];
  const runId = record.history.at(-1)?.runId ?? "unknown";
  return cleanNote(
    `Proposed by fallow-verdict, not reviewed: equivalence ${option}` +
      (strength === undefined ? "" : ` (${strength.toFixed(2)})`) +
      `, P(behavior_changes) ${behavior === undefined ? "unknown" : behavior.toFixed(2)}` +
      `, decision ${PROPOSED_RULE} in run ${runId}.`,
  );
};

/**
 * Builds the proposal document. It holds one entry for each current mutant with a confirmed
 * `likely-equivalent` dismissal. The `review_key` is the stored `mutant_id`, never a value from an
 * engine response. A mutant that a person closed is not proposed: a closure accepts a test gap.
 */
export const toMutationProposals = (
  records: readonly FindingRecord[],
  candidateIds: ReadonlySet<string>,
): MutationProposals => ({
  schema_version: MUTATION_VERDICT_SCHEMA,
  verdicts: records
    .filter(
      (record) =>
        candidateIds.has(record.finding_id) &&
        record.closed === undefined &&
        record.status === "judged" &&
        record.decision?.verdict === "dismissed" &&
        record.decision.rule === PROPOSED_RULE,
    )
    .toSorted((a, b) => a.finding_id.localeCompare(b.finding_id))
    .map((record) => ({
      review_key: record.finding_id,
      verdict: "equivalent",
      note: noteOf(record),
    })),
});
