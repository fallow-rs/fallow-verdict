import { styleText } from "node:util";

import { recordLocations, type FindingRecord, type StoredDecision } from "../state/schema.ts";
import { formatUsd } from "../util/tokens.ts";

export const REPORT_SCHEMA = "fallow-verdict-report/v1";

type VerdictStatus = StoredDecision["verdict"];

const VERDICT_ORDER: readonly VerdictStatus[] = ["survivor", "needs-human-review", "dismissed"];

/** The kind-specific lines for one judged finding. */
export type FindingText = {
  /**
   * What Fallow reported, for example the category and the severity. The reports join the parts
   * with ` | ` and escape each part on its own, so the separator stays plain Markdown.
   */
  facts: readonly string[];
  /** Why the policy chose the verdict, or null when the group heading says enough. */
  explanation: string | null;
  /** The model estimate behind the verdict. */
  estimate: string;
  suggestion: string | null;
};

/**
 * The words and evidence lines that a kind supplies to the shared reports. The three verdict
 * values are shared; only `survivor` has a meaning that depends on the kind.
 */
export type KindPresentation = {
  /** Report heading, for example "Security review". */
  title: string;
  /** Lead paragraph of the Markdown report. */
  intro: string;
  survivor: {
    /** Group heading, for example "Likely vulnerabilities". */
    heading: string;
    /** Progress label for one finding, for example "Likely vulnerability". */
    label: string;
    /** Count noun in the summary line, for example "likely vulnerabilities". */
    count: string;
    /** First line under the group heading. */
    note: string;
  };
  describe: (record: FindingRecord, decision: StoredDecision) => FindingText;
};

const FACT_SEPARATOR = " | ";

const verdictTitle = (presentation: KindPresentation, verdict: VerdictStatus): string =>
  verdict === "survivor"
    ? presentation.survivor.heading
    : verdict === "needs-human-review"
      ? "Needs review"
      : "Dismissed";

export type ReportSummary = {
  candidates: number;
  survivors: number;
  needsHumanReview: number;
  dismissed: number;
  pending: number;
  errors: number;
  resolved: number;
  costUsd: number;
  /** Findings that a person closed. Present only when there is at least one. */
  closed?: number;
};

export type Report = {
  schema_version: typeof REPORT_SCHEMA;
  generatedAt: string;
  summary: ReportSummary;
  findings: FindingRecord[];
  /** Findings that a person closed, apart from `findings`. Present only when there is one. */
  closed?: FindingRecord[];
};

const byPriority =
  (priority: (record: FindingRecord) => number) =>
  (a: FindingRecord, b: FindingRecord): number =>
    priority(a) - priority(b) ||
    (b.decision?.confidence ?? 0) - (a.decision?.confidence ?? 0) ||
    a.path.localeCompare(b.path) ||
    a.line - b.line ||
    (a.col ?? -1) - (b.col ?? -1);

/** `priority` is the adapter priority of the kind: a lower value comes first. */
export const buildReport = (
  records: readonly FindingRecord[],
  priority: (record: FindingRecord) => number,
): Report => {
  const live = records.filter((record) => record.status !== "resolved");
  // A person closed these, so they leave the verdict groups and the exit code.
  const closed = live.filter((record) => record.closed !== undefined);
  const open = live.filter((record) => record.closed === undefined);
  const count = (verdict: VerdictStatus): number =>
    open.filter((record) => record.status === "judged" && record.decision?.verdict === verdict)
      .length;
  const report: Report = {
    schema_version: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    summary: {
      candidates: live.length,
      survivors: count("survivor"),
      needsHumanReview: count("needs-human-review"),
      dismissed: count("dismissed"),
      pending: open.filter((record) => record.status === "pending").length,
      errors: open.filter((record) => record.status === "error").length,
      resolved: records.length - live.length,
      costUsd: records.reduce((sum, record) => sum + (record.usage?.costUsd ?? 0), 0),
    },
    findings: open.toSorted(byPriority(priority)),
  };
  if (closed.length === 0) return report;
  return {
    ...report,
    summary: { ...report.summary, closed: closed.length },
    closed: closed.toSorted(byPriority(priority)),
  };
};

const CLOSED_TITLE = "Closed by a person";

const group = (report: Report, verdict: VerdictStatus): FindingRecord[] =>
  report.findings.filter(
    (record) => record.status === "judged" && record.decision?.verdict === verdict,
  );

const summaryLine = ({ summary }: Report, presentation: KindPresentation): string =>
  `${summary.candidates} candidates: ${summary.survivors} ${presentation.survivor.count}, ` +
  `${summary.needsHumanReview} need review, ${summary.dismissed} dismissed` +
  (summary.pending > 0 ? `, ${summary.pending} pending` : "") +
  (summary.errors > 0 ? `, ${summary.errors} errors` : "") +
  (summary.closed === undefined ? "" : `, ${summary.closed} closed by a person`) +
  (summary.resolved > 0 ? `, ${summary.resolved} no longer reported by Fallow` : "");

const verdictColor = (verdict: VerdictStatus): "red" | "yellow" | "dim" =>
  verdict === "survivor" ? "red" : verdict === "needs-human-review" ? "yellow" : "dim";

const incomplete = (report: Report): FindingRecord[] =>
  report.findings.filter((record) => record.status === "pending" || record.status === "error");

const location = (record: FindingRecord): string =>
  recordLocations(record)
    .map(({ path, line, col }) => `${path}:${line}${col == null ? "" : `:${col}`}`)
    .join(", ");

const NEXT_ASSESSMENT =
  "No current assessment. Run fallow-verdict judge with the same config and question profile to continue.";

const incompleteReason = (record: FindingRecord): string | null =>
  record.error === null ? null : `${record.error.code}: ${record.error.message}`;

export const renderHuman = (
  report: Report,
  presentation: KindPresentation,
  showDismissed: boolean,
): string => {
  const lines: string[] = [
    styleText("bold", presentation.title),
    "",
    summaryLine(report, presentation),
    "",
  ];
  if (report.summary.candidates === 0) lines.push("No active candidates in this report.", "");
  for (const verdict of VERDICT_ORDER) {
    const records = group(report, verdict);
    if (records.length === 0 || (verdict === "dismissed" && !showDismissed)) continue;
    lines.push(
      styleText(
        ["bold", verdictColor(verdict)],
        `${verdictTitle(presentation, verdict)} (${records.length})`,
      ),
    );
    if (verdict === "survivor") lines.push(presentation.survivor.note);
    for (const record of records) {
      const decision = record.decision;
      if (decision === null) continue;
      const text = presentation.describe(record, decision);
      lines.push(
        "",
        `  ${location(record)}`,
        `  ${text.facts.join(FACT_SEPARATOR)}`,
        ...(text.explanation === null ? [] : [`  ${text.explanation}`]),
        styleText("dim", `  ${text.estimate}`),
      );
      if (text.suggestion !== null) lines.push(`  ${text.suggestion}`);
    }
    lines.push("");
  }
  const unfinished = incomplete(report);
  if (unfinished.length > 0) {
    lines.push("Not assessed", "");
    if (unfinished.some((record) => record.error === null)) lines.push(NEXT_ASSESSMENT, "");
    for (const record of unfinished)
      lines.push(
        `  ${location(record)} | ${record.status === "error" ? "Assessment failed" : "Pending"}`,
        ...(record.error === null ? [] : [`  ${incompleteReason(record)}`]),
        "",
      );
    lines.push("");
  }
  const closed = report.closed ?? [];
  if (closed.length > 0) {
    lines.push(styleText(["bold", "dim"], `${CLOSED_TITLE} (${closed.length})`));
    for (const record of closed) {
      lines.push(
        "",
        `  ${location(record)}`,
        `  Reason: ${record.closed?.reason ?? ""}`,
        styleText("dim", `  Closed at ${record.closed?.at ?? ""}.`),
      );
    }
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

export const renderMarkdown = (report: Report, presentation: KindPresentation): string => {
  const lines: string[] = [
    `# ${presentation.title}`,
    "",
    summaryLine(report, presentation),
    "",
    presentation.intro,
    "",
  ];
  if (report.summary.candidates === 0) lines.push("No active candidates in this report.", "");
  for (const verdict of VERDICT_ORDER) {
    const records = group(report, verdict);
    if (records.length === 0) continue;
    lines.push(`## ${verdictTitle(presentation, verdict)} (${records.length})`, "");
    if (verdict === "survivor") lines.push(presentation.survivor.note, "");
    for (const record of records) {
      const decision = record.decision;
      if (decision === null) continue;
      const text = presentation.describe(record, decision);
      lines.push(
        `### ${escapeText(location(record))}`,
        "",
        text.facts.map(escapeText).join(FACT_SEPARATOR),
        "",
        ...(text.explanation === null ? [] : [escapeText(text.explanation), ""]),
        escapeText(text.estimate),
        "",
      );
      if (text.suggestion !== null) lines.push(escapeText(text.suggestion), "");
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
    if (unfinished.some((record) => record.error === null)) lines.push(NEXT_ASSESSMENT, "");
    for (const record of unfinished)
      lines.push(
        `### ${escapeText(location(record))}`,
        "",
        `${record.status === "error" ? "Assessment failed" : "Pending"}.`,
        ...(record.error === null ? [] : [escapeText(incompleteReason(record) ?? "")]),
        "",
      );
    lines.push("");
  }
  const closed = report.closed ?? [];
  if (closed.length > 0) {
    lines.push(`## ${CLOSED_TITLE} (${closed.length})`, "");
    for (const record of closed) {
      lines.push(
        `### ${escapeText(location(record))}`,
        "",
        `Reason: ${escapeText(record.closed?.reason ?? "")}`,
        "",
        `Closed at ${escapeText(record.closed?.at ?? "")}.`,
        "",
      );
    }
  }
  if (report.summary.candidates > 0)
    lines.push("Review suggested approaches against the code before making changes.", "");
  lines.push(`Recorded assessment cost: ${formatUsd(report.summary.costUsd)}`, "");
  return lines.join("\n");
};
