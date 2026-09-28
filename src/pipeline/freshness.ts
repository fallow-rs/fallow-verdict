import type { LoadedConfig } from "../config/load.ts";
import type { VerdictConfig } from "../config/schema.ts";
import type { AnalysisAdapter, BuiltEvidence } from "../kinds/adapter.ts";
import type { FindingRecord } from "../state/schema.ts";

/** Cache identity excludes credentials, which never belong in persisted state. */
export const engineIdentity = (engine: VerdictConfig["engine"]): string =>
  JSON.stringify([engine.model, engine.baseUrl ?? null]);

/** A cached decision is usable only for the same evidence, questions and engine configuration. */
export const isCurrent = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: AnalysisAdapter<Output, Candidate, Built>,
  record: FindingRecord,
  built: Built,
  loaded: LoadedConfig,
): boolean =>
  record.status === "judged" &&
  record.fingerprint === built.fingerprint &&
  record.questionSet === adapter.questions.version &&
  record.questionHash === adapter.questions.hash(built, loaded) &&
  record.engine === engineIdentity(loaded.config.engine);

/** Keep the audit history while removing a decision that no longer describes current evidence. */
export const invalidate = (record: FindingRecord): FindingRecord => ({
  ...record,
  status: "pending",
  answers: null,
  confirmationAnswers: undefined,
  decision: null,
  evidence: null,
  error: null,
});
