import { z } from "zod";

import type { FindingRecord } from "../state/schema.ts";

export const LABELS_SCHEMA = "fallow-verdict-labels/v1";

/** Ground truth for a candidate: is it a real, exploitable issue or not. */
export const labelsSchema = z.object({
  schema_version: z.literal(LABELS_SCHEMA),
  labels: z
    .array(
      z.object({
        finding_id: z.string().min(1),
        expected: z.enum(["vulnerable", "safe"]),
        note: z.string().optional(),
      }),
    )
    .min(1)
    .superRefine((labels, context) => {
      const seen = new Set<string>();
      for (const [index, label] of labels.entries()) {
        if (seen.has(label.finding_id))
          context.addIssue({
            code: "custom",
            message: "Each finding_id must be labeled exactly once.",
            path: [index, "finding_id"],
          });
        seen.add(label.finding_id);
      }
    }),
});

export type Labels = z.infer<typeof labelsSchema>;

export type EvalReport = {
  labeled: number;
  judged: number;
  unjudged: number;
  /** Of the candidates dismissed, the share that really were safe. The number that must stay near 1. */
  dismissPrecision: number | null;
  /** Vulnerable candidates that were dismissed. Each one is a hidden vulnerability. */
  missedVulnerabilities: string[];
  /** Of the vulnerable candidates, the share called survivor. */
  survivorRecall: number | null;
  /** Of the safe candidates, the share dismissed: the review work the engine removed. */
  noiseRemoved: number | null;
  /** Share of judged candidates left for a human. */
  reviewRate: number | null;
  /** Expected calibration error of P(exploitable) over ten bins. */
  calibrationError: number | null;
  /**
   * Candidates whose first answers mapped to a dismissal, but that went to a person (rule
   * `dismissal-unconfirmed`), split by label. `disagreed`: a second answer set did not map to a
   * dismissal. `notConfirmed`: there is no second answer set (an old record, a budget stop or a
   * failed call).
   */
  dismissalsUnconfirmed: {
    total: number;
    disagreed: LabelCounts;
    notConfirmed: LabelCounts;
  };
};

export type LabelCounts = { vulnerable: number; safe: number };

const CALIBRATION_BINS = 10;

const labelCounts = (pairs: readonly { vulnerable: boolean }[]): LabelCounts => {
  const vulnerable = pairs.filter((pair) => pair.vulnerable).length;
  return { vulnerable, safe: pairs.length - vulnerable };
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

const calibrationError = (
  samples: readonly { p: number; vulnerable: boolean }[],
): number | null => {
  if (samples.length === 0) return null;
  let error = 0;
  for (let bin = 0; bin < CALIBRATION_BINS; bin += 1) {
    const lower = bin / CALIBRATION_BINS;
    const upper = (bin + 1) / CALIBRATION_BINS;
    const inBin = samples.filter(
      ({ p }) => p >= lower && (p < upper || (bin === CALIBRATION_BINS - 1 && p <= upper)),
    );
    if (inBin.length === 0) continue;
    const meanP = inBin.reduce((sum, { p }) => sum + p, 0) / inBin.length;
    const observed = inBin.filter(({ vulnerable }) => vulnerable).length / inBin.length;
    error += (inBin.length / samples.length) * Math.abs(meanP - observed);
  }
  return error;
};

export const evaluate = (records: readonly FindingRecord[], labels: Labels): EvalReport => {
  labelsSchema.parse(labels);
  const byId = new Map(records.map((record) => [record.finding_id, record]));
  const pairs = labels.labels.flatMap(({ finding_id, expected }) => {
    const record = byId.get(finding_id);
    const decision = record?.status === "judged" ? record.decision : null;
    return decision === null
      ? []
      : [
          {
            finding_id,
            vulnerable: expected === "vulnerable",
            decision,
            confirmed: record?.confirmationAnswers !== undefined,
          },
        ];
  });

  const dismissed = pairs.filter(({ decision }) => decision.verdict === "dismissed");
  const vulnerable = pairs.filter((pair) => pair.vulnerable);
  const safe = pairs.filter((pair) => !pair.vulnerable);
  const missed = dismissed.filter((pair) => pair.vulnerable);
  const complete = pairs.length === labels.labels.length;
  const unconfirmed = pairs.filter(({ decision }) => decision.rule === "dismissal-unconfirmed");
  const disagreed = unconfirmed.filter(({ confirmed }) => confirmed);

  return {
    labeled: labels.labels.length,
    judged: pairs.length,
    unjudged: labels.labels.length - pairs.length,
    dismissPrecision: complete ? ratio(dismissed.length - missed.length, dismissed.length) : null,
    missedVulnerabilities: missed.map(({ finding_id }) => finding_id),
    survivorRecall: complete
      ? ratio(
          vulnerable.filter(({ decision }) => decision.verdict === "survivor").length,
          vulnerable.length,
        )
      : null,
    noiseRemoved: complete
      ? ratio(safe.filter(({ decision }) => decision.verdict === "dismissed").length, safe.length)
      : null,
    reviewRate: complete
      ? ratio(
          pairs.filter(({ decision }) => decision.verdict === "needs-human-review").length,
          pairs.length,
        )
      : null,
    calibrationError: complete
      ? calibrationError(
          pairs.flatMap(({ decision, vulnerable: isVulnerable }) => {
            const p = decision.probabilities["exploitable"];
            return p === undefined ? [] : [{ p, vulnerable: isVulnerable }];
          }),
        )
      : null,
    dismissalsUnconfirmed: {
      total: unconfirmed.length,
      disagreed: labelCounts(disagreed),
      notConfirmed: labelCounts(unconfirmed.filter(({ confirmed }) => !confirmed)),
    },
  };
};
