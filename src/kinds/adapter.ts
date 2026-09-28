import type { LoadedConfig } from "../config/load.ts";
import type { FailOn } from "../config/schema.ts";
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
  /** Stops the Fallow run, for example on an interruption. */
  signal?: AbortSignal | undefined;
  /**
   * List every candidate that exists in these files, ignoring the selection and the cap of the
   * kind. Only `check` sets it, to its target files. A kind that always lists every candidate
   * can ignore it.
   */
  exhaustiveIn?: readonly string[] | undefined;
};

/** The fields of a finding record that come from the candidate itself. */
export type CandidateIdentity = Pick<FindingRecord, "finding_id" | "category" | "severity"> & {
  /** Every location of the candidate, primary first. A similar-code pair has two. */
  locations: readonly [Location, ...Location[]];
};

/** Keys that `check` uses to find a stored candidate again after an edit. */
export type MatchKeys = {
  /** Identifies the candidate without the parts of its location that an edit moves. */
  key: string;
  /**
   * What "the same rule" means for the kind. A fresh candidate that shares one of these keys can
   * be the stored candidate after any edit, so `check` does not conclude `resolved`.
   */
  rules: readonly string[];
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
    /**
     * True when the output proves which candidates are absent in these files. `check` gives
     * `resolved` only for conclusive output. Absent: true.
     */
    conclusive?: (output: Output, paths: readonly string[]) => boolean;
  };
  /** Give each candidate a stable, unique id and the record fields it owns. */
  identity: (candidate: Candidate) => CandidateIdentity;
  /** Keys that find a stored candidate again after an edit changed its id. See `check`. */
  match: (candidate: Candidate) => MatchKeys;
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
  /**
   * Whether a dismissal needs a second call that agrees. Absent: `policy.confirmDismissals`.
   * A kind sets this only when a dismissal of its kind hides nothing that Fallow reports.
   */
  confirmDismissals?: (loaded: LoadedConfig) => boolean;
  /** The `failOn` level when `--fail-on` is absent. Absent: the top-level `failOn`. */
  failOn?: (loaded: LoadedConfig) => FailOn;
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
