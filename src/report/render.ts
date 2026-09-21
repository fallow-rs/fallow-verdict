import { styleText } from "node:util";

import type { VerdictStatus } from "../fallow/types.ts";
import type { FixDirection } from "../fallow/types.ts";
import type { DismissalReason, PolicyRule } from "../policy/decide.ts";
import type { FindingRecord } from "../state/schema.ts";
import { formatUsd } from "../util/tokens.ts";

export const REPORT_SCHEMA = "fallow-verdict-report/v1";

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const VERDICT_ORDER: readonly VerdictStatus[] = ["survivor", "needs-human-review", "dismissed"];
const VERDICT_TITLE: Record<VerdictStatus, string> = {
  survivor: "Likely vulnerabilities",
  "needs-human-review": "Needs review",
  dismissed: "Dismissed",
};

export type ReportSummary = {
  candidates: number;
  survivors: number;
  needsHumanReview: number;
  dismissed: number;
  pending: number;
  errors: number;
  resolved: number;
  costUsd: number;
};

export type Report = {
  schema_version: typeof REPORT_SCHEMA;
  generatedAt: string;
  summary: ReportSummary;
  findings: FindingRecord[];
};

const byPriority = (a: FindingRecord, b: FindingRecord): number =>
  SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
  (b.decision?.confidence ?? 0) - (a.decision?.confidence ?? 0) ||
  a.path.localeCompare(b.path) ||
  a.line - b.line;

export const buildReport = (records: readonly FindingRecord[]): Report => {
  const live = records.filter((record) => record.status !== "resolved");
  const count = (verdict: VerdictStatus): number =>
    live.filter((record) => record.status === "judged" && record.decision?.verdict === verdict)
      .length;
  return {
    schema_version: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    summary: {
      candidates: live.length,
      survivors: count("survivor"),
      needsHumanReview: count("needs-human-review"),
      dismissed: count("dismissed"),
      pending: live.filter((record) => record.status === "pending").length,
      errors: live.filter((record) => record.status === "error").length,
      resolved: records.length - live.length,
      costUsd: records.reduce((sum, record) => sum + (record.usage?.costUsd ?? 0), 0),
    },
    findings: live.toSorted(byPriority),
  };
};

const group = (report: Report, verdict: VerdictStatus): FindingRecord[] =>
  report.findings.filter(
    (record) => record.status === "judged" && record.decision?.verdict === verdict,
  );

const summaryLine = ({ summary }: Report): string =>
  `${summary.candidates} candidates: ${summary.survivors} likely vulnerabilities, ` +
  `${summary.needsHumanReview} need review, ${summary.dismissed} dismissed` +
  (summary.pending > 0 ? `, ${summary.pending} pending` : "") +
  (summary.errors > 0 ? `, ${summary.errors} errors` : "") +
  (summary.resolved > 0 ? `, ${summary.resolved} no longer reported by Fallow` : "");

const INTRO =
  "Fallow found these candidates; Jev assessed the supplied code. Review the evidence before acting on a verdict.";

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
    "The assessment is inconclusive. Review how input reaches the sensitive operation and check the protections along that path.",
} satisfies Record<Exclude<PolicyRule, "survivor" | "dismissed">, string>;

const DISMISSAL_REASONS: Readonly<Partial<Record<string, string>>> = {
  "not-attacker-controlled": "Jev considers the input outside an attacker's control.",
  "does-not-reach-sink": "Jev considers the input unable to reach the sensitive operation.",
  mitigated: "Jev considers the protection in the supplied code effective.",
  "non-production-code": "Jev identifies this as code that does not run in production.",
} satisfies Record<DismissalReason, string>;

const explanation = (decision: SavedDecision): string => {
  if (decision.rule === "survivor")
    return "Jev assessed these as exploitable in the supplied code.";
  if (decision.rule === "dismissed")
    return decision.dismissalReason === null
      ? decision.reason
      : (DISMISSAL_REASONS[decision.dismissalReason] ?? decision.reason);
  return REVIEW_REASONS[decision.rule] ?? decision.reason;
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

const verdictColor = (verdict: VerdictStatus): "red" | "yellow" | "dim" =>
  verdict === "survivor" ? "red" : verdict === "needs-human-review" ? "yellow" : "dim";

const incomplete = (report: Report): FindingRecord[] =>
  report.findings.filter((record) => record.status === "pending" || record.status === "error");

const incompleteReason = (record: FindingRecord): string =>
  record.error === null
    ? "No current assessment. Run fallow-verdict judge with the same config and question profile to continue."
    : `${record.error.code}: ${record.error.message}`;

export const renderHuman = (report: Report, showDismissed: boolean): string => {
  const lines: string[] = [styleText("bold", "Security review"), "", summaryLine(report), ""];
  if (report.summary.candidates === 0) lines.push("No active candidates in this report.", "");
  for (const verdict of VERDICT_ORDER) {
    const records = group(report, verdict);
    if (records.length === 0 || (verdict === "dismissed" && !showDismissed)) continue;
    lines.push(
      styleText(["bold", verdictColor(verdict)], `${VERDICT_TITLE[verdict]} (${records.length})`),
    );
    if (verdict === "survivor")
      lines.push("Jev assessed these as exploitable in the supplied code.");
    for (const record of records) {
      const decision = record.decision;
      if (decision === null) continue;
      lines.push(
        "",
        `  ${record.path}:${record.line}`,
        `  ${categoryLabel(record.category)} | Fallow severity: ${record.severity}`,
        ...(decision.rule === "survivor" ? [] : [`  ${explanation(decision)}`]),
        styleText("dim", `  ${estimate(decision)}`),
      );
      const suggestion = nextStep(decision);
      if (suggestion !== null) lines.push(`  ${suggestion}`);
    }
    lines.push("");
  }
  const unfinished = incomplete(report);
  if (unfinished.length > 0) {
    lines.push("Not assessed", "");
    for (const record of unfinished)
      lines.push(
        `  ${record.path}:${record.line} | ${record.status === "error" ? "Assessment failed" : "Pending"}`,
        `  ${incompleteReason(record)}`,
        "",
      );
    lines.push("");
  }
  if (!showDismissed && report.summary.dismissed > 0) {
    lines.push(styleText("dim", "Use --show-dismissed to include dismissed candidates."));
  }
  if (report.summary.candidates > 0)
    lines.push(
      styleText("dim", "Review suggested approaches against the code before making changes."),
    );
  lines.push(styleText("dim", `Recorded assessment cost: ${formatUsd(report.summary.costUsd)}`));
  return lines.join("\n");
};

const escapeText = (text: string): string =>
  text.replaceAll(/[\\`*_{}[\]<>#|!]/g, "\\$&").replaceAll(/[\r\n]/g, " ");

export const renderMarkdown = (report: Report): string => {
  const lines: string[] = ["# Security review", "", summaryLine(report), "", INTRO, ""];
  if (report.summary.candidates === 0) lines.push("No active candidates in this report.", "");
  for (const verdict of VERDICT_ORDER) {
    const records = group(report, verdict);
    if (records.length === 0) continue;
    lines.push(`## ${VERDICT_TITLE[verdict]} (${records.length})`, "");
    if (verdict === "survivor")
      lines.push("Jev assessed these as exploitable in the supplied code.", "");
    for (const record of records) {
      const decision = record.decision;
      if (decision === null) continue;
      lines.push(
        `### ${escapeText(record.path)}:${record.line}`,
        "",
        `${escapeText(categoryLabel(record.category))} | Fallow severity: ${record.severity}`,
        "",
        ...(decision.rule === "survivor" ? [] : [escapeText(explanation(decision)), ""]),
        estimate(decision),
        "",
      );
      const suggestion = nextStep(decision);
      if (suggestion !== null) lines.push(escapeText(suggestion), "");
      lines.push(
        "<details>",
        "<summary>Assessment details</summary>",
        "",
        `Decision rule: ${escapeText(decision.rule)}.`,
        ...(decision.impact === null
          ? []
          : [`Jev impact estimate: ${escapeText(decision.impact.label)}.`]),
        "",
        escapeText(decision.reason),
        "",
        "</details>",
        "",
      );
    }
    lines.push("");
  }
  const unfinished = incomplete(report);
  if (unfinished.length > 0) {
    lines.push("## Not assessed", "");
    for (const record of unfinished)
      lines.push(
        `### ${escapeText(record.path)}:${record.line}`,
        "",
        `${record.status === "error" ? "Assessment failed" : "Pending"}. ${escapeText(incompleteReason(record))}`,
        "",
      );
    lines.push("");
  }
  if (report.summary.candidates > 0)
    lines.push("Review suggested approaches against the code before making changes.", "");
  lines.push(`Recorded assessment cost: ${formatUsd(report.summary.costUsd)}`, "");
  return lines.join("\n");
};
