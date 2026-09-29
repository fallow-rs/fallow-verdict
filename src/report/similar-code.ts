import type { FindingRecord, StoredDecision } from "../state/schema.ts";
import type { KindPresentation } from "./render.ts";

/** Fallow similarity bands, strongest first. The record stores the band as its category. */
const BAND_RANK: Readonly<Record<string, number>> = { "very-high": 0, high: 1, moderate: 2 };
const NO_BAND_RANK = 3;

const SURVIVOR_NOTE =
  "Jev assessed these pairs as the same behavior, so one function can replace the other.";

/** Strongest Fallow similarity band first, so a budget cap spends on the likeliest merges. */
export const similarCodePriority = (record: FindingRecord): number =>
  record.category === null ? NO_BAND_RANK : (BAND_RANK[record.category] ?? NO_BAND_RANK);

const REVIEW_REASONS: Readonly<Partial<Record<string, string>>> = {
  "evidence-missing": "One or more answers are missing. Check the inputs and rerun the assessment.",
  "truncated-evidence":
    "Fallow could not supply the complete evidence for this pair. Compare the two functions yourself.",
  "answers-conflict":
    "The answers disagree. Compare the two functions, their callers and their tests.",
  uncertain:
    "The answers do not show a safe merge or an unrelated pair. Compare how each function handles empty, missing and boundary values.",
  "survivor-unconfirmed":
    "A second assessment did not confirm that the pair is safe to merge. Compare the two functions and their tests before you merge them.",
  "dismissal-unconfirmed":
    "A second assessment did not confirm that the pair is unrelated. Compare the two functions before you drop the pair.",
};

const percent = (value: number | undefined): string =>
  value !== undefined && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : "unavailable";

const axisText = (value: unknown): string =>
  value === true ? "yes" : value === false ? "no" : "unknown";

const functions = (record: FindingRecord): string => {
  const names = [record.evidence?.["leftName"], record.evidence?.["rightName"]];
  return names.every((name) => typeof name === "string")
    ? `Functions: ${names.join(" and ")}`
    : "Functions: see the locations";
};

const explanation = (decision: StoredDecision): string | null => {
  if (decision.verdict === "survivor") return null;
  if (decision.verdict === "dismissed") return decision.reason;
  const label = decision.rule === "uncertain" ? "Assessment inconclusive" : "Review required";
  return `${label}: ${REVIEW_REASONS[decision.rule] ?? decision.reason}`;
};

/** Words and evidence lines of the similar-code reports. */
export const similarCodePresentation: KindPresentation = {
  title: "Similar-code review",
  intro:
    "Fallow found these pairs of similar functions; Jev assessed the supplied code. A verdict is an estimate. Run the tests and Fallow again after a merge.",
  survivor: {
    heading: "Safe merge candidates",
    label: "Safe merge candidate",
    count: "safe merge candidates",
    note: SURVIVOR_NOTE,
  },
  confirmationBound: "Confirmation calls (dismissals and merge recommendations) can add up to",
  dismissed: {
    heading: "Not worth merging",
    label: "Not worth merging",
    count: "not worth merging",
  },
  describe: (record, decision) => {
    const data = decision.kindData ?? {};
    return {
      facts: [
        functions(record),
        `Similarity band: ${record.category ?? "unknown"}`,
        `Outcome: ${typeof data["outcome"] === "string" ? data["outcome"] : "needs-human-review"}`,
        `Same responsibility: ${axisText(data["candidate_worthy"])}`,
        `Same behavior: ${axisText(data["behaviorally_equivalent"])}`,
        `Safe to merge: ${axisText(data["refactor_safe"])}`,
      ],
      explanation: explanation(decision),
      estimate: `Model estimates: refactor-safe ${percent(decision.probabilities["refactor_safe"])}, behaviorally equivalent ${percent(decision.probabilities["behaviorally_equivalent"])}, same responsibility ${percent(decision.probabilities["candidate_worthy"])}.`,
      suggestion:
        decision.verdict === "survivor"
          ? "Suggested approach: keep one function, call it from both places, then run the tests and `fallow similar-code` again."
          : null,
    };
  },
};
