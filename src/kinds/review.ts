import { reviewPresentation, reviewPriority } from "../report/review.ts";
import { toReviewVerdicts } from "../review/export.ts";
import { buildReviewPacket, type BuiltReview } from "../review/packet.ts";
import { decideReview } from "../review/policy.ts";
import {
  REVIEW_QUESTION_SET_VERSION,
  reviewQuestionHash,
  reviewQuestions,
} from "../review/questions.ts";
import {
  parseReviewOutput,
  runReviewScan,
  type ReviewOutput,
  type ReviewUnit,
} from "../review/units.ts";
import type { AnalysisAdapter, CandidateIdentity, MatchKeys } from "./adapter.ts";

/** The strongest reason that put the unit in scope. See `REVIEW_CATEGORIES`. */
const categoryOf = (unit: ReviewUnit): string => {
  if (unit.hotspot !== null) return `hotspot-${unit.hotspot}`;
  return unit.selected.includes("changed") ? "changed" : "path";
};

const identity = (unit: ReviewUnit): CandidateIdentity => ({
  finding_id: unit.finding_id,
  // Fallow gives a 1-based column; records store a zero-based column.
  locations: [{ path: unit.path, line: unit.line, col: Math.max(0, unit.col - 1) }],
  category: categoryOf(unit),
  // The health severity scale is not the security severity scale, so it goes in `category`.
  severity: null,
});

/**
 * An edit gives a unit a new id, because the id holds the source hash. The main key is the path
 * and the function name, so `check` finds the edited function again. The rules make a function
 * with the same path and name, or with the same source in another place, block `resolved`.
 */
const match = (unit: ReviewUnit): MatchKeys => ({
  key: JSON.stringify([unit.path, unit.name]),
  rules: [
    JSON.stringify(["function", unit.path, unit.name]),
    JSON.stringify(["source", unit.source_hash]),
  ],
});

/** Functions that Fallow selects as risky, reviewed for bugs and project rules. Advisory. */
export const reviewAdapter: AnalysisAdapter<ReviewOutput, ReviewUnit, BuiltReview> = {
  kind: "review",
  scan: {
    run: runReviewScan,
    parse: parseReviewOutput,
    candidates: (output) => output.units,
  },
  identity,
  match,
  priority: reviewPriority,
  packet: {
    build: (unit, _output, loaded) =>
      buildReviewPacket(unit, loaded.root, loaded.config.packet.maxStateTokens),
    summary: (built) => ({
      truncated: built.truncated,
      sourceChanged: built.sourceChanged,
      omitted: built.packet.omitted,
      hasImports: built.packet.imports !== null,
      hasLeadingComment: built.packet.leading_comment !== null,
    }),
  },
  questions: {
    version: REVIEW_QUESTION_SET_VERSION,
    for: (built, loaded) => reviewQuestions(built, loaded.config.review),
    hash: (built, loaded) => reviewQuestionHash(built, loaded.config.review),
  },
  policy: (answers, built, loaded) => decideReview(answers, built, loaded.config.review),
  confirmDismissals: (loaded) => loaded.config.review.confirmDismissals,
  failOn: (loaded) => loaded.config.review.failOn,
  report: reviewPresentation,
  supports: { questionProfile: false, eval: false },
  export: { verdicts: toReviewVerdicts, validate: null },
};
