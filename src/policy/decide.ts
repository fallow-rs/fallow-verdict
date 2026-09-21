import type { Policy } from "../config/schema.ts";
import type { Answer } from "../engine/types.ts";
import type { FixDirection, VerdictStatus } from "../fallow/types.ts";
import type { BuiltPacket } from "../packet/build.ts";
import { IMPACT_LABELS, type QuestionId } from "../questions/catalog.ts";

/** Evidence answers below this are treated as "no" when confirming a survivor. */
const EVIDENCE_MIDPOINT = 0.5;
const MIN_FIX_DIRECTION_CONFIDENCE = 0.5;

/** Stable ids of the rule that produced a verdict. Add-only. */
export type PolicyRule =
  | "evidence-missing"
  | "tampering-suspected"
  | "survivor"
  | "dismissed"
  | "truncated-evidence"
  | "evidence-conflict"
  | "uncertain";

export type DismissalReason =
  | "not-attacker-controlled"
  | "does-not-reach-sink"
  | "mitigated"
  | "non-production-code";

export type Probabilities = Record<Exclude<QuestionId, "impact" | "fix_direction">, number>;

export type Decision = {
  verdict: VerdictStatus;
  rule: PolicyRule;
  /** Probability that governed the verdict, 0 to 1. */
  confidence: number;
  probabilities: Probabilities;
  impact: { score: number; label: string } | null;
  fixDirection: FixDirection | null;
  dismissalReason: DismissalReason | null;
  reason: string;
};

const noulOf = (answers: Record<string, Answer>, id: QuestionId): number => {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.probability : Number.NaN;
};

const strongestDismissal = (p: Probabilities): { reason: DismissalReason; strength: number } => {
  const candidates: { reason: DismissalReason; strength: number }[] = [
    { reason: "not-attacker-controlled", strength: 1 - p.attacker_controlled },
    { reason: "does-not-reach-sink", strength: 1 - p.reaches_sink },
    { reason: "mitigated", strength: p.mitigated },
    { reason: "non-production-code", strength: p.non_production },
  ];
  return candidates.reduce((best, next) => (next.strength > best.strength ? next : best));
};

const impactOf = (answers: Record<string, Answer>): Decision["impact"] => {
  const answer = answers["impact"];
  if (answer?.type !== "score") return null;
  const label = IMPACT_LABELS[Math.round(answer.score)] ?? "unknown";
  return { score: answer.score, label };
};

const fixDirectionOf = (
  answers: Record<string, Answer>,
  hasDeadCode: boolean,
): FixDirection | null => {
  if (hasDeadCode) return "delete-dead-code";
  const answer = answers["fix_direction"];
  if (answer?.type !== "choice" || answer.choice === "none") return null;
  return answer.confidence >= MIN_FIX_DIRECTION_CONFIDENCE ? (answer.choice as FixDirection) : null;
};

const describe = (p: Probabilities): string =>
  `exploitable ${p.exploitable.toFixed(2)}, attacker-controlled ${p.attacker_controlled.toFixed(2)}, ` +
  `reaches sink ${p.reaches_sink.toFixed(2)}, mitigated ${p.mitigated.toFixed(2)}`;

/**
 * Turns calibrated probabilities into a verdict. Pure and deterministic: the same
 * answers and policy always give the same verdict, and every verdict names the
 * rule that produced it.
 *
 * The policy is asymmetric on purpose. A wrong `survivor` costs a reviewer a few
 * minutes; a wrong `dismissed` hides a vulnerability. Dismissal therefore needs a
 * low P(exploitable), a named reason, complete evidence, and no sign of tampering.
 */
export const decide = (
  answers: Record<string, Answer>,
  built: Pick<BuiltPacket, "packet" | "truncated" | "unreadable">,
  policy: Policy,
): Decision => {
  const p: Probabilities = {
    attacker_controlled: noulOf(answers, "attacker_controlled"),
    reaches_sink: noulOf(answers, "reaches_sink"),
    mitigated: noulOf(answers, "mitigated"),
    exploitable: noulOf(answers, "exploitable"),
    non_production: noulOf(answers, "non_production"),
    tampering: noulOf(answers, "tampering"),
  };
  const impact = impactOf(answers);
  const fixDirection = fixDirectionOf(answers, built.packet.dead_code !== null);
  const review = (rule: PolicyRule, note: string): Decision => ({
    verdict: "needs-human-review",
    rule,
    confidence: p.exploitable,
    probabilities: p,
    impact,
    fixDirection,
    dismissalReason: null,
    reason: `Needs review (${note}): ${describe(p)}.`,
  });

  const sinkShown = built.packet.source_windows.some((window) => window.roles.includes("sink"));
  if (!sinkShown || built.unreadable.length > 0 || Object.values(p).some(Number.isNaN)) {
    return review("evidence-missing", "required source evidence or answers are missing");
  }
  if (p.tampering >= policy.tamperingMax) {
    return review(
      "tampering-suspected",
      `the code contains text that argues for its own assessment, P=${p.tampering.toFixed(2)}`,
    );
  }

  const evidenceAgrees =
    p.attacker_controlled >= EVIDENCE_MIDPOINT &&
    p.reaches_sink >= EVIDENCE_MIDPOINT &&
    p.mitigated <= EVIDENCE_MIDPOINT;
  if (p.exploitable >= policy.survivorMinExploitable) {
    if (!evidenceAgrees) return review("evidence-conflict", "evidence answers disagree");
    return {
      verdict: "survivor",
      rule: "survivor",
      confidence: p.exploitable,
      probabilities: p,
      impact,
      fixDirection,
      dismissalReason: null,
      reason: `Survivor: ${describe(p)}.`,
    };
  }

  const dismissal = strongestDismissal(p);
  const dismissible =
    p.exploitable <= policy.dismissMaxExploitable[built.packet.severity] &&
    dismissal.strength >= policy.dismissMinReasonStrength;
  if (dismissible) {
    if (built.truncated) return review("truncated-evidence", "evidence was cut to fit the budget");
    return {
      verdict: "dismissed",
      rule: "dismissed",
      confidence: Math.min(1 - p.exploitable, dismissal.strength),
      probabilities: p,
      impact: null,
      fixDirection: null,
      dismissalReason: dismissal.reason,
      reason: `Dismissed (${dismissal.reason} ${dismissal.strength.toFixed(2)}): ${describe(p)}.`,
    };
  }

  return review("uncertain", "probabilities are inside the review band");
};
