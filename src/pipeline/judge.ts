import type { LoadedConfig } from "../config/load.ts";
import type { Answer, DecisionEngine, EvaluateResponse } from "../engine/types.ts";
import type { AnalysisAdapter, BuiltEvidence } from "../kinds/adapter.ts";
import { securityAdapter } from "../kinds/security.ts";
import { confirmDismissal } from "../policy/confirm.ts";
import {
  RUN_SCHEMA,
  type FindingRecord,
  type RunRecord,
  type StoredDecision,
} from "../state/schema.ts";
import { checkStoreKind, newRunId, type Store } from "../state/store.ts";
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
      /** Upper bound for dismissal confirmation calls: one more call for every candidate. */
      maxConfirmationUsd: number;
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
  /** Upper bound for dismissal confirmation calls, on top of `estimatedUsd`. Zero when disabled. */
  maxConfirmationUsd: number;
  /** First engine error to report when a batch cannot complete successfully. */
  fatal: VerdictError | null;
};

type Job<Built> = { record: FindingRecord; built: Built };

type Adapter<Output, Candidate, Built extends BuiltEvidence> = AnalysisAdapter<
  Output,
  Candidate,
  Built
>;

/** Id recorded in history when a verdict changed because the policy did, not the evidence. */
const POLICY_RUN_ID = "policy";

const questionTokens = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  job: Job<Built>,
  loaded: LoadedConfig,
): number => estimateTokens(adapter.questions.for(job.built, loaded));

/**
 * Maps the stored answers to a decision. With `policy.confirmDismissals`, a dismissal also needs
 * a confirming answer set that maps to a dismissal; without one it goes to a person.
 */
const decideWith = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  answers: Record<string, Answer>,
  confirmationAnswers: Record<string, Answer> | null | undefined,
  built: Built,
  loaded: LoadedConfig,
  missing?: string,
): StoredDecision => {
  const first = adapter.policy(answers, built, loaded);
  if (!loaded.config.policy.confirmDismissals) return first;
  const second =
    confirmationAnswers === undefined || confirmationAnswers === null
      ? null
      : adapter.policy(confirmationAnswers, built, loaded);
  return confirmDismissal(first, second, missing);
};

/**
 * A stored dismissal that was never confirmed: a record from before the confirmation rule, or
 * one judged with `confirmDismissals: false`. `judge` asks again for these. A confirmation that
 * disagreed or failed (`confirmationAnswers: null`) is final for the current evidence.
 */
const needsConfirmation = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  record: FindingRecord,
  built: Built,
  loaded: LoadedConfig,
): boolean =>
  loaded.config.policy.confirmDismissals &&
  record.answers !== null &&
  record.confirmationAnswers === undefined &&
  adapter.policy(record.answers, built, loaded).verdict === "dismissed";

const planJobs = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  loaded: LoadedConfig,
  output: Output,
  records: readonly FindingRecord[],
  rejudge: boolean,
  /** `judge` also asks again for a stored dismissal that was never confirmed. */
  confirmMissing: boolean,
): Promise<{ jobs: Job<Built>[]; current: Job<Built>[] }> => {
  const candidates = new Map<string, Candidate>(
    adapter.scan
      .candidates(output)
      .map((candidate) => [adapter.identity(candidate).finding_id, candidate]),
  );
  const jobs: Job<Built>[] = [];
  const current: Job<Built>[] = [];
  for (const record of records) {
    const candidate = candidates.get(record.finding_id);
    if (candidate === undefined || record.status === "resolved") continue;
    const built = await adapter.packet.build(candidate, output, loaded);
    if (
      !rejudge &&
      isCurrent(adapter, record, built, loaded) &&
      !(confirmMissing && needsConfirmation(adapter, record, built, loaded))
    )
      current.push({ record, built });
    else jobs.push({ record, built });
  }
  // The kind decides what matters most, so a budget cap spends on that first.
  jobs.sort((a, b) => adapter.priority(a.record) - adapter.priority(b.record));
  return { jobs, current };
};

const judgeOne = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  job: Job<Built>,
  engine: DecisionEngine,
  loaded: LoadedConfig,
  runId: string,
  signal: AbortSignal | undefined,
  /** Reserves budget for a confirmation call; false when the budget, time or signal forbid it. */
  mayConfirm: () => boolean,
): Promise<Result<FindingRecord, VerdictError>> => {
  if (job.built.stateTokens > loaded.config.packet.maxStateTokens) {
    return err(
      verdictError(
        "engine_rejected",
        "Evidence exceeds the configured token budget even after trimming.",
      ),
    );
  }
  const request = {
    state: job.built.packet,
    questions: adapter.questions.for(job.built, loaded),
    signal,
  };
  const response = await engine.evaluate(request);
  if (!response.ok) return response;

  const first = adapter.policy(response.data.answers, job.built, loaded);
  let confirmation: EvaluateResponse | null = null;
  let missing: string | undefined;
  let confirmationAnswers: Record<string, Answer> | null | undefined;
  if (loaded.config.policy.confirmDismissals && first.verdict === "dismissed") {
    if (mayConfirm()) {
      const second = await engine.evaluate(request);
      if (second.ok) confirmation = second.data;
      else missing = `the second assessment failed (${second.error.code})`;
      // Asked but not answered: final for this evidence, so `judge` does not ask on every run.
      confirmationAnswers = confirmation?.answers ?? null;
    } else {
      missing = "the budget, the time limit or an interruption stopped the second assessment";
    }
  }
  const decision = decideWith(
    adapter,
    response.data.answers,
    confirmation?.answers,
    job.built,
    loaded,
    missing,
  );
  const inputTokens = response.data.inputTokens + (confirmation?.inputTokens ?? 0);
  const now = new Date().toISOString();
  return ok({
    ...job.record,
    status: "judged",
    fingerprint: job.built.fingerprint,
    questionSet: adapter.questions.version,
    questionHash: adapter.questions.hash(job.built, loaded),
    engine: engineIdentity(loaded.config.engine),
    answers: response.data.answers,
    confirmationAnswers,
    decision,
    evidence: adapter.packet.summary(job.built),
    usage: {
      inputTokens,
      costUsd: tokensToUsd(inputTokens),
      latencyMs: response.data.latencyMs + (confirmation?.latencyMs ?? 0),
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
const applyPolicy = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  jobs: readonly Job<Built>[],
  loaded: LoadedConfig,
  store: Store,
): Promise<void> => {
  for (const job of jobs) {
    const { record, built } = job;
    if (record.answers === null || record.decision === null) continue;
    const decision = decideWith(adapter, record.answers, record.confirmationAnswers, built, loaded);
    if (decision.verdict === record.decision.verdict && decision.rule === record.decision.rule) {
      continue;
    }
    job.record = {
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
    };
    await store.writeRecord(job.record);
  }
};

const invalidateJobs = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  jobs: Job<Built>[],
  loaded: LoadedConfig,
  store: Store,
): Promise<void> => {
  for (const job of jobs) {
    if (isCurrent(adapter, job.record, job.built, loaded)) continue;
    job.record = invalidate(job.record);
    await store.writeRecord(job.record);
  }
};

/** Stored candidates and their records. Every current candidate must have a readable record. */
const loadState = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  store: Store,
): Promise<Result<{ output: Output; records: FindingRecord[] }, VerdictError>> => {
  const checked = checkStoreKind(store, adapter.kind);
  if (!checked.ok) return checked;
  const raw = await store.readJson(store.candidatesPath);
  if (!raw.ok) return raw;
  const output = adapter.scan.parse(raw.data);
  if (!output.ok) return output;
  const read = await store.readRecords();
  const { records } = read;
  const recorded = new Set(
    records.filter((record) => record.status !== "resolved").map((record) => record.finding_id),
  );
  if (
    read.corrupt.length > 0 ||
    adapter.scan
      .candidates(output.data)
      .some((candidate) => !recorded.has(adapter.identity(candidate).finding_id))
  )
    return err(
      verdictError(
        "state_corrupt",
        "Missing or unreadable finding records. Run scan to reconstruct current candidates.",
      ),
    );
  return ok({ output: output.data, records });
};

/** Revalidate stored decisions before reporting or evaluating, without any engine calls. */
export const refreshVerdictsWith = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  loaded: LoadedConfig,
  store: Store,
): Promise<Result<void, VerdictError>> => {
  const state = await loadState(adapter, store);
  if (!state.ok) return state;
  const plan = await planJobs(adapter, loaded, state.data.output, state.data.records, false, false);
  await invalidateJobs(adapter, plan.jobs, loaded, store);
  await applyPolicy(adapter, plan.current, loaded, store);
  return ok(undefined);
};

export const refreshVerdicts = (
  loaded: LoadedConfig,
  store: Store,
): Promise<Result<void, VerdictError>> => refreshVerdictsWith(securityAdapter, loaded, store);

export const judgeWith = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  loaded: LoadedConfig,
  store: Store,
  engine: DecisionEngine,
  options: JudgeOptions,
): Promise<Result<JudgeSummary, VerdictError>> => {
  const state = await loadState(adapter, store);
  if (!state.ok) return state;
  const plan = await planJobs(
    adapter,
    loaded,
    state.data.output,
    state.data.records,
    options.rejudge,
    true,
  );
  const jobs = options.limit === undefined ? plan.jobs : plan.jobs.slice(0, options.limit);
  const estimatedTokens = jobs.reduce(
    (sum, job) => sum + job.built.stateTokens + questionTokens(adapter, job, loaded),
    0,
  );
  const estimatedUsd = tokensToUsd(estimatedTokens);
  // Each candidate can need one confirmation call of the same size, so this is an upper bound.
  const maxConfirmationUsd = loaded.config.policy.confirmDismissals ? estimatedUsd : 0;
  options.onProgress?.({
    type: "plan",
    toJudge: jobs.length,
    upToDate: plan.current.length,
    estimatedTokens,
    estimatedUsd,
    maxConfirmationUsd,
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
    maxConfirmationUsd,
    fatal: null,
  };
  if (options.dryRun) return ok(summary);
  await invalidateJobs(adapter, plan.jobs, loaded, store);
  // Invalidated jobs have no answers, so this remaps only the current records and the stored
  // dismissals that wait for confirmation. A stop before their new call leaves the review verdict.
  await applyPolicy(adapter, [...plan.current, ...plan.jobs], loaded, store);
  if (jobs.length === 0) return ok(summary);

  const run: RunRecord = {
    schema_version: RUN_SCHEMA,
    runId,
    kind: adapter.kind,
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
  const estimateUsd = (job: Job<Built>): number =>
    tokensToUsd(job.built.stateTokens + questionTokens(adapter, job, loaded));
  const stopReason = (job: Job<Built>): RunRecord["outcome"] | null => {
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
      let confirmReservedUsd = 0;
      const mayConfirm = (): boolean => {
        if (stopReason(job) !== null) return false;
        confirmReservedUsd = estimateUsd(job);
        reservedUsd += confirmReservedUsd;
        return true;
      };
      const result = await judgeOne(adapter, job, engine, loaded, runId, signal, mayConfirm);
      reservedUsd -= estimateUsd(job) + confirmReservedUsd;
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
      if (!isCurrent(adapter, job.record, job.built, loaded)) {
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
        result.error.code === "engine_auth_failed" ||
        result.error.code === "engine_out_of_credits"
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

export const judge = (
  loaded: LoadedConfig,
  store: Store,
  engine: DecisionEngine,
  options: JudgeOptions,
): Promise<Result<JudgeSummary, VerdictError>> =>
  judgeWith(securityAdapter, loaded, store, engine, options);
