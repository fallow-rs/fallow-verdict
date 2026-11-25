import path from "node:path";

import {
  isCompleteReport,
  mutationCandidates,
  parseMutationTasks,
  runMutationTasks,
  type MutationTask,
  type MutationTasksOutput,
} from "../fallow/mutation.ts";
import { buildMutantPacket, type BuiltMutant } from "../packet/mutation.ts";
import { decideMutation } from "../policy/mutation.ts";
import {
  MUTATION_QUESTION_SET_VERSION,
  MUTATION_QUESTIONS,
  mutationQuestionHash,
} from "../questions/mutation.ts";
import { mutationPresentation, mutationPriority } from "../report/mutation.ts";
import { openStore } from "../state/store.ts";
import { verdictError } from "../util/errors.ts";
import { err } from "../util/result.ts";
import { PROPOSALS_FILE, toMutationProposals } from "../verdicts/mutation.ts";
import type { AnalysisAdapter, MatchKeys } from "./adapter.ts";

const KIND = "mutation";

/** Replay output cache under the state of the kind. */
const REPLAY_CACHE_DIR = "replay";

/**
 * The `mutant_id` stays the same until the enclosing function changes, so it is the main key.
 * The rule is the function: a fresh mutant in the same function can be this mutant after an
 * edit, so `check` does not conclude `resolved`.
 */
const mutationMatch = (task: MutationTask): MatchKeys => ({
  key: JSON.stringify([KIND, task.mutant_id]),
  rules: [JSON.stringify([KIND, "function", task.file, task.function ?? null])],
});

const changeOf = (built: BuiltMutant): string | null => {
  const change = built.packet.mutant.change;
  return change === null ? null : `${change.from} -> ${change.to}`;
};

/** `fallow mutation` survivors, judged per mutant. Proposals go to a file; Fallow is not called with them. */
export const mutationAdapter: AnalysisAdapter<MutationTasksOutput, MutationTask, BuiltMutant> = {
  kind: KIND,
  scan: {
    run: (loaded, scope) => {
      if (scope.changedSince !== undefined)
        return Promise.resolve(
          err(
            verdictError(
              "config_invalid",
              "The mutation kind reads the report of the last `fallow mutation` run, so it has no --changed-since.",
              "Pass --changed-since to `fallow mutation` instead.",
            ),
          ),
        );
      return runMutationTasks({
        root: loaded.root,
        binary: loaded.config.fallow.binary,
        timeoutMs: loaded.config.fallow.timeoutMs,
        paths: scope.paths,
        signal: scope.signal,
      });
    },
    parse: parseMutationTasks,
    candidates: mutationCandidates,
    // A partial report can miss tasks, so it proves no absence.
    complete: isCompleteReport,
    conclusive: isCompleteReport,
  },
  identity: (task) => ({
    finding_id: task.mutant_id,
    // Fallow columns are one-based; a record column is zero-based.
    locations: [{ path: task.file, line: task.line, col: Math.max(0, task.column - 1) }],
    category: task.operator,
    severity: null,
  }),
  match: mutationMatch,
  priority: mutationPriority,
  packet: {
    build: (task, _output, loaded, options) =>
      buildMutantPacket(
        task,
        {
          root: loaded.root,
          binary: loaded.config.fallow.binary,
          timeoutMs: loaded.config.fallow.timeoutMs,
        },
        {
          replay: loaded.config.mutation.replay,
          cacheDir: path.join(openStore(loaded.dataDir, KIND).dataDir, REPLAY_CACHE_DIR),
          readOnly: options?.readOnly ?? false,
        },
      ),
    summary: (built) => ({
      truncated: built.truncated,
      stale: built.evidence.stale,
      function: built.packet.mutant.function,
      change: changeOf(built),
      witness: built.evidence.witness !== null,
      omissions: built.packet.omissions,
    }),
  },
  questions: {
    version: MUTATION_QUESTION_SET_VERSION,
    for: () => MUTATION_QUESTIONS,
    hash: mutationQuestionHash,
  },
  policy: (answers, built, loaded) =>
    decideMutation(answers, built.evidence, {
      ...loaded.config.mutation,
      tamperingMax: loaded.config.policy.tamperingMax,
    }),
  // Stale or cut evidence, and a Fallow witness, decide the verdict before any answer.
  needsEngine: (built) => !built.truncated && built.evidence.witness === null,
  // A proposal can raise the score that a `--min-score` gate reads, so it always needs two calls.
  confirmDismissals: () => true,
  report: mutationPresentation,
  supports: { questionProfile: false, eval: false },
  export: {
    verdicts: (records, candidateIds) => toMutationProposals(records, candidateIds),
    file: (loaded) => path.join(loaded.dataDir, PROPOSALS_FILE),
    notes: () => [
      `Note: proposed equivalents are in ${PROPOSALS_FILE}. fallow-verdict never passes them to Fallow. Copy an entry into your verdict document only after you read the mutant.`,
    ],
    validate: null,
  },
};
