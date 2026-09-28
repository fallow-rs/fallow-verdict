import type { LoadedConfig } from "../config/load.ts";
import type { SecurityOutput } from "../fallow/types.ts";
import type {
  AnalysisAdapter,
  BuiltEvidence,
  CandidateIdentity,
  ScanScope,
} from "../kinds/adapter.ts";
import { securityAdapter } from "../kinds/security.ts";
import { invalidate, isCurrent } from "./freshness.ts";
import { RECORD_SCHEMA, type FindingRecord } from "../state/schema.ts";
import { assertStoreKind, type Store } from "../state/store.ts";
import { ok, type Result } from "../util/result.ts";
import type { VerdictError } from "../util/errors.ts";

export type ScanSummary = {
  candidates: number;
  added: number;
  resolved: number;
  reopened: number;
};

export type ScanOptions = ScanScope;

type LocationFields = Pick<FindingRecord, "path" | "line" | "col" | "locations">;

/** The primary location keeps the record fields; `locations` is stored only for more than one. */
const locationFields = ({ locations }: CandidateIdentity): LocationFields => {
  const [primary] = locations;
  return {
    path: primary.path,
    line: primary.line,
    col: primary.col,
    ...(locations.length > 1 ? { locations: [...locations] } : {}),
  };
};

const newRecord = (
  kind: FindingRecord["kind"],
  identity: CandidateIdentity,
  now: string,
): FindingRecord => ({
  schema_version: RECORD_SCHEMA,
  kind,
  finding_id: identity.finding_id,
  ...locationFields(identity),
  category: identity.category,
  severity: identity.severity,
  status: "pending",
  firstSeenAt: now,
  lastSeenAt: now,
  fingerprint: null,
  questionSet: null,
  questionHash: null,
  engine: null,
  answers: null,
  decision: null,
  evidence: null,
  usage: null,
  error: null,
  history: [],
});

/**
 * Reconciles stored records with a fresh candidate set. Verdicts survive a rescan;
 * a candidate fallow stopped reporting becomes `resolved` instead of disappearing.
 * A scoped scan only sees part of the project, so it never resolves anything.
 */
export const syncRecordsWith = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: AnalysisAdapter<Output, Candidate, Built>,
  store: Store,
  output: Output,
  scoped: boolean,
  loaded?: LoadedConfig,
): Promise<ScanSummary> => {
  assertStoreKind(store, adapter.kind);
  const now = new Date().toISOString();
  const { records } = await store.readRecords();
  const known = new Map(records.map((record) => [record.finding_id, record]));
  const candidates = adapter.scan.candidates(output);
  const summary: ScanSummary = {
    candidates: candidates.length,
    added: 0,
    resolved: 0,
    reopened: 0,
  };

  for (const candidate of candidates) {
    const identity = adapter.identity(candidate);
    const existing = known.get(identity.finding_id);
    known.delete(identity.finding_id);
    if (existing === undefined) {
      summary.added += 1;
      await store.writeRecord(newRecord(adapter.kind, identity, now));
      continue;
    }
    const reopened = existing.status === "resolved";
    if (reopened) summary.reopened += 1;
    const built = loaded ? await adapter.packet.build(candidate, output, loaded) : null;
    const current =
      built !== null && loaded !== undefined && isCurrent(adapter, existing, built, loaded);
    const { locations: _previous, ...kept } = current ? existing : invalidate(existing);
    await store.writeRecord({
      ...kept,
      ...locationFields(identity),
      severity: identity.severity,
      lastSeenAt: now,
    });
  }

  if (!scoped) {
    for (const gone of known.values()) {
      if (gone.status === "resolved") continue;
      summary.resolved += 1;
      await store.writeRecord({ ...gone, status: "resolved" });
    }
  }
  return summary;
};

export const syncRecords = (
  store: Store,
  output: SecurityOutput,
  scoped: boolean,
  loaded?: LoadedConfig,
): Promise<ScanSummary> => syncRecordsWith(securityAdapter, store, output, scoped, loaded);

export const scanWith = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: AnalysisAdapter<Output, Candidate, Built>,
  loaded: LoadedConfig,
  store: Store,
  options: ScanOptions,
): Promise<Result<ScanSummary, VerdictError>> => {
  assertStoreKind(store, adapter.kind);
  const output = await adapter.scan.run(loaded, options);
  if (!output.ok) return output;

  const scoped = options.changedSince !== undefined || (options.paths?.length ?? 0) > 0;
  await store.writeJson(store.candidatesPath, output.data);
  return ok(await syncRecordsWith(adapter, store, output.data, scoped, loaded));
};

export const scan = (
  loaded: LoadedConfig,
  store: Store,
  options: ScanOptions,
): Promise<Result<ScanSummary, VerdictError>> => scanWith(securityAdapter, loaded, store, options);
