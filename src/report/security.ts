import type { FixDirection } from "../fallow/types.ts";
import type { DismissalReason, PolicyRule } from "../policy/decide.ts";
import type { FindingRecord } from "../state/schema.ts";
import type { KindPresentation } from "./render.ts";

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const SURVIVOR_NOTE = "Jev assessed these as exploitable in the supplied code.";

/** After every Fallow severity. A security record always has a severity. */
const NO_SEVERITY_RANK = 3;

/** Highest Fallow severity first. */
export const securityPriority = (record: FindingRecord): number =>
  record.severity === null ? NO_SEVERITY_RANK : SEVERITY_RANK[record.severity];

type SavedDecision = NonNullable<FindingRecord["decision"]>;

const REVIEW_REASONS: Readonly<Partial<Record<string, string>>> = {
  "evidence-missing":
    "Required source evidence or model answers are missing. Check the inputs and rerun the assessment.",
  "tampering-suspected":
    "Jev detected text aimed at influencing the assessment. Review that text with the surrounding code.",
  "truncated-evidence":
    "The evidence was shortened to fit the request budget. Review the omitted context before dismissing this candidate.",
  "evidence-conflict":
    "Jev's exploitability estimate conflicts with its answers about the input or protections. Check how input reaches the sensitive operation.",
  uncertain:
    "Review how input reaches the sensitive operation and check the protections along that path.",
  "dismissal-unconfirmed":
    "A second assessment did not confirm the dismissal. Review how input reaches the sensitive operation before dismissing this candidate.",
} satisfies Record<Exclude<PolicyRule, "survivor" | "dismissed">, string>;

const DISMISSAL_REASONS: Readonly<Partial<Record<string, string>>> = {
  "not-attacker-controlled": "Jev considers the input outside an attacker's control.",
  "does-not-reach-sink": "Jev considers the input unable to reach the sensitive operation.",
  mitigated: "Jev considers the protection in the supplied code effective.",
  "non-production-code": "Jev identifies this as code that does not run in production.",
} satisfies Record<DismissalReason, string>;

const explanation = (decision: SavedDecision): string => {
  if (decision.verdict === "needs-human-review") {
    const label = decision.rule === "uncertain" ? "Assessment inconclusive" : "Review required";
    const reason = Object.hasOwn(REVIEW_REASONS, decision.rule)
      ? (REVIEW_REASONS[decision.rule] ?? decision.reason)
      : decision.reason;
    return `${label}: ${reason}`;
  }
  if (decision.rule === "survivor") return SURVIVOR_NOTE;
  if (decision.rule === "dismissed")
    return decision.dismissalReason === null
      ? decision.reason
      : (DISMISSAL_REASONS[decision.dismissalReason] ?? decision.reason);
  return decision.reason;
};

const categoryLabel = (category: string | null): string => {
  if (category === "redos" || category === "redos-regex")
    return "Regular expression denial of service";
  const label = (category ?? "client-server-leak").replaceAll("-", " ");
  return label.replace(/\b(ssrf|sql|nosql|xss|redos)\b/g, (word) =>
    word === "redos" ? "ReDoS" : word === "nosql" ? "NoSQL" : word.toUpperCase(),
  );
};

const estimate = (decision: SavedDecision): string => {
  const p = decision.probabilities.exploitable;
  return `Model estimate of exploitability: ${p !== undefined && Number.isFinite(p) ? `${(p * 100).toFixed(0)}%` : "unavailable"}.`;
};

const nextStep = (decision: SavedDecision): string | null => {
  if (decision.fixDirection === null) return null;
  const directions: Readonly<Partial<Record<string, string>>> = {
    "delete-dead-code": "Remove unused code",
    "validate-input": "Validate the input",
    "escape-output": "Escape the output",
    "avoid-shell": "Use an API that keeps input separate from commands or queries",
    "restrict-url": "Restrict the destination URL",
    "add-authz-check": "Check authorization",
    "harden-config": "Review the security configuration",
    "needs-design-review": "Review the design",
  } satisfies Record<FixDirection, string>;
  return `Suggested approach: ${directions[decision.fixDirection] ?? decision.fixDirection.replaceAll("-", " ")}.`;
};

/** Words and evidence lines of the security reports. */
export const securityPresentation: KindPresentation = {
  title: "Security review",
  intro:
    "Fallow found these candidates; Jev assessed the supplied code. Review the evidence before acting on a verdict.",
  survivor: {
    heading: "Likely vulnerabilities",
    label: "Likely vulnerability",
    count: "likely vulnerabilities",
    note: SURVIVOR_NOTE,
  },
  describe: (record, decision) => ({
    facts: [categoryLabel(record.category), `Fallow severity: ${record.severity ?? "none"}`],
    explanation: decision.rule === "survivor" ? null : explanation(decision),
    estimate: estimate(decision),
    suggestion: nextStep(decision),
  }),
};
