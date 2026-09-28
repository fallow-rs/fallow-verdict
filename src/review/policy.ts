import type { ReviewConfig } from "../config/schema.ts";
import type { Answer } from "../engine/types.ts";
import type { StoredDecision } from "../state/schema.ts";
import type { BuiltReview } from "./packet.ts";
import { NO_LINE, ruleQuestionId, rulesFor, SEVERITY_LABELS } from "./questions.ts";

export const REVIEW_RULES = [
  "has-bug",
  "rule-breach",
  "no-likely-problem",
  "source-changed",
  "truncated-evidence",
  "answers-missing",
] as const;

export type ReviewPolicyRule = (typeof REVIEW_RULES)[number];

const noulOf = (answers: Record<string, Answer>, id: string): number | null => {
  const answer = answers[id];
  return answer?.type === "noul" && Number.isFinite(answer.probability) ? answer.probability : null;
};

const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

type Base = Omit<StoredDecision, "verdict" | "rule" | "confidence" | "reason">;

const review = (base: Base, rule: ReviewPolicyRule, reason: string): StoredDecision => ({
  ...base,
  verdict: "needs-human-review",
  rule,
  confidence: 0,
  reason,
});

/**
 * Maps the answers for one function to a decision. A function is a survivor when P(has_bug) or
 * the P(breach) of a rule in scope reaches its floor, and dismissed otherwise. Evidence that
 * changed or was cut goes to a person. Review mode is advisory: a survivor is a likely problem,
 * never a Fallow fact.
 */
export const decideReview = (
  answers: Record<string, Answer>,
  built: BuiltReview,
  config: ReviewConfig,
): StoredDecision => {
  const rules = rulesFor(config, built.packet.unit.path).map((rule) => ({
    name: rule.name,
    floor: rule.floor ?? config.ruleFloor,
    probability: noulOf(answers, ruleQuestionId(rule.name)),
  }));
  const bug = noulOf(answers, "has_bug");
  const claims = noulOf(answers, "does_what_it_claims");
  const probabilities: Record<string, number> = {};
  if (bug !== null) probabilities["has_bug"] = bug;
  if (claims !== null) probabilities["does_what_it_claims"] = claims;
  for (const rule of rules)
    if (rule.probability !== null) probabilities[`rule:${rule.name}`] = rule.probability;
  const severity = answers["severity"];
  const where = answers["where"];
  const base: Base = {
    probabilities,
    impact:
      severity?.type === "score"
        ? {
            score: severity.score,
            label: SEVERITY_LABELS[Math.round(severity.score)] ?? String(severity.score),
          }
        : null,
    fixDirection: null,
    dismissalReason: null,
    kindData: {
      name: built.packet.unit.name,
      startLine: built.packet.unit.start_line,
      endLine: built.packet.unit.end_line,
      where: where?.type === "choice" && where.choice !== NO_LINE ? where.choice : null,
      breaches: [] as string[],
    },
  };

  if (built.sourceChanged)
    return review(
      base,
      "source-changed",
      "The function source changed after the scan, or cannot be read. Run scan again.",
    );
  if (built.truncated)
    return review(
      base,
      "truncated-evidence",
      `The evidence was shortened to fit the request budget (${built.packet.omitted.join(", ")}).`,
    );
  if (bug === null || rules.some((rule) => rule.probability === null))
    return review(base, "answers-missing", "Required answers are missing.");

  const breaches = rules.filter((rule) => (rule.probability ?? 0) >= rule.floor);
  const kindData = { ...base.kindData, breaches: breaches.map((rule) => rule.name) };
  const bugFound = bug >= config.bugFloor;
  if (bugFound || breaches.length > 0) {
    const passing = [...(bugFound ? [bug] : []), ...breaches.map((rule) => rule.probability ?? 0)];
    const parts = [
      ...(bugFound
        ? [`P(bug) ${percent(bug)} reaches the floor ${percent(config.bugFloor)}.`]
        : []),
      ...breaches.map(
        (rule) =>
          `P(breach of ${rule.name}) ${percent(rule.probability ?? 0)} reaches the floor ${percent(rule.floor)}.`,
      ),
    ];
    return {
      ...base,
      kindData,
      verdict: "survivor",
      rule: bugFound ? "has-bug" : "rule-breach",
      confidence: Math.max(...passing),
      reason: parts.join(" "),
    };
  }
  const highest = Math.max(bug, ...rules.map((rule) => rule.probability ?? 0));
  return {
    ...base,
    kindData: { ...kindData, where: null },
    verdict: "dismissed",
    rule: "no-likely-problem",
    confidence: 1 - highest,
    reason: `P(bug) ${percent(bug)} is below the floor ${percent(config.bugFloor)}, and no rule breach reaches its floor.`,
  };
};
