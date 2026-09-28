import type { SimilarCodePolicy } from "../config/schema.ts";
import type { Answer } from "../engine/types.ts";
import { SIMILAR_CODE_OUTCOMES, type SimilarCodeOutcome } from "../questions/similar-code.ts";
import type { StoredDecision } from "../state/schema.ts";

/** Stable ids of the rule that produced a similar-code verdict. Add-only. */
export type SimilarCodeRule =
  | "evidence-missing"
  | "truncated-evidence"
  | "merge-safe"
  | "not-a-candidate"
  | "answers-conflict"
  | "uncertain"
  /** Set by the shared two-call rule: a second call did not confirm a dismissal. */
  | "dismissal-unconfirmed"
  /** Set by the shared two-call rule: a second call did not confirm a survivor. */
  | "survivor-unconfirmed";

/** The Fallow verdict axes. `null` means unknown: the answer was below its floor. */
export type SimilarCodeAxes = {
  candidate_worthy: boolean | null;
  behaviorally_equivalent: boolean | null;
  refactor_safe: boolean | null;
  outcome: SimilarCodeOutcome;
};

/** `decision.kindData` of a similar-code record: the axes for the Fallow export. */
export type SimilarCodeKindData = SimilarCodeAxes;

const AXIS_IDS = ["candidate_worthy", "behaviorally_equivalent", "refactor_safe"] as const;
type AxisId = (typeof AXIS_IDS)[number];

const noulOf = (answers: Record<string, Answer>, id: string): number => {
  const answer = answers[id];
  return answer?.type === "noul" && Number.isFinite(answer.probability)
    ? answer.probability
    : Number.NaN;
};

/** True at or above the floor, false at or below its mirror, otherwise unknown. */
const axis = (probability: number, floor: number): boolean | null => {
  if (probability >= floor) return true;
  if (probability <= 1 - floor) return false;
  return null;
};

const isOutcome = (value: string): value is SimilarCodeOutcome =>
  (SIMILAR_CODE_OUTCOMES as readonly string[]).includes(value);

/**
 * Applies the contract order: `refactor_safe` true needs `behaviorally_equivalent` true, which
 * needs `candidate_worthy` true. A positive answer without its prerequisite becomes unknown.
 * A negative answer needs no prerequisite, so it stays.
 */
export const orderAxes = (axes: SimilarCodeAxes): SimilarCodeAxes => {
  const behaviorallyEquivalent =
    axes.behaviorally_equivalent === true && axes.candidate_worthy !== true
      ? null
      : axes.behaviorally_equivalent;
  const refactorSafe =
    axes.refactor_safe === true && behaviorallyEquivalent !== true ? null : axes.refactor_safe;
  return {
    ...axes,
    behaviorally_equivalent: behaviorallyEquivalent,
    refactor_safe: refactorSafe,
  };
};

const UNKNOWN: SimilarCodeAxes = {
  candidate_worthy: null,
  behaviorally_equivalent: null,
  refactor_safe: null,
  outcome: "needs-human-review",
};

const describe = (p: Record<AxisId, number>, outcome: string, confidence: number): string =>
  `candidate-worthy ${p.candidate_worthy.toFixed(2)}, behaviorally equivalent ${p.behaviorally_equivalent.toFixed(2)}, ` +
  `refactor-safe ${p.refactor_safe.toFixed(2)}, outcome ${outcome} (${confidence.toFixed(2)})`;

type Verdict = Pick<StoredDecision, "verdict" | "confidence" | "reason"> & {
  rule: SimilarCodeRule;
};

/**
 * Maps the axes onto the shared verdict. `survivor` means a merge is worth doing: the pair is
 * refactor-safe and has the same responsibility. `dismissed` means the pair is not a merge
 * candidate. Everything else, and every conflict between the answers, goes to a person.
 */
const verdictOf = (
  axes: SimilarCodeAxes,
  p: Record<AxisId, number>,
  outcomeConfidence: number,
): Verdict => {
  const detail = describe(p, axes.outcome, outcomeConfidence);
  if (axes.refactor_safe === true) {
    if (axes.outcome === "same-responsibility")
      return {
        verdict: "survivor",
        rule: "merge-safe",
        confidence: Math.min(p.refactor_safe, outcomeConfidence),
        reason: `Merge candidate: the functions behave the same and one can replace the other (${detail}).`,
      };
    return {
      verdict: "needs-human-review",
      rule: "answers-conflict",
      confidence: p.refactor_safe,
      reason: `Needs review: the pair looks refactor-safe, but the outcome is ${axes.outcome} (${detail}).`,
    };
  }
  const notCandidate = axes.candidate_worthy === false || axes.outcome === "unrelated";
  if (notCandidate) {
    const conflict =
      axes.candidate_worthy === true ||
      (axes.candidate_worthy === false && axes.outcome === "same-responsibility");
    if (conflict)
      return {
        verdict: "needs-human-review",
        rule: "answers-conflict",
        confidence: Math.max(p.candidate_worthy, 1 - p.candidate_worthy),
        reason: `Needs review: the answers about the responsibility of the pair disagree (${detail}).`,
      };
    return {
      verdict: "dismissed",
      rule: "not-a-candidate",
      confidence:
        axes.candidate_worthy === false
          ? Math.max(1 - p.candidate_worthy, axes.outcome === "unrelated" ? outcomeConfidence : 0)
          : outcomeConfidence,
      reason: `Not a merge candidate: the functions do different jobs (${detail}).`,
    };
  }
  return {
    verdict: "needs-human-review",
    rule: "uncertain",
    confidence: Math.max(p.refactor_safe, 1 - p.refactor_safe),
    reason: `Needs review: the answers do not show a safe merge or an unrelated pair (${detail}).`,
  };
};

const decision = (
  verdict: Verdict,
  probabilities: Record<string, number>,
  axes: SimilarCodeAxes,
): StoredDecision => ({
  ...verdict,
  probabilities,
  impact: null,
  fixDirection: null,
  dismissalReason: verdict.verdict === "dismissed" ? verdict.rule : null,
  kindData: { ...axes },
});

/**
 * Turns the answers into the Fallow axes and a shared verdict. Pure and deterministic: the same
 * answers, evidence flag and floors always give the same decision, with a named rule.
 */
export const decideSimilarCode = (
  answers: Record<string, Answer>,
  truncated: boolean,
  policy: SimilarCodePolicy,
): StoredDecision => {
  const p: Record<AxisId, number> = {
    candidate_worthy: noulOf(answers, "candidate_worthy"),
    behaviorally_equivalent: noulOf(answers, "behaviorally_equivalent"),
    refactor_safe: noulOf(answers, "refactor_safe"),
  };
  const outcome = answers["outcome"];
  const missing =
    AXIS_IDS.some((id) => Number.isNaN(p[id])) ||
    outcome?.type !== "choice" ||
    !isOutcome(outcome.choice) ||
    !Number.isFinite(outcome.confidence);
  if (missing || outcome?.type !== "choice")
    return decision(
      {
        verdict: "needs-human-review",
        rule: "evidence-missing",
        confidence: 0,
        reason: "Needs review: one or more answers are missing or invalid.",
      },
      {},
      UNKNOWN,
    );
  const probabilities: Record<string, number> = {
    ...p,
    [`outcome:${outcome.choice}`]: outcome.confidence,
  };
  if (truncated)
    return decision(
      {
        verdict: "needs-human-review",
        rule: "truncated-evidence",
        confidence: 0,
        reason: `Needs review: Fallow could not supply the complete evidence for this pair (${describe(p, outcome.choice, outcome.confidence)}).`,
      },
      probabilities,
      UNKNOWN,
    );
  const axes = orderAxes({
    candidate_worthy: axis(p.candidate_worthy, policy.candidateWorthyFloor),
    behaviorally_equivalent: axis(p.behaviorally_equivalent, policy.behaviorallyEquivalentFloor),
    refactor_safe: axis(p.refactor_safe, policy.refactorSafeFloor),
    outcome:
      outcome.confidence >= policy.outcomeMinConfidence && isOutcome(outcome.choice)
        ? outcome.choice
        : "needs-human-review",
  });
  return decision(verdictOf(axes, p, outcome.confidence), probabilities, axes);
};
