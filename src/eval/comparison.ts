import { createHash } from "node:crypto";

import type { Policy } from "../config/schema.ts";
import type { Answer, DecisionEngine, Question } from "../engine/types.ts";
import type { BuiltPacket, VerifierPacket } from "../packet/build.ts";
import { decide, type Decision } from "../policy/decide.ts";
import type { VerdictError } from "../util/errors.ts";
import { estimateTokens, tokensToUsd } from "../util/tokens.ts";

export type ComparisonCase = {
  id: string;
  expected: "safe" | "vulnerable";
  mustReview: boolean;
  built: BuiltPacket;
};

export type QuestionVariant = {
  id: string;
  questions: (packet: VerifierPacket) => Record<string, Question>;
};

export type Observation = {
  caseId: string;
  expected: ComparisonCase["expected"];
  mustReview: boolean;
  repeat: number;
  variant: string;
  packetHash: string;
  questionsHash: string;
  model: string | null;
  answers: Record<string, Answer> | null;
  decision: Decision | null;
  error: VerdictError | null;
  inputTokens: number;
  latencyMs: number;
};

export type VariantSummary = {
  variant: string;
  complete: boolean;
  unsafeDismissals: string[];
  reviewGuardMisses: string[];
  dismissPrecision: number | null;
  survivorRecall: number | null;
  noiseRemoved: number | null;
  reviewRate: number | null;
  verdictFlips: string[];
};

export type ComparisonReport = {
  schema_version: "fallow-verdict-comparison/v1";
  startedAt: string;
  requestedModel: string;
  repeats: number;
  policy: Policy;
  complete: boolean;
  stopError: VerdictError | null;
  estimatedUsd: number;
  costUsd: number;
  observations: Observation[];
  summaries: VariantSummary[];
};

/** Digest exact serialized inputs so changes cannot silently inherit an earlier result. */
export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

const uniqueIds = (matches: Observation[]): string[] => [
  ...new Set(matches.map((row) => row.caseId)),
];

const summarize = (
  cases: readonly ComparisonCase[],
  observations: Observation[],
  variant: string,
  repeats: number,
): VariantSummary => {
  const rows = observations.filter((row) => row.variant === variant);
  const complete =
    rows.length === cases.length * repeats && rows.every((row) => row.error === null);
  const dismissed = rows.filter((row) => row.decision?.verdict === "dismissed");
  return {
    variant,
    complete,
    unsafeDismissals: uniqueIds(dismissed.filter((row) => row.expected === "vulnerable")),
    reviewGuardMisses: uniqueIds(
      rows.filter(
        (row) =>
          row.mustReview && row.decision !== null && row.decision.verdict !== "needs-human-review",
      ),
    ),
    dismissPrecision: complete
      ? ratio(dismissed.filter((row) => row.expected === "safe").length, dismissed.length)
      : null,
    survivorRecall: complete
      ? ratio(
          rows.filter(
            (row) => row.expected === "vulnerable" && row.decision?.verdict === "survivor",
          ).length,
          cases.filter((item) => item.expected === "vulnerable").length * repeats,
        )
      : null,
    noiseRemoved: complete
      ? ratio(
          dismissed.filter((row) => row.expected === "safe").length,
          cases.filter((item) => item.expected === "safe").length * repeats,
        )
      : null,
    reviewRate: complete
      ? ratio(
          rows.filter((row) => row.decision?.verdict === "needs-human-review").length,
          rows.length,
        )
      : null,
    verdictFlips: cases
      .filter(
        (item) =>
          new Set(
            rows
              .filter((row) => row.caseId === item.id && row.decision !== null)
              .map((row) => row.decision?.verdict),
          ).size > 1,
      )
      .map((item) => item.id),
  };
};

/** Fresh paired evaluations share frozen packets and policy, with alternating variant order. */
export const compareQuestions = async (options: {
  cases: readonly ComparisonCase[];
  variants: readonly QuestionVariant[];
  engine: DecisionEngine;
  model: string;
  policy: Policy;
  repeats: number;
  maxCostUsd: number;
  dryRun: boolean;
}): Promise<ComparisonReport> => {
  if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 10)
    throw new Error("Repeats must be an integer from 1 to 10.");
  if (options.cases.length === 0 || options.variants.length < 2)
    throw new Error("A comparison needs cases and at least two variants.");
  if (
    new Set(options.cases.map((item) => item.id)).size !== options.cases.length ||
    new Set(options.variants.map((variant) => variant.id)).size !== options.variants.length
  )
    throw new Error("Case and variant IDs must be unique.");
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0)
    throw new Error("The cost budget must be positive and finite.");
  if (!/^jev-\d+\.\d+\.\d+$/.test(options.model))
    throw new Error("Comparisons require a pinned Jev model version.");

  const jobs = options.cases.map((item) => ({
    ...item,
    built: structuredClone(item.built),
    variants: options.variants.map((variant) => ({
      id: variant.id,
      questions: structuredClone(variant.questions(structuredClone(item.built.packet))),
    })),
  }));
  const observations: Observation[] = [];
  const report: ComparisonReport = {
    schema_version: "fallow-verdict-comparison/v1",
    startedAt: new Date().toISOString(),
    requestedModel: options.model,
    repeats: options.repeats,
    policy: structuredClone(options.policy),
    complete: false,
    stopError: null,
    estimatedUsd: tokensToUsd(
      jobs.reduce(
        (sum, item) =>
          sum +
          item.variants.reduce(
            (total, variant) => total + item.built.stateTokens + estimateTokens(variant.questions),
            0,
          ),
        0,
      ) * options.repeats,
    ),
    costUsd: 0,
    observations,
    summaries: [],
  };
  if (options.dryRun) return report;

  rounds: for (let repeat = 0; repeat < options.repeats; repeat += 1) {
    for (const [index, item] of jobs.entries()) {
      const variants = (repeat + index) % 2 === 0 ? item.variants : item.variants.toReversed();
      for (const variant of variants) {
        const estimate = tokensToUsd(item.built.stateTokens + estimateTokens(variant.questions));
        if (report.costUsd + estimate > options.maxCostUsd) {
          report.stopError = {
            code: "budget_exhausted",
            message: "Comparison budget exhausted before completing all pairs.",
          };
          break rounds;
        }
        const response = await options.engine.evaluate({
          state: structuredClone(item.built.packet),
          questions: structuredClone(variant.questions),
        });
        const mismatch = response.ok && response.data.model !== options.model;
        const error: VerdictError | null = !response.ok
          ? response.error
          : mismatch
            ? {
                code: "engine_response_invalid",
                message: `Expected ${options.model}, received ${response.data.model}.`,
              }
            : null;
        const row: Observation = {
          caseId: item.id,
          expected: item.expected,
          mustReview: item.mustReview,
          repeat,
          variant: variant.id,
          packetHash: digest(item.built.packet),
          questionsHash: digest(variant.questions),
          model: response.ok ? response.data.model : null,
          answers: response.ok ? response.data.answers : null,
          decision:
            response.ok && error === null
              ? decide(response.data.answers, item.built, report.policy)
              : null,
          error,
          inputTokens: response.ok ? response.data.inputTokens : 0,
          latencyMs: response.ok ? response.data.latencyMs : 0,
        };
        observations.push(row);
        report.costUsd += tokensToUsd(row.inputTokens);
        if (error !== null) {
          report.stopError = error;
          break rounds;
        }
      }
    }
  }
  report.summaries = options.variants.map((variant) =>
    summarize(options.cases, observations, variant.id, options.repeats),
  );
  report.complete = report.summaries.every((summary) => summary.complete);
  return report;
};
