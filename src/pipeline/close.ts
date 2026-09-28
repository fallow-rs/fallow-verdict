import type { LoadedConfig } from "../config/load.ts";
import type { AnalysisAdapter, BuiltEvidence } from "../kinds/adapter.ts";
import type { FindingRecord } from "../state/schema.ts";
import { checkStoreKind, type Store } from "../state/store.ts";
import { verdictError, type VerdictError } from "../util/errors.ts";
import { err, ok, type Result } from "../util/result.ts";

type Adapter<Output, Candidate, Built extends BuiltEvidence> = AnalysisAdapter<
  Output,
  Candidate,
  Built
>;

/** Id recorded in history for a judgment by a person. */
const CLOSE_RUN_ID = "close";
export const CLOSE_RULE = "closed-by-person";

/** The stored candidates of the last scan, by finding id. */
const storedCandidates = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  store: Store,
): Promise<Result<{ output: Output; byId: Map<string, Candidate> }, VerdictError>> => {
  const raw = await store.readJson(store.candidatesPath);
  if (!raw.ok) return raw;
  const output = adapter.scan.parse(raw.data);
  if (!output.ok) return output;
  return ok({
    output: output.data,
    byId: new Map(
      adapter.scan
        .candidates(output.data)
        .map((candidate) => [adapter.identity(candidate).finding_id, candidate]),
    ),
  });
};

/**
 * Records a judgment by a person. The finding stays closed while the evidence fingerprint of
 * the last scan stays the same. A closed finding keeps its decision and its history.
 */
export const closeWith = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  loaded: LoadedConfig,
  store: Store,
  findingId: string,
  reason: string,
): Promise<Result<FindingRecord, VerdictError>> => {
  const checked = checkStoreKind(store, adapter.kind);
  if (!checked.ok) return checked;
  const stored = await storedCandidates(adapter, store);
  if (!stored.ok) return stored;
  const candidate = stored.data.byId.get(findingId);
  if (candidate === undefined)
    return err(
      verdictError(
        "config_invalid",
        `The last scan has no finding \`${findingId}\`.`,
        "Run `fallow-verdict scan`, then use a finding id from its results.",
      ),
    );
  const { records, corrupt } = await store.readRecords();
  const record = records.find((entry) => entry.finding_id === findingId);
  if (record === undefined || corrupt.length > 0)
    return err(
      verdictError(
        "state_corrupt",
        "Missing or unreadable finding records. Run scan to reconstruct current candidates.",
      ),
    );
  if (record.status === "resolved")
    return err(
      verdictError(
        "config_invalid",
        `Fallow no longer reports \`${findingId}\`. It needs no close.`,
      ),
    );
  const built = await adapter.packet.build(candidate, stored.data.output, loaded);
  const at = new Date().toISOString();
  const closed: FindingRecord = {
    ...record,
    closed: { at, reason, fingerprint: built.fingerprint },
    history: [
      ...record.history,
      {
        at,
        runId: CLOSE_RUN_ID,
        verdict: "dismissed",
        rule: CLOSE_RULE,
        confidence: 1,
        fingerprint: built.fingerprint,
        model: "none",
        by: "person",
        reason,
      },
    ],
  };
  await store.writeRecord(closed);
  return ok(closed);
};

/**
 * Removes each closure whose evidence fingerprint changed, so the finding shows up again.
 * The history keeps the judgment. Returns the number of reopened findings.
 */
export const reopenChangedClosures = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  loaded: LoadedConfig,
  store: Store,
): Promise<Result<number, VerdictError>> => {
  const checked = checkStoreKind(store, adapter.kind);
  if (!checked.ok) return checked;
  const { records } = await store.readRecords();
  const closedRecords = records.filter((record) => record.closed !== undefined);
  if (closedRecords.length === 0) return ok(0);
  const stored = await storedCandidates(adapter, store);
  if (!stored.ok) return stored;
  let reopened = 0;
  for (const record of closedRecords) {
    const candidate = stored.data.byId.get(record.finding_id);
    // A finding that Fallow no longer reports is resolved; its closure does not matter now.
    if (candidate === undefined) continue;
    const built = await adapter.packet.build(candidate, stored.data.output, loaded);
    if (built.fingerprint === record.closed?.fingerprint) continue;
    const { closed: _closed, ...open } = record;
    await store.writeRecord(open);
    reopened += 1;
  }
  return ok(reopened);
};
