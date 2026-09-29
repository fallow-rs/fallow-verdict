import type { StoredDecision } from "../state/schema.ts";
import type { PolicyRule } from "./decide.ts";

const UNCONFIRMED: PolicyRule = "dismissal-unconfirmed";

/**
 * A dismissal stands only when a second, independent call also maps to a dismissal under the
 * same policy. Any other outcome, or no second answer set, goes to a person. Pure: the same two
 * decisions always give the same result, so a stored pair can be remapped locally.
 *
 * `missing` explains why there is no second decision when `second` is null.
 */
export const confirmDismissal = (
  first: StoredDecision,
  second: StoredDecision | null,
  missing = "no second answer set is stored",
): StoredDecision => {
  if (first.verdict !== "dismissed") return first;
  if (second?.verdict === "dismissed")
    return { ...first, confidence: Math.min(first.confidence, second.confidence) };
  const base = second ?? first;
  const note =
    second === null ? missing : `the second assessment gave ${second.verdict} (${second.rule})`;
  return {
    ...base,
    verdict: "needs-human-review",
    rule: UNCONFIRMED,
    dismissalReason: null,
    reason: `Needs review (dismissal not confirmed: ${note}). First assessment: ${first.reason}`,
  };
};
