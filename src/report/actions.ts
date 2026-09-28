import { z } from "zod";

import { DEFAULT_KIND } from "../kinds/names.ts";
import type { JudgeSummary } from "../pipeline/judge.ts";
import { recordSchema, runSchema, type FindingRecord } from "../state/schema.ts";
import { quote } from "../util/shell.ts";
import { REPORT_SCHEMA, type Report } from "./render.ts";

/** The fields of a Fallow-style action that `check`, `judge`, `run`, `report` and `status` share. */
export const actionFields = {
  /** Always false: a person or a coding assistant runs the command. */
  auto_fixable: z.literal(false),
  description: z.string(),
  command: z.string(),
  /** The finding that the action is for. Absent for an action on the whole project. */
  finding_id: z.string().optional(),
};

/**
 * `run` and `judge`: the same command without `--dry-run`. `judge`: assess the pending findings.
 * `check`: check one finding again after an edit. `close`: a person records a judgment.
 * `report`: show the verdicts.
 */
export const nextActionSchema = z.object({
  type: z.enum(["run", "judge", "check", "close", "report"]),
  ...actionFields,
});

export type NextAction = z.infer<typeof nextActionSchema>;

/** The JSON output of `report`, `status` and `run` without `--dry-run`. */
export const reportOutputSchema = z.object({
  schema_version: z.literal(REPORT_SCHEMA),
  generatedAt: z.string(),
  summary: z.object({
    candidates: z.number(),
    survivors: z.number(),
    needsHumanReview: z.number(),
    dismissed: z.number(),
    pending: z.number(),
    errors: z.number(),
    resolved: z.number(),
    costUsd: z.number(),
    /** Findings that a person closed. Present only when there is at least one. */
    closed: z.number().optional(),
  }),
  findings: z.array(recordSchema),
  /** Findings that a person closed, apart from `findings`. Present only when there is one. */
  closed: z.array(recordSchema).optional(),
  actions: z.array(nextActionSchema),
});

/** The JSON output of `judge` and of `run --dry-run`. */
export const judgeOutputSchema = z.object({
  runId: z.string(),
  outcome: runSchema.shape.outcome,
  judged: z.number(),
  upToDate: z.number(),
  errors: z.number(),
  pending: z.number(),
  inputTokens: z.number(),
  costUsd: z.number(),
  estimatedUsd: z.number(),
  /** Upper bound for dismissal confirmation calls, on top of `estimatedUsd`. */
  maxConfirmationUsd: z.number(),
  fatal: z
    .object({ code: z.string(), message: z.string(), hint: z.string().optional() })
    .nullable(),
  actions: z.array(nextActionSchema),
});

const kindSuffix = (kind: string): string => (kind === DEFAULT_KIND ? "" : ` --kind ${kind}`);

const findingActions = (record: FindingRecord, suffix: string): NextAction[] => {
  const verdict = record.status === "judged" ? record.decision?.verdict : undefined;
  if (verdict !== "survivor" && verdict !== "needs-human-review") return [];
  const id = quote(record.finding_id);
  const check: NextAction = {
    type: "check",
    auto_fixable: false,
    description: "Check this finding again after you change the code.",
    command: `fallow-verdict check ${id}${suffix}`,
    finding_id: record.finding_id,
  };
  return [
    check,
    {
      type: "close",
      auto_fixable: false,
      description:
        "Only a person can close this finding. Send this action to the user. Replace <reason> with the reason of the user.",
      command: `fallow-verdict close ${id} --reason "<reason>"${suffix}`,
      finding_id: record.finding_id,
    },
  ];
};

/**
 * Next steps for a report: `judge` when findings have no current assessment, then for each open
 * finding a `check` and a `close`, as `check` gives them. Only a person can close a finding.
 * Dismissed and closed findings have no action.
 */
export const reportActions = (report: Report, kind: string): NextAction[] => {
  const suffix = kindSuffix(kind);
  const judge: NextAction[] =
    report.summary.pending + report.summary.errors > 0
      ? [
          {
            type: "judge",
            auto_fixable: false,
            description:
              "Assess the findings that have no current assessment. Use the same config and question profile.",
            command: `fallow-verdict judge${suffix}`,
          },
        ]
      : [];
  return [...judge, ...report.findings.flatMap((record) => findingActions(record, suffix))];
};

/**
 * Next steps after `judge` or `run --dry-run`. A dry run offers the same command without
 * `--dry-run`. A real `judge` offers `judge` again while findings are pending, then `report`.
 */
export const judgeActions = (
  summary: JudgeSummary,
  run: { command: "judge" | "run"; kind: string; dryRun: boolean; argv: readonly string[] },
): NextAction[] => {
  const suffix = kindSuffix(run.kind);
  if (run.dryRun) {
    if (run.command === "judge" && summary.pending === 0) return [];
    return [
      {
        type: run.command,
        auto_fixable: false,
        description:
          "Run the same command without --dry-run. It sends requests to Jev. Show the estimated cost to the user first.",
        command: `fallow-verdict ${run.argv
          .filter((arg) => arg !== "--dry-run")
          .map(quote)
          .join(" ")}`,
      },
    ];
  }
  const actions: NextAction[] = [];
  if (summary.pending > 0)
    actions.push({
      type: "judge",
      auto_fixable: false,
      description: "Assess the remaining pending findings.",
      command: `fallow-verdict judge${suffix}`,
    });
  actions.push({
    type: "report",
    auto_fixable: false,
    description: "Show the verdicts and write the reports.",
    command: `fallow-verdict report${suffix}`,
  });
  return actions;
};
