import type { MutationWitness } from "../policy/mutation.ts";
import type { FindingRecord, StoredDecision } from "../state/schema.ts";
import type { KindPresentation } from "./render.ts";

/** Each mutant has the same priority, so the report sorts each group by confidence. */
export const mutationPriority = (_record: FindingRecord): number => 0;

const REVIEW_REASONS: Readonly<Partial<Record<string, string>>> = {
  "evidence-stale":
    "Fallow could not show the current code of this mutant. Run `fallow mutation` again, then the assessment.",
  "tampering-suspected":
    "The code may contain text that argues for its own assessment. Read the function and its tests yourself.",
  "dismissal-unconfirmed":
    "A second assessment did not confirm that the mutant is equivalent. Look for an input that shows the change.",
  default:
    "The answers do not show a test gap or an equivalent mutant with enough confidence. Look for an input that shows the change.",
};

const percent = (value: number | undefined): string =>
  value !== undefined && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : "unavailable";

const witnessOf = (decision: StoredDecision): MutationWitness | null => {
  const witness = decision.kindData?.["witness"];
  return typeof witness === "object" && witness !== null ? (witness as MutationWitness) : null;
};

const witnessFacts = (witness: MutationWitness | null): string[] => {
  if (witness === null) return [];
  const facts = [
    `Replay witness: ${witness.source === "run" ? "the recording run" : "inspect --replay"}`,
  ];
  if (witness.input !== null) facts.push(`Replay input: ${JSON.stringify(witness.input)}`);
  if (witness.original !== null)
    facts.push(`Current code: ${witness.original.outcome} ${witness.original.text}`);
  if (witness.mutant !== null)
    facts.push(`Changed code: ${witness.mutant.outcome} ${witness.mutant.text}`);
  return facts;
};

const explanation = (decision: StoredDecision): string | null => {
  if (decision.verdict === "survivor") return null;
  if (decision.verdict === "dismissed") return decision.reason;
  return `Review required: ${REVIEW_REASONS[decision.rule] ?? decision.reason}`;
};

/** A fact line for each string value, in order. A missing value gives no line. */
const lines = (entries: readonly (readonly [string, unknown])[]): string[] =>
  entries.flatMap(([label, value]) => (typeof value === "string" ? [`${label}: ${value}`] : []));

const factsOf = (record: FindingRecord, decision: StoredDecision): string[] => {
  const data = decision.kindData ?? {};
  const survivor = decision.verdict === "survivor";
  return [
    ...lines([
      ["Mutant", record.finding_id],
      ["Operator", record.category ?? "unknown"],
      ["Function", record.evidence?.["function"]],
      ["Change", record.evidence?.["change"]],
      ["Test direction", survivor ? data["test_direction"] : null],
      ["Equivalence", survivor ? null : data["equivalence"]],
    ]),
    ...witnessFacts(witnessOf(decision)),
  ];
};

/** Words and evidence lines of the mutation reports. */
export const mutationPresentation: KindPresentation = {
  title: "Mutation survivor review",
  intro:
    "Fallow found these mutants that no test detects; Jev assessed the supplied code. A verdict is an estimate. A proposed equivalent goes to `mutation-verdicts.proposed.json` and changes nothing until a person copies it into the verdict document.",
  survivor: {
    heading: "Test gaps",
    label: "Test gap",
    count: "test gaps",
    note: "A caller can see these changes, but no test fails on them. Write a test that fails on the changed code.",
  },
  confirmationBound: "Confirmation calls for proposed equivalents can add up to",
  dismissed: {
    heading: "Proposed as equivalent",
    label: "Proposed as equivalent",
    count: "proposed as equivalent",
  },
  describe: (record, decision) => ({
    facts: factsOf(record, decision),
    explanation: explanation(decision),
    estimate:
      decision.rule === "replay-witness"
        ? "Fallow proved the difference with a replay. No model call was made."
        : `Model estimate: behavior change ${percent(decision.probabilities["behavior_changes"])}.`,
    suggestion:
      decision.verdict === "survivor"
        ? "Suggested approach: write a test that fails on the changed code, then run `fallow mutation --recheck`."
        : null,
  }),
};
