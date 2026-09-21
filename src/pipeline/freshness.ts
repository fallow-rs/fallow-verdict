import type { BuiltPacket } from "../packet/build.ts";
import type { VerdictConfig } from "../config/schema.ts";
import { QUESTION_SET_VERSION } from "../questions/catalog.ts";
import { questionHash, type QuestionProfile } from "../questions/category.ts";
import type { FindingRecord } from "../state/schema.ts";

/** Cache identity excludes credentials, which never belong in persisted state. */
export const engineIdentity = (engine: VerdictConfig["engine"]): string =>
  JSON.stringify([engine.model, engine.baseUrl ?? null]);

/** A cached decision is usable only for the same evidence, questions and engine configuration. */
export const isCurrent = (
  record: FindingRecord,
  built: BuiltPacket,
  engine: string,
  profile: QuestionProfile,
): boolean =>
  record.status === "judged" &&
  record.fingerprint === built.fingerprint &&
  record.questionSet === QUESTION_SET_VERSION &&
  record.questionHash === questionHash(built.packet, profile) &&
  record.engine === engine;

/** Keep the audit history while removing a decision that no longer describes current evidence. */
export const invalidate = (record: FindingRecord): FindingRecord => ({
  ...record,
  status: "pending",
  answers: null,
  decision: null,
  evidence: null,
  error: null,
});
