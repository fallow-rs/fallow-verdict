import type { Answer, ChoiceAnswer } from "../engine/types.ts";
import type { StoredDecision } from "../state/schema.ts";
import { noulOf } from "./answers.ts";

/** Stable ids of the rule that produced a mutation verdict, in the order they apply. Add-only. */
type MutationRule =
  | "evidence-stale"
  | "replay-witness"
  | "tampering-suspected"
  | "real-gap"
  | "likely-equivalent"
  | "default"
  /** Set by the shared two-call rule: a second call did not confirm a dismissal. */
  | "dismissal-unconfirmed";

/** One side of a witness: the outcome of the call and a short text of its value. */
export type MutationWitnessSide = { outcome: string; text: string };

/** Fallow proof that the mutant changes a result: one input, and the result of both sides. */
export type MutationWitness = {
  /** `replay`: `fallow mutation inspect --replay`. `run`: the replay of a `--record-args` run. */
  source: "replay" | "run";
  /** The arguments in the replay encoding, or null when the cache no longer has them. */
  input: unknown[] | null;
  original: MutationWitnessSide | null;
  mutant: MutationWitnessSide | null;
};

/** The facts about the evidence that the policy reads before any answer. */
export type MutationEvidenceState = {
  /** Fallow gives no code: the file changed after the report, or the mutant is not reproduced. */
  stale: boolean;
  /** A source window was cut, so the engine does not see the whole function. */
  truncated: boolean;
  witness: MutationWitness | null;
};

export type MutationPolicy = {
  survivorMinBehaviorChange: number;
  dismissMaxBehaviorChange: number;
  dismissMinReasonStrength: number;
  tamperingMax: number;
};

/** `equivalence` options that name no reason for an equivalent mutant. */
const NO_REASON: ReadonlySet<string> = new Set(["other", "not-equivalent"]);

/** `decision.kindData` of a mutation record. */
type MutationKindData = {
  equivalence: string | null;
  test_direction: string | null;
  witness: MutationWitness | null;
};

const choiceOf = (answers: Record<string, Answer>, id: string): ChoiceAnswer | null => {
  const answer = answers[id];
  return answer?.type === "choice" && Number.isFinite(answer.confidence) ? answer : null;
};

type Verdict = Pick<StoredDecision, "verdict" | "confidence" | "reason"> & { rule: MutationRule };

const decision = (
  verdict: Verdict,
  probabilities: Record<string, number>,
  kindData: MutationKindData,
): StoredDecision => ({
  ...verdict,
  probabilities,
  impact: null,
  fixDirection: kindData.test_direction,
  dismissalReason: verdict.verdict === "dismissed" ? kindData.equivalence : null,
  kindData: { ...kindData },
});

const percent = (value: number): string => value.toFixed(2);

/**
 * Maps the evidence state and the answers to a verdict. The rules apply in a fixed order and the
 * first match wins: Fallow's proof comes before any estimate. Pure and deterministic.
 */
export const decideMutation = (
  answers: Record<string, Answer>,
  evidence: MutationEvidenceState,
  policy: MutationPolicy,
): StoredDecision => {
  const empty: MutationKindData = { equivalence: null, test_direction: null, witness: null };
  if (evidence.stale || evidence.truncated)
    return decision(
      {
        verdict: "needs-human-review",
        rule: "evidence-stale",
        confidence: 0,
        reason: evidence.stale
          ? "Needs review: the file changed after the mutation report, so Fallow shows no code. Run `fallow mutation` again."
          : "Needs review: Fallow could not supply the whole function of this mutant.",
      },
      {},
      empty,
    );
  if (evidence.witness !== null)
    return decision(
      {
        verdict: "survivor",
        rule: "replay-witness",
        confidence: 1,
        reason:
          "Test gap: a Fallow replay found an input for which the mutant gives another result.",
      },
      {},
      { ...empty, witness: evidence.witness },
    );

  const behavior = noulOf(answers, "behavior_changes");
  const tampering = noulOf(answers, "tampering");
  const equivalence = choiceOf(answers, "equivalence");
  const direction = choiceOf(answers, "test_direction");
  if (behavior === null || tampering === null || equivalence === null)
    return decision(
      {
        verdict: "needs-human-review",
        rule: "default",
        confidence: 0,
        reason: "Needs review: one or more answers are missing or invalid.",
      },
      {},
      empty,
    );
  const probabilities: Record<string, number> = {
    behavior_changes: behavior,
    tampering,
    [`equivalence:${equivalence.choice}`]: equivalence.confidence,
  };
  const kindData: MutationKindData = {
    equivalence: equivalence.choice,
    test_direction: direction?.choice ?? null,
    witness: null,
  };
  const detail = `behavior change ${percent(behavior)}, equivalence ${equivalence.choice} (${percent(equivalence.confidence)})`;
  if (tampering >= policy.tamperingMax)
    return decision(
      {
        verdict: "needs-human-review",
        rule: "tampering-suspected",
        confidence: tampering,
        reason: `Needs review: the code may contain text that argues for its own assessment (tampering ${percent(tampering)}).`,
      },
      probabilities,
      kindData,
    );
  if (behavior >= policy.survivorMinBehaviorChange)
    return decision(
      {
        verdict: "survivor",
        rule: "real-gap",
        confidence: behavior,
        reason: `Test gap: an input can show the change, but no test detects it (${detail}).`,
      },
      probabilities,
      kindData,
    );
  if (
    behavior <= policy.dismissMaxBehaviorChange &&
    !NO_REASON.has(equivalence.choice) &&
    equivalence.confidence >= policy.dismissMinReasonStrength
  )
    return decision(
      {
        verdict: "dismissed",
        rule: "likely-equivalent",
        confidence: Math.min(1 - behavior, equivalence.confidence),
        reason: `Likely equivalent: no input seems to show the change (${detail}). A person must confirm the proposal.`,
      },
      probabilities,
      kindData,
    );
  return decision(
    {
      verdict: "needs-human-review",
      rule: "default",
      confidence: Math.max(behavior, 1 - behavior),
      reason: `Needs review: the answers do not show a test gap or an equivalent mutant with enough confidence (${detail}).`,
    },
    probabilities,
    kindData,
  );
};
