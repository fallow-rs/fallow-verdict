import type { LoadedConfig } from "../config/load.ts";
import type { Answer, DecisionEngine, EvaluateResponse } from "../engine/types.ts";
import type { AnalysisAdapter, BuiltEvidence } from "../kinds/adapter.ts";
import { securityAdapter } from "../kinds/security.ts";
import { confirmDecision, type ConfirmedVerdict } from "../policy/confirm.ts";
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
import { dropStaleClosure, engineIdentity, invalidate, isCurrent } from "./freshness.ts";

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

export type Job<Built> = { record: FindingRecord; built: Built };

type Adapter<Output, Candidate, Built extends BuiltEvidence> = AnalysisAdapter<
  Output,
  Candidate,
  Built
>;

/** Engine errors that stop the whole run, on the first call or on the confirmation call. */
export const FATAL_CODES: ReadonlySet<VerdictError["code"]> = new Set([
  "engine_circuit_open",
  "engine_auth_failed",
  "engine_out_of_credits",
]);

/** A judged record, and a fatal engine error from its confirmation call, if any. */
type Judged = { record: FindingRecord; fatal: VerdictError | null };

/** Id recorded in history when a verdict changed because the policy did, not the evidence. */
const POLICY_RUN_ID = "policy";

/** Whether a dismissal of this kind needs a second call that agrees. */
export const confirmsDismissals = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  loaded: LoadedConfig,
): boolean => adapter.confirmDismissals?.(loaded) ?? loaded.config.policy.confirmDismissals;

/**
 * The verdicts of this kind that stand only when a second, identical call maps to the same
 * verdict: a dismissal per `confirmsDismissals`, and a survivor when the adapter asks for it.
 */
export const confirmedVerdicts = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  loaded: LoadedConfig,
): ReadonlySet<ConfirmedVerdict> =>
  new Set<ConfirmedVerdict>([
    ...(confirmsDismissals(adapter, loaded) ? (["dismissed"] as const) : []),
    ...((adapter.confirmSurvivors?.(loaded) ?? false) ? (["survivor"] as const) : []),
  ]);

const questionTokens = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  job: Job<Built>,
  loaded: LoadedConfig,
): number => estimateTokens(adapter.questions.for(job.built, loaded));

/**
 * Maps the stored answers to a decision. A verdict that needs confirmation (a dismissal with
 * `policy.confirmDismissals`, or what the adapter states) also needs a confirming answer set
 * that maps to the same verdict; without one it goes to a person.
 */
const decideWith = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  answers: Record<string, Answer>,
  confirmationAnswers: Record<string, Answer> | undefined,
  built: Built,
  loaded: LoadedConfig,
  missing?: string,
): StoredDecision => {
  const first = adapter.policy(answers, built, loaded);
  const confirmed = confirmedVerdicts(adapter, loaded);
  if (!needsSecond(confirmed, first)) return first;
  const second =
    confirmationAnswers === undefined ? null : adapter.policy(confirmationAnswers, built, loaded);
  return confirmDecision(first, second, confirmed, missing);
};

const needsSecond = (confirmed: ReadonlySet<ConfirmedVerdict>, decision: StoredDecision): boolean =>
  decision.verdict !== "needs-human-review" && confirmed.has(decision.verdict);

/**
 * A stored dismissal (or another verdict that needs confirmation) without a confirming answer set: a record from before the confirmation
 * rule, one judged with `confirmDismissals: false`, or one whose second call failed or was
 * stopped. `judge` asks again for these. Only a disagreement is final for the current evidence,
 * because only a disagreement says something about the finding.
 */
const needsConfirmation = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  record: FindingRecord,
  built: Built,
  loaded: LoadedConfig,
): boolean =>
  record.answers !== null &&
  record.confirmationAnswers === undefined &&
  needsSecond(confirmedVerdicts(adapter, loaded), adapter.policy(record.answers, built, loaded));

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
  for (const stored of records) {
    const candidate = candidates.get(stored.finding_id);
    if (candidate === undefined || stored.status === "resolved") continue;
    const built = await adapter.packet.build(candidate, output, loaded);
    // A person closed it and the evidence is the same: no request and no plan entry.
    if (stored.closed?.fingerprint === built.fingerprint) continue;
    // Otherwise a closure is stale, and the next written record must not keep it.
    const record = dropStaleClosure(stored, built.fingerprint);
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

/** Judges one candidate and returns the new record. It writes no state. `check` uses it too. */
export const judgeOne = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  job: Job<Built>,
  engine: DecisionEngine,
  loaded: LoadedConfig,
  runId: string,
  signal: AbortSignal | undefined,
  /** False when the time limit or an interruption forbids a confirmation call. */
  mayConfirm: () => boolean,
): Promise<Result<Judged, VerdictError>> => {
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
  let fatal: VerdictError | null = null;
  if (needsSecond(confirmedVerdicts(adapter, loaded), first)) {
    if (mayConfirm()) {
      const second = await engine.evaluate(request);
      if (second.ok) confirmation = second.data;
      else {
        missing = `the second assessment failed (${second.error.code})`;
        if (FATAL_CODES.has(second.error.code)) fatal = second.error;
      }
    } else {
      missing = "the time limit or an interruption stopped the second assessment";
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
  const record: FindingRecord = {
    ...job.record,
    status: "judged",
    fingerprint: job.built.fingerprint,
    questionSet: adapter.questions.version,
    questionHash: adapter.questions.hash(job.built, loaded),
    engine: engineIdentity(loaded.config.engine),
    answers: response.data.answers,
    confirmationAnswers: confirmation?.answers,
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
  };
  return ok({ record, fatal });
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
    if (
      decision.verdict === record.decision.verdict &&
      decision.rule === record.decision.rule &&
      decision.confidence === record.decision.confidence
    ) {
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
  const maxConfirmationUsd = confirmedVerdicts(adapter, loaded).size > 0 ? estimatedUsd : 0;
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
  // A dismissal needs a confirmation call, so a job reserves both calls before the first one.
  const callsPerJob = confirmedVerdicts(adapter, loaded).size > 0 ? 2 : 1;
  const reserveUsd = (job: Job<Built>): number => estimateUsd(job) * callsPerJob;
  const timeStop = (): RunRecord["outcome"] | null => {
    if (options.signal?.aborted) return "interrupted";
    if (deadline !== null && Date.now() >= deadline) return "budget-exhausted";
    return null;
  };
  const stopReason = (job: Job<Built>): RunRecord["outcome"] | null => {
    const stopped = timeStop();
    if (stopped !== null) return stopped;
    const projected = summary.costUsd + reservedUsd + reserveUsd(job);
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
      // Released in full after the job: the unused confirmation share returns to the budget.
      reservedUsd += reserveUsd(job);
      const mayConfirm = (): boolean => timeStop() === null;
      const result = await judgeOne(adapter, job, engine, loaded, runId, signal, mayConfirm);
      reservedUsd -= reserveUsd(job);
      if (result.ok) {
        const { record, fatal } = result.data;
        summary.judged += 1;
        summary.pending -= 1;
        summary.inputTokens += record.usage?.inputTokens ?? 0;
        summary.costUsd += record.usage?.costUsd ?? 0;
        await store.writeRecord(record);
        // Counted at emit time, with no await in between, so positions stay in order.
        done += 1;
        options.onProgress?.({ type: "judged", record, done, total: jobs.length });
        if (fatal !== null) {
          summary.outcome = "error";
          summary.fatal ??= fatal;
          return;
        }
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
      if (FATAL_CODES.has(result.error.code)) {
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
