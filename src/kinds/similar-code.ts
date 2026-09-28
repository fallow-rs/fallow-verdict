import path from "node:path";

import {
  isCompleteDiscovery,
  parseSimilarCodeOutput,
  runSimilarCodeReview,
  runSimilarCodeScan,
  type SimilarCodeCandidate,
  type SimilarCodeOutput,
} from "../fallow/similar-code.ts";
import { buildPairPacket, type BuiltPair } from "../packet/similar-code.ts";
import { decideSimilarCode } from "../policy/similar-code.ts";
import {
  SIMILAR_CODE_QUESTION_SET_VERSION,
  SIMILAR_CODE_QUESTIONS,
  similarCodeQuestionHash,
} from "../questions/similar-code.ts";
import { similarCodePresentation, similarCodePriority } from "../report/similar-code.ts";
import type { Location } from "../state/schema.ts";
import { openStore } from "../state/store.ts";
import { toSimilarCodeVerdicts } from "../verdicts/similar-code.ts";
import type { AnalysisAdapter, MatchKeys } from "./adapter.ts";

const KIND = "similar-code";

/** Inspect output cache under the state of the kind. A new scan clears it. */
const INSPECT_CACHE_DIR = "inspect";

/** Fallow columns are one-based; a record column is zero-based. */
const locationOf = (side: SimilarCodeCandidate["left"]): Location => ({
  path: side.path,
  line: side.start_line,
  col: Math.max(0, side.start_column - 1),
});

/**
 * What "the same rule" means for a pair: the functions, by name only. A fresh pair with one of
 * these functions can be this pair after an edit, a move or a file rename, so `check` does not
 * conclude `resolved`. The shared rule also counts any fresh pair in a file of this pair.
 */
export const similarCodeRules = (candidate: SimilarCodeCandidate): string[] =>
  [...new Set([candidate.left.name, candidate.right.name])].map((name) =>
    JSON.stringify([KIND, "function", name]),
  );

/**
 * `candidate_id` holds the snapshot. `review_key` is Fallow's content-stable key for a pair
 * whose lines moved, so it is the main key.
 */
const similarCodeMatch = (candidate: SimilarCodeCandidate): MatchKeys => ({
  key: JSON.stringify([KIND, candidate.review_key]),
  rules: similarCodeRules(candidate),
});

/** `fallow similar-code` pairs, judged per pair and joined by `fallow similar-code review`. */
export const similarCodeAdapter: AnalysisAdapter<
  SimilarCodeOutput,
  SimilarCodeCandidate,
  BuiltPair
> = {
  kind: KIND,
  scan: {
    run: (loaded, scope) =>
      runSimilarCodeScan({
        root: loaded.root,
        binary: loaded.config.fallow.binary,
        timeoutMs: loaded.config.fallow.timeoutMs,
        changedSince: scope.changedSince,
        paths: scope.paths,
        signal: scope.signal,
      }),
    parse: parseSimilarCodeOutput,
    candidates: (output) => output.candidates,
    complete: isCompleteDiscovery,
    // An incomplete discovery proves no absence, in any file. A complete one proves it everywhere.
    conclusive: isCompleteDiscovery,
  },
  identity: (candidate) => ({
    finding_id: candidate.candidate_id,
    locations: [locationOf(candidate.left), locationOf(candidate.right)],
    category: candidate.similarity_band,
    severity: null,
  }),
  match: similarCodeMatch,
  priority: similarCodePriority,
  packet: {
    build: (candidate, output, loaded) => {
      const store = openStore(loaded.dataDir, KIND);
      return buildPairPacket(
        candidate,
        output,
        {
          root: loaded.root,
          binary: loaded.config.fallow.binary,
          timeoutMs: loaded.config.fallow.timeoutMs,
        },
        { dir: path.join(store.dataDir, INSPECT_CACHE_DIR), snapshotPath: store.candidatesPath },
      );
    },
    summary: (built) => ({
      truncated: built.truncated,
      reviewKey: built.reviewKey,
      leftName: built.packet.candidate.left.name,
      rightName: built.packet.candidate.right.name,
      windows: [built.packet.evidence?.left, built.packet.evidence?.right].filter(
        (side) => typeof side?.source_window === "string",
      ).length,
      omissions: built.packet.omissions,
    }),
  },
  questions: {
    version: SIMILAR_CODE_QUESTION_SET_VERSION,
    for: () => SIMILAR_CODE_QUESTIONS,
    hash: similarCodeQuestionHash,
  },
  confirmDismissals: (loaded) => loaded.config.policy.confirmDismissals,
  confirmSurvivors: (loaded) => loaded.config.similarCode.confirmSurvivors,
  policy: (answers, built, loaded) =>
    decideSimilarCode(answers, built.truncated, loaded.config.similarCode.policy),
  report: similarCodePresentation,
  supports: { questionProfile: false, eval: false },
  export: {
    verdicts: toSimilarCodeVerdicts,
    validate: (loaded, store) =>
      runSimilarCodeReview({
        root: loaded.root,
        binary: loaded.config.fallow.binary,
        timeoutMs: loaded.config.fallow.timeoutMs,
        candidatesPath: store.candidatesPath,
        verdictsPath: store.verdictsPath,
      }),
  },
};
