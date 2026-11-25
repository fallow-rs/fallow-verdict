import { z } from "zod";

import type { StoredDecision } from "../state/schema.ts";

const MUTATION_LABELS_SCHEMA = "fallow-verdict-mutation-labels/v1";

const SPLITS = ["development", "holdout"] as const;
const mutantId = z.string().regex(/^[a-f0-9]{16}$/);

/** The fields of each label: the mutant as the Fallow run reported it. */
const labelBase = z.object({
  id: mutantId,
  project: z.string().min(1),
  split: z.enum(SPLITS),
  file: z.string().min(1),
  line: z.number().int().positive(),
  operator: z.string().min(1),
  function: z.string().nullable(),
  original_lines: z.string(),
  mutated_lines: z.string(),
});

/**
 * Ground truth for mutation survivors. A `real` label names the test file that kills the mutant.
 * An `equivalent` label holds the argument that no input shows the change.
 */
export const mutationLabelsSchema = z.object({
  schema_version: z.literal(MUTATION_LABELS_SCHEMA),
  /** The Fallow version and command of the runs that gave the survivors. */
  fallow: z.string().min(1),
  command: z.string().min(1),
  projects: z
    .array(
      z.object({
        id: z.string().min(1),
        split: z.enum(SPLITS),
        source: z.string().min(1),
        commit: z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .nullable(),
        license: z.string().min(1),
        runner: z.string().min(1),
        /** Which survivors of the run have a label. */
        selection: z.string().min(1),
      }),
    )
    .min(2),
  labels: z
    .array(
      z.discriminatedUnion("expected", [
        labelBase.extend({
          expected: z.literal("real"),
          kill_test: z.string().min(1),
          near_miss: z.enum(["detached-method", "json-parse-null"]).optional(),
        }),
        labelBase.extend({
          expected: z.literal("equivalent"),
          argument: z.string().min(20),
        }),
      ]),
    )
    .min(1),
});

export type MutationLabels = z.infer<typeof mutationLabelsSchema>;
export type MutationLabel = MutationLabels["labels"][number];

export type MutationEvalReport = {
  labeled: number;
  judged: number;
  /** `real` survivors proposed as equivalent. Each one hides a test gap. Must be empty. */
  realProposed: string[];
  /** `equivalent` survivors called a test gap: a person reads a mutant that no test can kill. */
  equivalentsAsGap: string[];
  /** Of the `equivalent` survivors, the share proposed as equivalent: the review work removed. */
  equivalentShareProposed: number | null;
  /** Of the `real` survivors, the share called a test gap. */
  realShareAsGap: number | null;
  /** Share of judged survivors left for a person. */
  reviewRate: number | null;
};

const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** The part of a decision that the metrics read. */
type Verdict = Pick<StoredDecision, "verdict">;

type Judged = { label: MutationLabel; decision: Verdict };

const idsOf = (entries: readonly Judged[]): string[] => entries.map((entry) => entry.label.id);

/** Scores decisions against the labels. `decisions` maps a mutant id to its decision. */
export const evaluateMutation = (
  labels: readonly MutationLabel[],
  decisions: ReadonlyMap<string, Verdict>,
): MutationEvalReport => {
  const judged: Judged[] = labels.flatMap((label) => {
    const decision = decisions.get(label.id);
    return decision === undefined ? [] : [{ label, decision }];
  });
  const real = judged.filter((entry) => entry.label.expected === "real");
  const equivalent = judged.filter((entry) => entry.label.expected === "equivalent");
  const verdict = (entries: readonly Judged[], value: StoredDecision["verdict"]): Judged[] =>
    entries.filter((entry) => entry.decision.verdict === value);
  return {
    labeled: labels.length,
    judged: judged.length,
    realProposed: idsOf(verdict(real, "dismissed")),
    equivalentsAsGap: idsOf(verdict(equivalent, "survivor")),
    equivalentShareProposed: share(verdict(equivalent, "dismissed").length, equivalent.length),
    realShareAsGap: share(verdict(real, "survivor").length, real.length),
    reviewRate: share(verdict(judged, "needs-human-review").length, judged.length),
  };
};
