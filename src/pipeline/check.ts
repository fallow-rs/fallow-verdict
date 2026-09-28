import { statSync } from "node:fs";
import path from "node:path";

import type { LoadedConfig } from "../config/load.ts";
import type { DecisionEngine } from "../engine/types.ts";
import type { AnalysisAdapter, BuiltEvidence } from "../kinds/adapter.ts";
import { DEFAULT_KIND } from "../kinds/names.ts";
import {
  CHECK_EXIT,
  CHECK_SCHEMA,
  type CheckAction,
  type CheckOutcome,
  type CheckReport,
  type CheckResult,
} from "../report/check.ts";
import type { FindingText } from "../report/render.ts";
import type { FindingRecord } from "../state/schema.ts";
import { checkStoreKind, type Store } from "../state/store.ts";
import { verdictError, type VerdictError } from "../util/errors.ts";
import { err, ok, type Result } from "../util/result.ts";
import { estimateTokens, tokensToUsd } from "../util/tokens.ts";
import { confirmsDismissals, FATAL_CODES, judgeOne } from "./judge.ts";
import { newRecord } from "./scan.ts";

/** A candidate reduced to what relocation compares. */
export type Keyed = {
  id: string;
  /** The main match key. */
  key: string;
  /** Rule keys: a shared key means the same rule. */
  rules: readonly string[];
  /** Files of the candidate locations. */
  paths: readonly string[];
};
type KeyOnly = Pick<Keyed, "id" | "key">;

export type Relocation =
  | { type: "gone" }
  | { type: "found"; id: string; moved: boolean }
  | { type: "ambiguous"; ids: string[] };

/**
 * True when a fresh candidate is another stored candidate, unchanged: the same id and the same
 * main key as a stored candidate other than `target`. Such a candidate cannot be `target`.
 */
const claimedByOther = (target: KeyOnly, storedAll: readonly KeyOnly[], candidate: KeyOnly) =>
  storedAll.some(
    (known) => known.id !== target.id && known.id === candidate.id && known.key === candidate.key,
  );

/**
 * Finds a stored candidate in fresh Fallow output. An edit above a finding can change its id,
 * so the main key decides. When the match is not certain, the result is `ambiguous`. `gone`
 * only means that no key or id matches; `possibleMatches` decides if it is really resolved.
 */
export const relocate = (
  stored: KeyOnly,
  storedAll: readonly KeyOnly[],
  fresh: readonly KeyOnly[],
): Relocation => {
  const pool = fresh.filter((candidate) => !claimedByOther(stored, storedAll, candidate));
  const same = pool.filter((candidate) => candidate.key === stored.key);
  if (same.some((candidate) => candidate.id === stored.id))
    return { type: "found", id: stored.id, moved: false };
  // A stored twin with the same key that is unchanged at its own id is not a rival.
  const rivals = storedAll.filter(
    (known) =>
      known.id !== stored.id &&
      known.key === stored.key &&
      !fresh.some((candidate) => candidate.id === known.id && candidate.key === known.key),
  ).length;
  const [only] = same;
  if (same.length === 1 && only !== undefined && rivals === 0)
    return { type: "found", id: only.id, moved: true };
  if (same.length > 0) return { type: "ambiguous", ids: same.map((candidate) => candidate.id) };
  // Same id with a different key: the evidence text changed in place, unless the fresh
  // candidate has the key of another stored candidate that moved into this position.
  const inPlace = pool.find((candidate) => candidate.id === stored.id);
  if (
    inPlace !== undefined &&
    !storedAll.some((known) => known.id !== stored.id && known.key === inPlace.key)
  )
    return { type: "found", id: inPlace.id, moved: false };
  return { type: "gone" };
};

/**
 * The conservative rule for `resolved`: the fresh output of the whole project must have no
 * candidate that could be the stored one. Each fresh candidate could be, unless another stored
 * candidate claims it unchanged. Of the others, a candidate with the same rule anywhere in the
 * project, or any candidate in a file of the stored one, is a possible match. When in doubt,
 * the result is `ambiguous`.
 */
export const possibleMatches = (
  stored: Keyed,
  storedAll: readonly Keyed[],
  freshAll: readonly Keyed[],
): string[] =>
  freshAll
    .filter(
      (candidate) =>
        !claimedByOther(stored, storedAll, candidate) &&
        (candidate.rules.some((rule) => stored.rules.includes(rule)) ||
          candidate.paths.some((file) => stored.paths.includes(file))),
    )
    .map((candidate) => candidate.id);

export type CheckOptions = {
  /** A finding id from the last saved scan, or a file path. */
  target: string;
  /** Directory that a relative path target is resolved from. */
  cwd: string;
  dryRun: boolean;
  /** Called only when a finding needs an assessment, so a resolved check needs no API key. */
  engine: () => Result<DecisionEngine, VerdictError>;
  signal?: AbortSignal | undefined;
};

type Adapter<Output, Candidate, Built extends BuiltEvidence> = AnalysisAdapter<
  Output,
  Candidate,
  Built
>;

type Target<Candidate> = {
  type: CheckReport["target"]["type"];
  value: string;
  /** Stored candidates that the target names. */
  named: Candidate[];
  /** Project-relative files that the fresh Fallow run covers. */
  paths: string[];
};

type Plan<Candidate> =
  | { type: "resolved"; stored: Candidate }
  | { type: "ambiguous"; stored: Candidate; ids: string[] }
  | { type: "current"; stored: Candidate | null; fresh: Candidate };

/** Written into `judgeOne` history entries, which `check` never stores. */
const CHECK_RUN_ID = "check";
const SHELL_SAFE = /^[\w./:@=+,-]+$/;

const quote = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

const toPosix = (file: string): string => file.split(path.sep).join("/");

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** The last saved candidates, or null when no scan was saved. */
const readStored = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  store: Store,
): Promise<Result<Output | null, VerdictError>> => {
  if (!isFile(store.candidatesPath)) return ok(null);
  const raw = await store.readJson(store.candidatesPath);
  if (!raw.ok) return raw;
  return adapter.scan.parse(raw.data);
};

const resolveTarget = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  loaded: LoadedConfig,
  options: CheckOptions,
  stored: readonly Candidate[],
): Result<Target<Candidate>, VerdictError> => {
  const named = stored.find(
    (candidate) => adapter.identity(candidate).finding_id === options.target,
  );
  if (named !== undefined)
    return ok({
      type: "finding",
      value: options.target,
      named: [named],
      paths: [...new Set(adapter.identity(named).locations.map((location) => location.path))],
    });
  const absolute = path.resolve(options.cwd, options.target);
  const relative = path.relative(loaded.root, absolute);
  const unknown = verdictError(
    "config_invalid",
    `Unknown check target \`${options.target}\`.`,
    "Give a finding id from the last scan or a file path in the project.",
  );
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    return err(unknown);
  const file = toPosix(relative);
  const inFile = stored.filter((candidate) =>
    adapter.identity(candidate).locations.some((location) => location.path === file),
  );
  // A deleted file is still a valid target while the last scan has findings in it.
  if (!isFile(absolute) && inFile.length === 0) return err(unknown);
  return ok({ type: "path", value: file, named: inFile, paths: [file] });
};

const keyedWith =
  <Output, Candidate, Built extends BuiltEvidence>(adapter: Adapter<Output, Candidate, Built>) =>
  (candidate: Candidate): Keyed => {
    const identity = adapter.identity(candidate);
    return {
      id: identity.finding_id,
      ...adapter.match(candidate),
      paths: [...new Set(identity.locations.map((location) => location.path))],
    };
  };

/**
 * Plans each named stored candidate against the fresh output of the whole project. A path
 * target also judges the fresh candidates in its files that no stored candidate took.
 */
const plan = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  target: Target<Candidate>,
  storedAll: readonly Candidate[],
  freshAll: readonly Candidate[],
  inScope: (candidate: Candidate) => boolean,
): Plan<Candidate>[] => {
  const keyed = keyedWith(adapter);
  const storedKeyed = storedAll.map(keyed);
  const freshKeyed = freshAll.map(keyed);
  const byId = new Map(freshAll.map((candidate) => [keyed(candidate).id, candidate]));
  const claimed = new Set<string>();
  const plans: Plan<Candidate>[] = [];
  for (const stored of target.named) {
    const own = keyed(stored);
    const found = relocate(own, storedKeyed, freshKeyed);
    if (found.type === "gone") {
      const ids = possibleMatches(own, storedKeyed, freshKeyed);
      plans.push(
        ids.length === 0 ? { type: "resolved", stored } : { type: "ambiguous", stored, ids },
      );
    } else if (found.type === "ambiguous")
      plans.push({ type: "ambiguous", stored, ids: found.ids });
    else {
      const current = byId.get(found.id);
      if (current === undefined || claimed.has(found.id))
        plans.push({ type: "ambiguous", stored, ids: [found.id] });
      else {
        claimed.add(found.id);
        plans.push({ type: "current", stored, fresh: current });
      }
    }
  }
  if (target.type === "path")
    for (const candidate of freshAll)
      if (inScope(candidate) && !claimed.has(keyed(candidate).id))
        plans.push({ type: "current", stored: null, fresh: candidate });
  return plans;
};

/** A result for an assessment that failed with `error`. */
const failed = (result: CheckResult, error: VerdictError): CheckResult => ({
  ...result,
  status: "error",
  reason: error.message,
  error: { code: error.code, message: error.message },
});

const outcomeOf = (results: readonly CheckResult[]): CheckReport["outcome"] => {
  const has = (predicate: (result: CheckResult) => boolean): boolean => results.some(predicate);
  if (has((result) => result.status === "error")) return "error";
  // A finding that stands is certain work for the loop, so it comes before a review by a person.
  if (has((result) => result.status === "judged" && result.verdict === "survivor")) return "stands";
  if (
    has(
      (result) =>
        result.status === "ambiguous" ||
        (result.status === "judged" && result.verdict === "needs-human-review"),
    )
  )
    return "needs-person";
  if (has((result) => result.status === "not-assessed")) return "estimated";
  return "cleared";
};

const EXIT_FOR: Readonly<Record<CheckReport["outcome"], CheckReport["exit_code"]>> = {
  cleared: CHECK_EXIT.cleared,
  estimated: CHECK_EXIT.cleared,
  stands: CHECK_EXIT.stands,
  error: CHECK_EXIT.error,
  "needs-person": CHECK_EXIT.needsPerson,
};

const actionsFor = (
  kind: string,
  target: string,
  outcome: CheckReport["outcome"],
  results: readonly CheckResult[],
): CheckAction[] => {
  const suffix = kind === DEFAULT_KIND ? "" : ` --kind ${kind}`;
  const actions: CheckAction[] = [];
  if (outcome !== "cleared")
    actions.push({
      type: "rerun-check",
      auto_fixable: false,
      description: "Run the check again after you change the code.",
      command: `fallow-verdict check ${quote(target)}${suffix}`,
    });
  let rescan = false;
  for (const result of results) {
    const open =
      result.status === "ambiguous" ||
      (result.status === "judged" && result.verdict !== "dismissed");
    if (!open) continue;
    if (result.stored_id !== null && result.finding_id === result.stored_id)
      actions.push({
        type: "close",
        auto_fixable: false,
        description:
          "A person accepts this finding. Replace <reason> with the reason. It stays closed until its evidence changes.",
        command: `fallow-verdict close ${quote(result.stored_id)} --reason "<reason>"${suffix}`,
        finding_id: result.stored_id,
      });
    else rescan = true;
  }
  if (rescan)
    actions.push({
      type: "scan",
      auto_fixable: false,
      description: "Save a new scan, so that close can use the current finding ids.",
      command: `fallow-verdict scan${suffix}`,
    });
  return actions;
};

/**
 * Checks one finding or one file against a fresh Fallow run, for an edit loop. A finding that
 * Fallow no longer reports is `resolved` with no Jev call. Other findings are judged with the
 * normal judge path and policy. `check` writes no state.
 */
export const checkWith = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  loaded: LoadedConfig,
  store: Store,
  options: CheckOptions,
): Promise<Result<CheckOutcome, VerdictError>> => {
  const checked = checkStoreKind(store, adapter.kind);
  if (!checked.ok) return checked;
  const saved = await readStored(adapter, store);
  if (!saved.ok) return saved;
  const stored = saved.data === null ? [] : adapter.scan.candidates(saved.data);
  const target = resolveTarget(adapter, loaded, options, stored);
  if (!target.ok) return target;
  // One run for the whole project: a scoped run cannot see a renamed file or a moved helper.
  // For security a scoped run also analyzes the whole project, so this costs nothing more.
  // A failed run returns an error, never `resolved`.
  const fresh = await adapter.scan.run(loaded, {
    signal: options.signal,
    complete: target.data.paths,
  });
  if (!fresh.ok) return fresh;

  const inScope = (candidate: Candidate): boolean =>
    adapter
      .identity(candidate)
      .locations.some((location) => target.data.paths.includes(location.path));
  const plans = plan(adapter, target.data, stored, adapter.scan.candidates(fresh.data), inScope);
  const { records } = await store.readRecords();
  const recordFor = new Map(records.map((record) => [record.finding_id, record]));

  const results: CheckResult[] = [];
  const texts: (FindingText | null)[] = [];
  const estimate = { input_tokens: 0, usd: 0, max_confirmation_usd: 0 };
  const usage = { input_tokens: 0, cost_usd: 0 };
  let engine: Result<DecisionEngine, VerdictError> | null = null;

  /** An engine error that stops all further assessments, as in `judge`. */
  let fatal: VerdictError | null = null;

  for (const step of plans) {
    const identity = adapter.identity(step.type === "current" ? step.fresh : step.stored);
    const storedId = step.stored === null ? null : adapter.identity(step.stored).finding_id;
    const base: CheckResult = {
      status: "resolved",
      finding_id: identity.finding_id,
      stored_id: storedId,
      locations: [...identity.locations],
      category: identity.category,
      verdict: null,
      rule: null,
      confidence: null,
      reason: "",
      matches: [],
      error: null,
    };
    texts.push(null);
    if (step.type === "resolved") {
      results.push({ ...base, finding_id: null, reason: "Fallow no longer reports this finding." });
      continue;
    }
    if (step.type === "ambiguous") {
      results.push({
        ...base,
        status: "ambiguous",
        finding_id: null,
        matches: step.ids,
        reason:
          "More than one current finding can be this finding after the edit. A person must decide.",
      });
      continue;
    }
    const matched = { ...base, matches: [identity.finding_id] };
    const built = await adapter.packet.build(step.fresh, fresh.data, loaded);
    const closure = storedId === null ? undefined : recordFor.get(storedId)?.closed;
    if (closure !== undefined && closure.fingerprint === built.fingerprint) {
      results.push({ ...matched, status: "closed", reason: closure.reason });
      continue;
    }
    const tokens = built.stateTokens + estimateTokens(adapter.questions.for(built, loaded));
    estimate.input_tokens += tokens;
    estimate.usd += tokensToUsd(tokens);
    // Each dismissal needs one more call of the same size, so this is an upper bound.
    if (confirmsDismissals(adapter, loaded)) estimate.max_confirmation_usd += tokensToUsd(tokens);
    if (options.dryRun) {
      results.push({ ...matched, status: "not-assessed", reason: "Dry run: not assessed." });
      continue;
    }
    if (fatal !== null) {
      results.push(failed(matched, fatal));
      continue;
    }
    engine ??= options.engine();
    const judged = engine.ok
      ? await judgeOne(
          adapter,
          { record: newRecord(adapter.kind, identity, new Date().toISOString()), built },
          engine.data,
          loaded,
          CHECK_RUN_ID,
          options.signal,
          // `check` has no cost cap, so a dismissal always gets its second call.
          () => options.signal?.aborted !== true,
        )
      : engine;
    if (!judged.ok) {
      if (judged.error.code === "interrupted") return judged;
      if (!engine.ok || FATAL_CODES.has(judged.error.code)) fatal = judged.error;
      results.push(failed(matched, judged.error));
      continue;
    }
    // A rejected key or an open circuit on the confirmation call also stops the check.
    if (judged.data.fatal !== null) {
      fatal = judged.data.fatal;
      results.push(failed(matched, fatal));
      continue;
    }
    // A disagreed or failed confirmation gives `needs-human-review`, so exit code 3.
    const record: FindingRecord = judged.data.record;
    const decision = record.decision;
    if (decision === null) {
      results.push({
        ...matched,
        status: "error",
        reason: "The assessment returned no decision.",
        error: { code: "engine_response_invalid", message: "The assessment returned no decision." },
      });
      continue;
    }
    usage.input_tokens += record.usage?.inputTokens ?? 0;
    usage.cost_usd += record.usage?.costUsd ?? 0;
    texts[texts.length - 1] = adapter.report.describe(record, decision);
    results.push({
      ...matched,
      status: "judged",
      verdict: decision.verdict,
      rule: decision.rule,
      confidence: decision.confidence,
      reason: decision.reason,
    });
  }

  const outcome = outcomeOf(results);
  return ok({
    report: {
      schema_version: CHECK_SCHEMA,
      kind: adapter.kind,
      target: { type: target.data.type, value: target.data.value },
      dry_run: options.dryRun,
      outcome,
      exit_code: EXIT_FOR[outcome],
      estimate,
      usage,
      results,
      actions: actionsFor(adapter.kind, options.target, outcome, results),
    },
    texts,
  });
};
