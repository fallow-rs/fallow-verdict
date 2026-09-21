import { z } from "zod";

import type { FindingRecord } from "../state/schema.ts";

export const LABELS_SCHEMA = "fallow-verdict-labels/v1";

/** Ground truth for a candidate: is it a real, exploitable issue or not. */
export const labelsSchema = z.object({
  schema_version: z.literal(LABELS_SCHEMA),
  labels: z.array(
    z.object({
      finding_id: z.string().min(1),
      expected: z.enum(["vulnerable", "safe"]),
      note: z.string().optional(),
    }),
  ),
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
};

const CALIBRATION_BINS = 10;

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
  const byId = new Map(records.map((record) => [record.finding_id, record]));
  const pairs = labels.labels.flatMap(({ finding_id, expected }) => {
    const decision = byId.get(finding_id)?.decision ?? null;
    return decision === null
      ? []
      : [{ finding_id, vulnerable: expected === "vulnerable", decision }];
  });

  const dismissed = pairs.filter(({ decision }) => decision.verdict === "dismissed");
  const vulnerable = pairs.filter((pair) => pair.vulnerable);
  const safe = pairs.filter((pair) => !pair.vulnerable);
  const missed = dismissed.filter((pair) => pair.vulnerable);

  return {
    labeled: labels.labels.length,
    judged: pairs.length,
    unjudged: labels.labels.length - pairs.length,
    dismissPrecision: ratio(dismissed.length - missed.length, dismissed.length),
    missedVulnerabilities: missed.map(({ finding_id }) => finding_id),
    survivorRecall: ratio(
      vulnerable.filter(({ decision }) => decision.verdict === "survivor").length,
      vulnerable.length,
    ),
    noiseRemoved: ratio(
      safe.filter(({ decision }) => decision.verdict === "dismissed").length,
      safe.length,
    ),
    reviewRate: ratio(
      pairs.filter(({ decision }) => decision.verdict === "needs-human-review").length,
      pairs.length,
    ),
    calibrationError: calibrationError(
      pairs.flatMap(({ decision, vulnerable: isVulnerable }) => {
        const p = decision.probabilities["exploitable"];
        return p === undefined ? [] : [{ p, vulnerable: isVulnerable }];
      }),
    ),
  };
};
