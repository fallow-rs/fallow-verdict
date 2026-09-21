import type { LoadedConfig } from "../config/load.ts";
import type { DecisionEngine } from "../engine/types.ts";
import { parseSecurityOutput } from "../fallow/run.ts";
import type { SecurityFinding, SecurityOutput } from "../fallow/types.ts";
import { buildPacket, type BuiltPacket } from "../packet/build.ts";
import { decide } from "../policy/decide.ts";
import { QUESTION_SET_VERSION, QUESTIONS } from "../questions/catalog.ts";
import { RUN_SCHEMA, type FindingRecord, type RunRecord } from "../state/schema.ts";
import { newRunId, type Store } from "../state/store.ts";
import { err, ok, type Result } from "../util/result.ts";
import { verdictError, type VerdictError } from "../util/errors.ts";
import { estimateTokens, tokensToUsd } from "../util/tokens.ts";
import { engineIdentity, invalidate, isCurrent } from "./freshness.ts";

export type JudgeOptions = {
  /** Judge again even when the evidence and question set are unchanged. */
  rejudge: boolean;
  /** Build packets and estimate cost without calling the engine. */
  dryRun: boolean;
  limit?: number | undefined;
  maxCostUsd?: number | undefined;
  maxDurationMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((event: JudgeProgress) => void) | undefined;
};

export type JudgeProgress =
  | {
      type: "plan";
      toJudge: number;
      upToDate: number;
      estimatedTokens: number;
      estimatedUsd: number;
    }
  | { type: "judged"; record: FindingRecord; done: number; total: number }
  | { type: "failed"; findingId: string; error: VerdictError; done: number; total: number };

export type JudgeSummary = {
  runId: string;
  outcome: RunRecord["outcome"];
  judged: number;
  upToDate: number;
  errors: number;
  pending: number;
  inputTokens: number;
  costUsd: number;
  estimatedUsd: number;
  /** First engine error to report when a batch cannot complete successfully. */
  fatal: VerdictError | null;
};

type Job = { record: FindingRecord; built: BuiltPacket };

/** Id recorded in history when a verdict changed because the policy did, not the evidence. */
const POLICY_RUN_ID = "policy";

const QUESTION_TOKENS = estimateTokens(QUESTIONS);

const planJobs = async (
  loaded: LoadedConfig,
  output: SecurityOutput,
  records: readonly FindingRecord[],
  rejudge: boolean,
): Promise<{ jobs: Job[]; current: Job[] }> => {
  const findings = new Map<string, SecurityFinding>(
    output.security_findings.map((finding) => [finding.finding_id, finding]),
  );
  const jobs: Job[] = [];
  const current: Job[] = [];
  for (const record of records) {
    const finding = findings.get(record.finding_id);
    if (finding === undefined || record.status === "resolved") continue;
    const built = await buildPacket(finding, output, {
      root: loaded.root,
      ...loaded.config.packet,
    });
    if (!rejudge && isCurrent(record, built, engineIdentity(loaded.config.engine)))
      current.push({ record, built });
    else jobs.push({ record, built });
  }
  // Highest severity first, so a budget cap spends on what matters most.
  const rank = { high: 0, medium: 1, low: 2 } as const;
  jobs.sort((a, b) => rank[a.record.severity] - rank[b.record.severity]);
  return { jobs, current };
};

const judgeOne = async (
  job: Job,
  engine: DecisionEngine,
  loaded: LoadedConfig,
  runId: string,
  signal: AbortSignal | undefined,
): Promise<Result<FindingRecord, VerdictError>> => {
  if (job.built.stateTokens > loaded.config.packet.maxStateTokens) {
    return err(
      verdictError(
        "engine_rejected",
        "Evidence exceeds the configured token budget even after trimming.",
      ),
    );
  }
  const response = await engine.evaluate({ state: job.built.packet, questions: QUESTIONS, signal });
  if (!response.ok) return response;

  const decision = decide(response.data.answers, job.built, loaded.config.policy);
  const now = new Date().toISOString();
  return ok({
    ...job.record,
    status: "judged",
    fingerprint: job.built.fingerprint,
    questionSet: QUESTION_SET_VERSION,
    engine: engineIdentity(loaded.config.engine),
    answers: response.data.answers,
    decision,
    evidence: {
      truncated: job.built.truncated,
      windows: job.built.packet.source_windows.length,
      hasSource: job.built.packet.source_windows.some((window) => window.roles.includes("source")),
      hasTrace: job.built.packet.trace.length > 0,
    },
    usage: {
      inputTokens: response.data.inputTokens,
      costUsd: tokensToUsd(response.data.inputTokens),
      latencyMs: response.data.latencyMs,
    },
    error: null,
    history: [
      ...job.record.history,
      {
        at: now,
        runId,
        verdict: decision.verdict,
        rule: decision.rule,
        confidence: decision.confidence,
        fingerprint: job.built.fingerprint,
        model: response.data.model,
      },
    ],
  });
};

/**
 * Thresholds are config, answers are data. When only the policy changed, the stored
 * answers are mapped again locally: no engine call, no cost.
 */
const applyPolicy = async (
  jobs: readonly Job[],
  loaded: LoadedConfig,
  store: Store,
): Promise<void> => {
  for (const { record, built } of jobs) {
    if (record.answers === null || record.decision === null) continue;
    const decision = decide(record.answers, built, loaded.config.policy);
    if (decision.verdict === record.decision.verdict && decision.rule === record.decision.rule) {
      continue;
    }
    await store.writeRecord({
      ...record,
      decision,
      history: [
        ...record.history,
        {
          at: new Date().toISOString(),
          runId: POLICY_RUN_ID,
          verdict: decision.verdict,
          rule: decision.rule,
          confidence: decision.confidence,
          fingerprint: built.fingerprint,
          model: record.history.at(-1)?.model ?? "unknown",
        },
      ],
    });
  }
};

const invalidateJobs = async (jobs: Job[], loaded: LoadedConfig, store: Store): Promise<void> => {
  for (const job of jobs) {
    if (isCurrent(job.record, job.built, engineIdentity(loaded.config.engine))) continue;
    job.record = invalidate(job.record);
    await store.writeRecord(job.record);
  }
};

/** Revalidate stored decisions before reporting or evaluating, without any engine calls. */
export const refreshVerdicts = async (
  loaded: LoadedConfig,
  store: Store,
): Promise<Result<void, VerdictError>> => {
  const raw = await store.readJson(store.candidatesPath);
  if (!raw.ok) return raw;
  const output = parseSecurityOutput(raw.data);
  if (!output.ok) return output;
  const { records, corrupt } = await store.readRecords();
  const recorded = new Set(
    records.filter((record) => record.status !== "resolved").map((record) => record.finding_id),
  );
  if (
    corrupt.length > 0 ||
    output.data.security_findings.some((finding) => !recorded.has(finding.finding_id))
  )
    return err(
      verdictError(
        "state_corrupt",
        "Missing or unreadable finding records. Run scan to reconstruct current candidates.",
      ),
    );
  const plan = await planJobs(loaded, output.data, records, false);
  await invalidateJobs(plan.jobs, loaded, store);
  await applyPolicy(plan.current, loaded, store);
  return ok(undefined);
};

export const judge = async (
  loaded: LoadedConfig,
  store: Store,
  engine: DecisionEngine,
  options: JudgeOptions,
): Promise<Result<JudgeSummary, VerdictError>> => {
  const raw = await store.readJson(store.candidatesPath);
  if (!raw.ok) return raw;
  const output = parseSecurityOutput(raw.data);
  if (!output.ok) return output;

  const { records, corrupt } = await store.readRecords();
  const recorded = new Set(
    records.filter((record) => record.status !== "resolved").map((record) => record.finding_id),
  );
  if (
    corrupt.length > 0 ||
    output.data.security_findings.some((finding) => !recorded.has(finding.finding_id))
  )
    return err(
      verdictError(
        "state_corrupt",
        "Missing or unreadable finding records. Run scan to reconstruct current candidates.",
      ),
    );
  const plan = await planJobs(loaded, output.data, records, options.rejudge);
  const jobs = options.limit === undefined ? plan.jobs : plan.jobs.slice(0, options.limit);
  const estimatedTokens = jobs.reduce(
    (sum, job) => sum + job.built.stateTokens + QUESTION_TOKENS,
    0,
  );
  const estimatedUsd = tokensToUsd(estimatedTokens);
  options.onProgress?.({
    type: "plan",
    toJudge: jobs.length,
    upToDate: plan.current.length,
    estimatedTokens,
    estimatedUsd,
  });

  const runId = newRunId();
  const summary: JudgeSummary = {
    runId,
    outcome: "done",
    judged: 0,
    upToDate: plan.current.length,
    errors: 0,
    pending: plan.jobs.length,
    inputTokens: 0,
    costUsd: 0,
    estimatedUsd,
    fatal: null,
  };
  if (options.dryRun) return ok(summary);
  await invalidateJobs(plan.jobs, loaded, store);
  await applyPolicy(plan.current, loaded, store);
  if (jobs.length === 0) return ok(summary);

  const run: RunRecord = {
    schema_version: RUN_SCHEMA,
    runId,
    command: "judge",
    startedAt: new Date().toISOString(),
    completedAt: null,
    outcome: "running",
    engine: engine.id,
    stats: { judged: 0, skipped: plan.current.length, errors: 0, inputTokens: 0, costUsd: 0 },
  };
  await store.writeRun(run);

  const deadline = options.maxDurationMs === undefined ? null : Date.now() + options.maxDurationMs;
  const timeout =
    options.maxDurationMs === undefined
      ? null
      : AbortSignal.timeout(Math.ceil(options.maxDurationMs));
  const signal =
    timeout === null
      ? options.signal
      : options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout]);
  let next = 0;
  let done = 0;
  /** Estimated spend of requests in flight, so concurrent workers cannot jointly pass the cap. */
  let reservedUsd = 0;
  const estimateUsd = (job: Job): number => tokensToUsd(job.built.stateTokens + QUESTION_TOKENS);
  const stopReason = (job: Job): RunRecord["outcome"] | null => {
    if (options.signal?.aborted) return "interrupted";
    if (deadline !== null && Date.now() >= deadline) return "budget-exhausted";
    const projected = summary.costUsd + reservedUsd + estimateUsd(job);
    if (options.maxCostUsd !== undefined && projected > options.maxCostUsd)
      return "budget-exhausted";
    return null;
  };

  const worker = async (): Promise<void> => {
    while (next < jobs.length && summary.outcome === "done") {
      const job = jobs[next];
      next += 1;
      if (job === undefined) return;
      const stop = stopReason(job);
      if (stop !== null) {
        summary.outcome = stop;
        return;
      }
      reservedUsd += estimateUsd(job);
      const result = await judgeOne(job, engine, loaded, runId, signal);
      reservedUsd -= estimateUsd(job);
      if (result.ok) {
        summary.judged += 1;
        summary.pending -= 1;
        summary.inputTokens += result.data.usage?.inputTokens ?? 0;
        summary.costUsd += result.data.usage?.costUsd ?? 0;
        await store.writeRecord(result.data);
        // Counted at emit time, with no await in between, so positions stay in order.
        done += 1;
        options.onProgress?.({
          type: "judged",
          record: result.data,
          done,
          total: jobs.length,
        });
        continue;
      }
      if (result.error.code === "interrupted") {
        summary.outcome = options.signal?.aborted ? "interrupted" : "budget-exhausted";
        return;
      }
      summary.errors += 1;
      summary.fatal ??= result.error;
      // A failed re-judge must not cost a verdict that is still valid for this evidence.
      if (!isCurrent(job.record, job.built, engineIdentity(loaded.config.engine))) {
        await store.writeRecord({
          ...job.record,
          status: "error",
          error: { code: result.error.code, message: result.error.message },
        });
      }
      done += 1;
      options.onProgress?.({
        type: "failed",
        findingId: job.record.finding_id,
        error: result.error,
        done,
        total: jobs.length,
      });
      if (
        result.error.code === "engine_circuit_open" ||
        result.error.code === "engine_auth_failed"
      ) {
        summary.outcome = "error";
        summary.fatal ??= result.error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: loaded.config.engine.concurrency }, worker));
  if (summary.errors > 0 && summary.outcome === "done") summary.outcome = "error";

  await store.writeRun({
    ...run,
    completedAt: new Date().toISOString(),
    outcome: summary.outcome,
    stats: {
      judged: summary.judged,
      skipped: plan.current.length,
      errors: summary.errors,
      inputTokens: summary.inputTokens,
      costUsd: summary.costUsd,
    },
  });
  return ok(summary);
};
