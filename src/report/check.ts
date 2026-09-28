import { styleText } from "node:util";

import { z } from "zod";

import { locationSchema } from "../state/schema.ts";
import { formatUsd } from "../util/tokens.ts";
import type { FindingText, KindPresentation } from "./render.ts";

export const CHECK_SCHEMA = "fallow-verdict-check/v1";

/** Exit codes of `check`. The other commands never exit 3. */
export const CHECK_EXIT = { cleared: 0, stands: 1, error: 2, needsPerson: 3 } as const;

const probability = z.number().min(0).max(1);

const actionSchema = z.object({
  type: z.enum(["rerun-check", "close", "scan"]),
  /** Always false: a person or a coding assistant runs the command. */
  auto_fixable: z.literal(false),
  description: z.string(),
  command: z.string(),
  /** The finding that `close` records a judgment for. */
  finding_id: z.string().optional(),
});

const resultSchema = z.object({
  /**
   * `resolved`: Fallow no longer reports the finding. `closed`: a person closed it and its
   * evidence did not change. `judged`: Jev assessed the current source. `ambiguous`: more than
   * one current finding can be the stored finding. `not-assessed`: a dry run. `error`: the
   * assessment failed.
   */
  status: z.enum(["resolved", "closed", "judged", "ambiguous", "not-assessed", "error"]),
  /** Id in the current Fallow output. Null when Fallow no longer reports the finding. */
  finding_id: z.string().nullable(),
  /** Id in the last saved scan. Null for a finding that the last scan did not have. */
  stored_id: z.string().nullable(),
  /** Current locations, or the saved locations of a resolved finding. Primary first. */
  locations: z.array(locationSchema),
  category: z.string().nullable(),
  verdict: z.enum(["survivor", "dismissed", "needs-human-review"]).nullable(),
  rule: z.string().nullable(),
  confidence: probability.nullable(),
  reason: z.string(),
  /** Current finding ids that match the stored finding. More than one only when ambiguous. */
  matches: z.array(z.string()),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export const checkReportSchema = z.object({
  schema_version: z.literal(CHECK_SCHEMA),
  kind: z.string(),
  target: z.object({ type: z.enum(["finding", "path"]), value: z.string() }),
  dry_run: z.boolean(),
  /** The most severe result: `error`, then `needs-person`, `stands`, `estimated`, `cleared`. */
  outcome: z.enum(["cleared", "stands", "needs-person", "error", "estimated"]),
  exit_code: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  /** Estimated input for the findings that need an assessment. */
  estimate: z.object({ input_tokens: z.number(), usd: z.number() }),
  /** Recorded input of the requests that this check sent. */
  usage: z.object({ input_tokens: z.number(), cost_usd: z.number() }),
  results: z.array(resultSchema),
  actions: z.array(actionSchema),
});

export type CheckReport = z.infer<typeof checkReportSchema>;
export type CheckResult = z.infer<typeof resultSchema>;
export type CheckAction = z.infer<typeof actionSchema>;

/** A check report and, for each result, the kind text of its assessment. */
export type CheckOutcome = { report: CheckReport; texts: (FindingText | null)[] };

const OUTCOME_TEXT: Readonly<Record<CheckReport["outcome"], string>> = {
  cleared: "Cleared",
  stands: "The finding stands",
  "needs-person": "A person must review this",
  error: "The check could not complete",
  estimated: "Estimate only",
};

const where = (result: CheckResult): string =>
  result.locations
    .map(({ path, line, col }) => `${path}:${line}${col === null ? "" : `:${col}`}`)
    .join(", ");

const label = (result: CheckResult, presentation: KindPresentation): string => {
  if (result.status === "judged")
    return result.verdict === "survivor"
      ? presentation.survivor.label
      : result.verdict === "dismissed"
        ? "Dismissed"
        : "Needs review";
  const labels: Readonly<Record<Exclude<CheckResult["status"], "judged">, string>> = {
    resolved: "Resolved",
    closed: "Closed by a person",
    ambiguous: "Needs a person",
    "not-assessed": "Not assessed",
    error: "Assessment failed",
  };
  return labels[result.status];
};

export const renderCheckHuman = (
  { report, texts }: CheckOutcome,
  presentation: KindPresentation,
): string => {
  const lines = [
    styleText("bold", `Check: ${report.target.value}`),
    `${OUTCOME_TEXT[report.outcome]} (exit ${report.exit_code}).`,
    "",
  ];
  if (report.results.length === 0) lines.push("Fallow reports no findings for this target.", "");
  report.results.forEach((result, index) => {
    lines.push(`  ${label(result, presentation)}: ${where(result)}`);
    const text = texts[index] ?? null;
    if (text === null)
      lines.push(
        result.error === null ? `  ${result.reason}` : `  ${result.reason} (${result.error.code})`,
      );
    else {
      lines.push(`  ${text.facts.join(" | ")}`);
      if (text.explanation !== null) lines.push(`  ${text.explanation}`);
      lines.push(styleText("dim", `  ${text.estimate}`));
      if (text.suggestion !== null) lines.push(`  ${text.suggestion}`);
    }
    lines.push("");
  });
  if (report.actions.length > 0) {
    lines.push("Next steps");
    for (const action of report.actions) lines.push(`  ${action.command}`);
    lines.push("");
  }
  if (report.dry_run)
    lines.push(
      `Estimated request cost: ${formatUsd(report.estimate.usd)} (about ${report.estimate.input_tokens} input tokens).`,
      "Dry run: no requests were sent to Jev.",
    );
  else
    lines.push(styleText("dim", `Recorded assessment cost: ${formatUsd(report.usage.cost_usd)}`));
  return lines.join("\n");
};
