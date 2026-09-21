import { styleText } from "node:util";

import type { VerdictStatus } from "../fallow/types.ts";
import type { FindingRecord } from "../state/schema.ts";
import { formatUsd } from "../util/tokens.ts";

export const REPORT_SCHEMA = "fallow-verdict-report/v1";

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const VERDICT_ORDER: readonly VerdictStatus[] = ["survivor", "needs-human-review", "dismissed"];
const VERDICT_TITLE: Record<VerdictStatus, string> = {
  survivor: "Survivors",
  "needs-human-review": "Needs human review",
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
  `${summary.candidates} candidates: ${summary.survivors} survivors, ` +
  `${summary.needsHumanReview} need review, ${summary.dismissed} dismissed` +
  (summary.pending > 0 ? `, ${summary.pending} pending` : "") +
  (summary.errors > 0 ? `, ${summary.errors} errors` : "") +
  (summary.resolved > 0 ? `, ${summary.resolved} resolved since first seen` : "");

const verdictColor = (verdict: VerdictStatus): "red" | "yellow" | "dim" =>
  verdict === "survivor" ? "red" : verdict === "needs-human-review" ? "yellow" : "dim";

export const renderHuman = (report: Report, showDismissed: boolean): string => {
  const lines: string[] = [styleText("bold", summaryLine(report)), ""];
  for (const verdict of VERDICT_ORDER) {
    const records = group(report, verdict);
    if (records.length === 0 || (verdict === "dismissed" && !showDismissed)) continue;
    lines.push(
      styleText(["bold", verdictColor(verdict)], `${VERDICT_TITLE[verdict]} (${records.length})`),
    );
    for (const record of records) {
      const decision = record.decision;
      if (decision === null) continue;
      const impact = decision.impact ? `  impact ${decision.impact.label}` : "";
      const fix = decision.fixDirection ? `  fix ${decision.fixDirection}` : "";
      lines.push(
        `  ${record.severity.padEnd(6)} ${record.path}:${record.line}  ${record.category ?? "client-server-leak"}`,
        styleText(
          "dim",
          `         ${decision.confidence.toFixed(2)}  ${decision.rule}${impact}${fix}`,
        ),
      );
    }
    lines.push("");
  }
  if (!showDismissed && report.summary.dismissed > 0) {
    lines.push(
      styleText("dim", "Dismissed candidates are hidden. Pass --show-dismissed to list them."),
    );
  }
  lines.push(styleText("dim", `Cost of recorded judgments: ${formatUsd(report.summary.costUsd)}`));
  return lines.join("\n");
};

const escapeCell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

export const renderMarkdown = (report: Report): string => {
  const lines: string[] = [
    "# Security verdicts",
    "",
    summaryLine(report),
    "",
    "Candidates come from `fallow security`. A fixed policy maps model probabilities to verdicts. A verdict is a triage result, not proof.",
    "",
  ];
  for (const verdict of VERDICT_ORDER) {
    const records = group(report, verdict);
    if (records.length === 0) continue;
    lines.push(
      `## ${VERDICT_TITLE[verdict]} (${records.length})`,
      "",
      "| Severity | Location | Category | Confidence | Rule | Impact | Fix direction |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const record of records) {
      const decision = record.decision;
      if (decision === null) continue;
      lines.push(
        `| ${record.severity} | \`${escapeCell(record.path)}:${record.line}\` | ${escapeCell(record.category ?? "client-server-leak")} | ${decision.confidence.toFixed(2)} | ${decision.dismissalReason ?? decision.rule} | ${decision.impact?.label ?? ""} | ${decision.fixDirection ?? ""} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
};
