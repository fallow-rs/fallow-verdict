import type { LoadedConfig } from "../config/load.ts";
import type { Answer, Question } from "../engine/types.ts";
import type { FindingRecord, StoredDecision } from "../state/schema.ts";
import type { Store } from "../state/store.ts";
import type { VerdictError } from "../util/errors.ts";
import type { Result } from "../util/result.ts";
import type { AnalysisKind } from "./names.ts";

export type ScanScope = {
  changedSince?: string | undefined;
  paths?: readonly string[] | undefined;
};

/** The fields of a finding record that come from the candidate itself. */
export type CandidateIdentity = Pick<
  FindingRecord,
  "finding_id" | "path" | "line" | "col" | "category" | "severity"
>;

/** The part of a built packet that the shared pipeline reads. */
export type BuiltEvidence = {
  /** Content hash: a changed fingerprint means the evidence changed and the verdict is stale. */
  fingerprint: string;
  stateTokens: number;
  /** The engine `state`. */
  packet: unknown;
  truncated: boolean;
};

/**
 * Everything that is specific to one Fallow analysis. The shared pipeline handles state,
 * staleness, budgets, retries and reports; an adapter supplies the six parts below.
 */
export type AnalysisAdapter<Output, Candidate, Built extends BuiltEvidence> = {
  kind: AnalysisKind;
  /** Run the Fallow command, validate its schema version, and return candidates. */
  scan: {
    run: (loaded: LoadedConfig, scope: ScanScope) => Promise<Result<Output, VerdictError>>;
    /** Validate stored output from `candidates.json`. */
    parse: (value: unknown) => Result<Output, VerdictError>;
    candidates: (output: Output) => readonly Candidate[];
  };
  /** Give each candidate a stable, unique id and the record fields it owns. */
  identity: (candidate: Candidate) => CandidateIdentity;
  /** Build the evidence packet and its fingerprint. */
  packet: {
    build: (candidate: Candidate, output: Output, loaded: LoadedConfig) => Promise<Built>;
    summary: (built: Built) => NonNullable<FindingRecord["evidence"]>;
  };
  /** The question catalog and its version. */
  questions: {
    version: string;
    for: (built: Built, loaded: LoadedConfig) => Record<string, Question>;
    /** Hash of the actual question content, so an unversioned wording change is stale too. */
    hash: (built: Built, loaded: LoadedConfig) => string;
  };
  /** A pure function from answers to a decision, with a named rule. */
  policy: (answers: Record<string, Answer>, built: Built, loaded: LoadedConfig) => StoredDecision;
  /** Write the verdict contract and run the Fallow join command, if any. */
  export: {
    verdicts: (records: readonly FindingRecord[], candidateIds: ReadonlySet<string>) => unknown;
    validate:
      | ((loaded: LoadedConfig, store: Store) => Promise<Result<unknown, VerdictError>>)
      | null;
  };
};
