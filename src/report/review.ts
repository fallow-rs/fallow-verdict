import type { ReviewPolicyRule } from "../review/policy.ts";
import type { FindingRecord, StoredDecision } from "../state/schema.ts";
import type { KindPresentation } from "./render.ts";

const SURVIVOR_NOTE =
  "Jev estimates that these functions contain a bug or break a project rule. These are model estimates, not Fallow findings.";

/** Record `category` of a review unit: the strongest reason that put the function in scope. */
export const REVIEW_CATEGORIES = [
  "hotspot-critical",
  "hotspot-high",
  "hotspot-moderate",
  "changed",
  "path",
] as const;

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  "hotspot-critical": "Complexity hotspot (critical)",
  "hotspot-high": "Complexity hotspot (high)",
  "hotspot-moderate": "Complexity hotspot (moderate)",
  changed: "Changed file",
  path: "Selected file",
};

/** Hotspots first, strongest first; then changed files; then files named on the command line. */
export const reviewPriority = (record: FindingRecord): number => {
  const rank = (REVIEW_CATEGORIES as readonly string[]).indexOf(record.category ?? "");
  return rank === -1 ? REVIEW_CATEGORIES.length : rank;
};

const REVIEW_REASONS: Readonly<Partial<Record<string, string>>> = {
  "source-changed":
    "The function changed after the scan, or its file cannot be read. Run scan again.",
  "truncated-evidence":
    "The function source was shortened to fit the request budget. Read the full function.",
  "answers-missing": "Required answers are missing. Run the assessment again.",
  "dismissal-unconfirmed":
    "A second assessment did not confirm that the function has no likely problem. Read the function.",
} satisfies Partial<Record<ReviewPolicyRule | "dismissal-unconfirmed", string>>;

const percentOf = (decision: StoredDecision, key: string): string => {
  const value = decision.probabilities[key];
  return value !== undefined && Number.isFinite(value)
    ? `${(value * 100).toFixed(0)}%`
    : "unavailable";
};

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const functionLabel = (decision: StoredDecision): string => {
  const data = decision.kindData ?? {};
  const name = text(data["name"]) ?? "function";
  const start = data["startLine"];
  const end = data["endLine"];
  return typeof start === "number" && typeof end === "number"
    ? `Function ${name}, lines ${start} to ${end}`
    : `Function ${name}`;
};

const explanation = (decision: StoredDecision): string | null => {
  if (decision.verdict === "needs-human-review")
    return `Review required: ${REVIEW_REASONS[decision.rule] ?? decision.reason}`;
  if (decision.verdict === "dismissed")
    return "Jev found no likely bug, no likely mismatch with the stated purpose and no likely rule breach.";
  const breaches = stringList(decision.kindData?.["breaches"]);
  const parts = [
    ...(decision.kindData?.["claimMismatch"] === true
      ? ["The function likely does not do what its name or comment states."]
      : []),
    ...(breaches.length === 0 ? [] : [`Likely breach of project rules: ${breaches.join(", ")}.`]),
  ];
  return parts.length === 0 ? null : parts.join(" ");
};

const estimate = (decision: StoredDecision): string => {
  const rules = Object.keys(decision.probabilities)
    .filter((key) => key.startsWith("rule:"))
    .map((key) => `breach of ${key.slice("rule:".length)} ${percentOf(decision, key)}`);
  return [
    `Model estimate of a bug: ${percentOf(decision, "has_bug")}`,
    `does what it claims: ${percentOf(decision, "does_what_it_claims")}`,
    ...rules,
  ]
    .join(", ")
    .concat(".");
};

const suggestion = (decision: StoredDecision): string | null => {
  const where = text(decision.kindData?.["where"]);
  if (decision.verdict !== "survivor" || where === null) return null;
  return `Start at ${where.replaceAll("L", "line ").replace("-", " to ")}.`;
};

/** Words and evidence lines of the review reports. */
export const reviewPresentation: KindPresentation = {
  title: "Code review",
  intro:
    "Fallow selected these functions; Jev assessed their source. Every verdict is a model estimate. Read the function before acting on a verdict.",
  survivor: {
    heading: "Likely problems",
    label: "Likely problem",
    count: "likely problems",
    note: SURVIVOR_NOTE,
  },
  dismissed: {
    heading: "No likely problem",
    label: "No likely problem",
    count: "without a likely problem",
  },
  describe: (record: FindingRecord, decision: StoredDecision) => ({
    facts: [functionLabel(decision), CATEGORY_LABELS[record.category ?? ""] ?? "Selected function"],
    explanation: explanation(decision),
    estimate: estimate(decision),
    suggestion: suggestion(decision),
  }),
};
