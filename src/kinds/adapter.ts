import type { LoadedConfig } from "../config/load.ts";
import type { Answer, Question } from "../engine/types.ts";
import type { KindPresentation } from "../report/render.ts";
import type { FindingRecord, Location, StoredDecision } from "../state/schema.ts";
import type { Store } from "../state/store.ts";
import type { VerdictError } from "../util/errors.ts";
import type { Result } from "../util/result.ts";
import type { KindName } from "./names.ts";

export type ScanScope = {
  changedSince?: string | undefined;
  paths?: readonly string[] | undefined;
};

/** The fields of a finding record that come from the candidate itself. */
export type CandidateIdentity = Pick<FindingRecord, "finding_id" | "category" | "severity"> & {
  /** Every location of the candidate, primary first. A similar-code pair has two. */
  locations: readonly [Location, ...Location[]];
};

/** Kind-owned evidence summary. The pipeline reads only `truncated`. */
export type EvidenceSummary = NonNullable<FindingRecord["evidence"]>;

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
 * staleness, budgets, retries and reports; an adapter supplies the parts below.
 */
export type AnalysisAdapter<Output, Candidate, Built extends BuiltEvidence> = {
  kind: KindName;
  /** Run the Fallow command, validate its schema version, and return candidates. */
  scan: {
    run: (loaded: LoadedConfig, scope: ScanScope) => Promise<Result<Output, VerdictError>>;
    /** Validate stored output from `candidates.json`. */
    parse: (value: unknown) => Result<Output, VerdictError>;
    candidates: (output: Output) => readonly Candidate[];
  };
  /** Give each candidate a stable, unique id and the record fields it owns. */
  identity: (candidate: Candidate) => CandidateIdentity;
  /**
   * A key that identifies the candidate without the parts of its location that an edit moves.
   * `check` uses it to find a stored candidate again after an edit changed its id.
   */
  match: (candidate: Candidate) => string;
  /** Budget and report order: a lower value comes first, so a cap spends on what matters most. */
  priority: (record: FindingRecord) => number;
  /** Build the evidence packet and its fingerprint. */
  packet: {
    build: (candidate: Candidate, output: Output, loaded: LoadedConfig) => Promise<Built>;
    summary: (built: Built) => EvidenceSummary;
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
  /** Kind-specific words and evidence lines for the terminal and Markdown reports. */
  report: KindPresentation;
  /** Options that only some kinds support. An unsupported option is a usage error. */
  supports: {
    /** `--question-profile`. */
    questionProfile: boolean;
    /** `eval` with a `fallow-verdict-labels/v1` file. */
    eval: boolean;
  };
  /** Write the verdict contract and run the Fallow join command, if any. */
  export: {
    verdicts: (records: readonly FindingRecord[], candidateIds: ReadonlySet<string>) => unknown;
    validate:
      | ((loaded: LoadedConfig, store: Store) => Promise<Result<unknown, VerdictError>>)
      | null;
  };
};
