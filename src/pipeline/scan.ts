import type { LoadedConfig } from "../config/load.ts";
import { runSecurityScan } from "../fallow/run.ts";
import type { SecurityFinding, SecurityOutput } from "../fallow/types.ts";
import { buildPacket } from "../packet/build.ts";
import { engineIdentity, invalidate, isCurrent } from "./freshness.ts";
import { RECORD_SCHEMA, type FindingRecord } from "../state/schema.ts";
import type { Store } from "../state/store.ts";
import { ok, type Result } from "../util/result.ts";
import type { VerdictError } from "../util/errors.ts";

export type ScanSummary = {
  candidates: number;
  added: number;
  resolved: number;
  reopened: number;
};

export type ScanOptions = {
  changedSince?: string | undefined;
  paths?: readonly string[] | undefined;
};

const newRecord = (finding: SecurityFinding, now: string): FindingRecord => ({
  schema_version: RECORD_SCHEMA,
  finding_id: finding.finding_id,
  path: finding.path,
  line: finding.line,
  category: finding.category ?? null,
  severity: finding.severity,
  status: "pending",
  firstSeenAt: now,
  lastSeenAt: now,
  fingerprint: null,
  questionSet: null,
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
export const syncRecords = async (
  store: Store,
  output: SecurityOutput,
  scoped: boolean,
  loaded?: LoadedConfig,
): Promise<ScanSummary> => {
  const now = new Date().toISOString();
  const { records } = await store.readRecords();
  const known = new Map(records.map((record) => [record.finding_id, record]));
  const summary: ScanSummary = {
    candidates: output.security_findings.length,
    added: 0,
    resolved: 0,
    reopened: 0,
  };

  for (const finding of output.security_findings) {
    const existing = known.get(finding.finding_id);
    known.delete(finding.finding_id);
    if (existing === undefined) {
      summary.added += 1;
      await store.writeRecord(newRecord(finding, now));
      continue;
    }
    const reopened = existing.status === "resolved";
    if (reopened) summary.reopened += 1;
    const built = loaded
      ? await buildPacket(finding, output, { root: loaded.root, ...loaded.config.packet })
      : null;
    const current =
      built !== null &&
      loaded !== undefined &&
      isCurrent(existing, built, engineIdentity(loaded.config.engine));
    await store.writeRecord({
      ...(current ? existing : invalidate(existing)),
      path: finding.path,
      line: finding.line,
      severity: finding.severity,
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

export const scan = async (
  loaded: LoadedConfig,
  store: Store,
  options: ScanOptions,
): Promise<Result<ScanSummary, VerdictError>> => {
  const output = await runSecurityScan({
    root: loaded.root,
    binary: loaded.config.fallow.binary,
    timeoutMs: loaded.config.fallow.timeoutMs,
    changedSince: options.changedSince,
    paths: options.paths,
  });
  if (!output.ok) return output;

  const scoped = options.changedSince !== undefined || (options.paths?.length ?? 0) > 0;
  await store.writeJson(store.candidatesPath, output.data);
  return ok(await syncRecords(store, output.data, scoped, loaded));
};
