import { z } from "zod";

import type { SimilarCodeCandidate, SimilarCodeOutput } from "../fallow/similar-code.ts";
import type { StoredDecision } from "../state/schema.ts";

export const PAIR_LABELS_SCHEMA = "fallow-verdict-pair-labels/v1";

const functionRef = z.string().regex(/^[^#]+#[^#]+$/, "Use `<path>#<function name>`.");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Ground truth for a pair. Labels bind to reviewed function source, not to names alone. */
export const pairLabelsSchema = z.object({
  schema_version: z.literal(PAIR_LABELS_SCHEMA),
  labels: z
    .array(
      z.object({
        id: z.string().min(1),
        left: functionRef,
        right: functionRef,
        leftSha256: sha256,
        rightSha256: sha256,
        /**
         * `equivalent`: one function can replace the other. `near-miss`: the functions look the
         * same but differ for some input. `unrelated`: the functions only share words or shape.
         */
        expected: z.enum(["equivalent", "near-miss", "unrelated"]),
        rationale: z.string().min(1),
      }),
    )
    .min(1),
});

export type PairLabels = z.infer<typeof pairLabelsSchema>;
export type PairLabel = PairLabels["labels"][number];

const refOf = (side: SimilarCodeCandidate["left"]): string => `${side.path}#${side.name}`;

/**
 * Binds each label to its candidate. Throws when a labeled pair is missing or when the reviewed
 * source changed, so a relabel caused by fixture drift never reaches the metrics.
 */
export const bindPairLabels = (
  output: SimilarCodeOutput,
  labels: PairLabels,
): Map<string, PairLabel> => {
  const bound = new Map<string, PairLabel>();
  for (const label of labels.labels) {
    const matches = output.candidates.filter((candidate) => {
      const refs = new Set([refOf(candidate.left), refOf(candidate.right)]);
      return refs.has(label.left) && refs.has(label.right);
    });
    const [candidate] = matches;
    if (candidate === undefined || matches.length > 1)
      throw new Error(`Missing or ambiguous candidate for the pair label ${label.id}.`);
    const shas = new Map([
      [refOf(candidate.left), candidate.left.source_sha256],
      [refOf(candidate.right), candidate.right.source_sha256],
    ]);
    if (shas.get(label.left) !== label.leftSha256 || shas.get(label.right) !== label.rightSha256)
      throw new Error(`Reviewed source changed for the pair label ${label.id}.`);
    bound.set(candidate.candidate_id, label);
  }
  return bound;
};

export type PairEvalReport = {
  labeled: number;
  judged: number;
  /** Near misses marked refactor-safe. Each one is a merge that changes behavior. Must be empty. */
  nearMissesMarkedSafe: string[];
  /** Pairs that are not equivalent but got `survivor`. Must be empty. */
  wrongSurvivors: string[];
  /** Equivalent pairs that were dismissed: a lost merge, not a behavior change. */
  equivalentsDismissed: string[];
  /** Of the equivalent pairs, the share called survivor. */
  survivorRecall: number | null;
  /** Of the unrelated pairs, the share dismissed: the review work removed. */
  unrelatedDismissed: number | null;
  /** Share of judged pairs left for a person. */
  reviewRate: number | null;
};

const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

type Judged = { label: PairLabel; decision: StoredDecision };

const idsOf = (entries: readonly Judged[]): string[] => entries.map((entry) => entry.label.id);

/** Scores decisions against the pair labels. `decisions` maps a candidate id to its decision. */
export const evaluatePairs = (
  labels: ReadonlyMap<string, PairLabel>,
  decisions: ReadonlyMap<string, StoredDecision>,
): PairEvalReport => {
  const judged: Judged[] = [...labels].flatMap(([id, label]) => {
    const decision = decisions.get(id);
    return decision === undefined ? [] : [{ label, decision }];
  });
  const of = (expected: PairLabel["expected"]): Judged[] =>
    judged.filter((entry) => entry.label.expected === expected);
  const equivalents = of("equivalent");
  const unrelated = of("unrelated");
  return {
    labeled: labels.size,
    judged: judged.length,
    nearMissesMarkedSafe: idsOf(
      of("near-miss").filter((entry) => entry.decision.kindData?.["refactor_safe"] === true),
    ),
    wrongSurvivors: idsOf(
      judged.filter(
        (entry) => entry.label.expected !== "equivalent" && entry.decision.verdict === "survivor",
      ),
    ),
    equivalentsDismissed: idsOf(
      equivalents.filter((entry) => entry.decision.verdict === "dismissed"),
    ),
    survivorRecall: share(
      equivalents.filter((entry) => entry.decision.verdict === "survivor").length,
      equivalents.length,
    ),
    unrelatedDismissed: share(
      unrelated.filter((entry) => entry.decision.verdict === "dismissed").length,
      unrelated.length,
    ),
    reviewRate: share(
      judged.filter((entry) => entry.decision.verdict === "needs-human-review").length,
      judged.length,
    ),
  };
};
