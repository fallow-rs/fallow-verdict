import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig, type LoadedConfig } from "../config/load.ts";
import { withCircuitBreaker } from "../engine/breaker.ts";
import { createJevEngine } from "../engine/jev.ts";
import type { DecisionEngine } from "../engine/types.ts";
import { evaluate, labelsSchema } from "../eval/metrics.ts";
import type { AnalysisAdapter, BuiltEvidence } from "../kinds/adapter.ts";
import { kindFor } from "../kinds/registry.ts";
import {
  judgeWith,
  refreshVerdictsWith,
  type JudgeProgress,
  type JudgeSummary,
} from "../pipeline/judge.ts";
import { checkWith } from "../pipeline/check.ts";
import { closeWith, reopenChangedClosures } from "../pipeline/close.ts";
import { scanWith } from "../pipeline/scan.ts";
import { renderCheckHuman } from "../report/check.ts";
import {
  buildReport,
  confirmationBoundLine,
  dismissedWords,
  renderHuman,
  renderMarkdown,
  type KindPresentation,
  type Report,
} from "../report/render.ts";
import { checkStoreKind, openStore, type Store } from "../state/store.ts";
import { EXIT, verdictError, type VerdictError } from "../util/errors.ts";
import { err, ok, type Result } from "../util/result.ts";
import { formatUsd } from "../util/tokens.ts";
import { HELP, parseCli, type CliOptions } from "./args.ts";

const STARTER_CONFIG = `import { defineConfig } from "fallow-verdict/config";

export default defineConfig({
  // failOn: "survivor",
  // policy: { survivorMinExploitable: 0.7 },
});
`;

export type Context = {
  options: CliOptions;
  loaded: LoadedConfig;
  store: Store;
  signal: AbortSignal;
};
type Adapter<Output, Candidate, Built extends BuiltEvidence> = AnalysisAdapter<
  Output,
  Candidate,
  Built
>;
type Outcome = Result<{ exitCode: number; json?: unknown; human?: string }, VerdictError>;

const progress = (options: CliOptions, line: string): void => {
  if (!options.quiet) process.stderr.write(`${line}\n`);
};

const createEngine = (loaded: LoadedConfig): Result<DecisionEngine, VerdictError> => {
  const { apiKeyEnv, baseUrl, model, timeoutMs, requestsPerMinute } = loaded.config.engine;
  const apiKey = process.env[apiKeyEnv];
  if (apiKey === undefined || apiKey === "") {
    return err(
      verdictError(
        "engine_auth_failed",
        `The ${apiKeyEnv} environment variable is empty or unset.`,
        `Set ${apiKeyEnv} to your Jev API key, or set engine.apiKeyEnv to the variable you use. Use --dry-run to estimate cost without a key.`,
      ),
    );
  }
  return ok(
    withCircuitBreaker(createJevEngine({ apiKey, baseUrl, model, timeoutMs, requestsPerMinute })),
  );
};

const onJudgeProgress =
  (options: CliOptions, presentation: KindPresentation) =>
  (event: JudgeProgress): void => {
    if (event.type === "plan") {
      const bound = confirmationBoundLine(presentation, event.maxConfirmationUsd);
      progress(
        options,
        `Assessment plan: ${event.toJudge} to assess, ${event.upToDate} up to date.\nEstimated request cost: ${formatUsd(event.estimatedUsd)} (about ${event.estimatedTokens} input tokens).${bound === null ? "" : `\n${bound}`}${options.dryRun ? "\nDry run: no requests will be sent to Jev." : ""}`,
      );
    } else if (event.type === "judged") {
      const decision = event.record.decision;
      const label =
        decision?.verdict === "survivor"
          ? presentation.survivor.label
          : decision?.verdict === "dismissed"
            ? dismissedWords(presentation).label
            : decision?.verdict === "needs-human-review"
              ? "Needs review"
              : "Assessment unavailable";
      progress(
        options,
        `[${event.done}/${event.total}] ${label}: ${event.record.path}:${event.record.line}`,
      );
    } else {
      progress(
        options,
        `[${event.done}/${event.total}] Assessment failed (${event.error.code}): ${event.error.message}`,
      );
    }
  };

const runJudge = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  context: Context,
): Promise<Result<JudgeSummary, VerdictError>> => {
  const { options, loaded, store, signal } = context;
  let engine: DecisionEngine | null = null;
  if (!options.dryRun) {
    const created = createEngine(loaded);
    if (!created.ok) return created;
    engine = created.data;
  }
  // A dry run never reaches the engine; the placeholder keeps the signature honest about that.
  const unreachable: DecisionEngine = {
    id: "none",
    evaluate: () => Promise.resolve(err(verdictError("engine_rejected", "dry run"))),
  };
  return judgeWith(adapter, loaded, store, engine ?? unreachable, {
    rejudge: options.rejudge,
    dryRun: options.dryRun,
    limit: options.limit,
    maxCostUsd: options.maxCostUsd,
    maxDurationMs: options.maxDurationMs,
    signal,
    onProgress: onJudgeProgress(options, adapter.report),
  });
};

const exitCodeFor = (report: Report, failOn: LoadedConfig["config"]["failOn"]): number => {
  if (report.summary.errors > 0 || report.summary.pending > 0) return EXIT.error;
  if (failOn === "off") return EXIT.ok;
  const failing =
    report.summary.survivors +
    (failOn === "needs-human-review" ? report.summary.needsHumanReview : 0);
  return failing > 0 ? EXIT.findings : EXIT.ok;
};

/** The stored Fallow output. */
const storedOutput = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  store: Store,
): Promise<Result<Output, VerdictError>> => {
  const raw = await store.readJson(store.candidatesPath);
  if (!raw.ok) return raw;
  return adapter.scan.parse(raw.data);
};

/** Finding ids of the stored candidate set, taken from the adapter, never from an engine response. */
const idsOf = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  output: Output,
): Set<string> =>
  new Set(
    adapter.scan.candidates(output).map((candidate) => adapter.identity(candidate).finding_id),
  );

const candidateIds = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  store: Store,
): Promise<Result<Set<string>, VerdictError>> => {
  const output = await storedOutput(adapter, store);
  return output.ok ? ok(idsOf(adapter, output.data)) : output;
};

const runReport = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  context: Context,
): Promise<Outcome> => {
  const { options, loaded, store } = context;
  const refreshed = await refreshVerdictsWith(adapter, loaded, store);
  if (!refreshed.ok) return refreshed;
  const reopened = await reopenChangedClosures(adapter, loaded, store);
  if (!reopened.ok) return reopened;
  const { records, corrupt } = await store.readRecords();
  for (const name of corrupt) progress(options, `Warning: could not read saved result ${name}.`);

  const output = await storedOutput(adapter, store);
  if (!output.ok) return output;
  const ids = idsOf(adapter, output.data);

  await store.writeJson(store.verdictsPath, adapter.export.verdicts(records, ids, output.data));
  if (options.validate && adapter.export.validate !== null) {
    const validated = await adapter.export.validate(loaded, store);
    if (!validated.ok) return validated;
  }

  const report = buildReport(
    records.filter((record) => ids.has(record.finding_id)),
    adapter.priority,
  );
  await writeFile(store.reportPath, renderMarkdown(report, adapter.report));
  return ok({
    exitCode: exitCodeFor(
      report,
      options.failOn ?? adapter.failOn?.(loaded) ?? loaded.config.failOn,
    ),
    json: report,
    human: renderHuman(report, adapter.report, options.showDismissed),
  });
};

const runInit = async (options: CliOptions): Promise<Outcome> => {
  const configPath = path.join(options.cwd, "fallow-verdict.config.ts");
  if (existsSync(configPath)) {
    return err(verdictError("config_invalid", `${configPath} already exists.`));
  }
  await writeFile(configPath, STARTER_CONFIG);
  const ignorePath = path.join(options.cwd, ".gitignore");
  const ignored = existsSync(ignorePath) ? await readFile(ignorePath, "utf8") : "";
  if (!ignored.includes(".fallow-verdict")) await appendFile(ignorePath, "\n.fallow-verdict/\n");
  return ok({
    exitCode: EXIT.ok,
    human: `Created ${configPath}.\nThe .fallow-verdict/ state directory is excluded from Git.`,
  });
};

/** `check` writes no state, so it takes no lock. */
const runCheck = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  context: Context,
): Promise<Outcome> => {
  const { options, loaded, store, signal } = context;
  const checked = await checkWith(adapter, loaded, store, {
    target: options.positionals[0] ?? "",
    cwd: options.cwd,
    dryRun: options.dryRun,
    engine: () => createEngine(loaded),
    signal,
  });
  if (!checked.ok) return checked;
  return ok({
    exitCode: checked.data.report.exit_code,
    json: checked.data.report,
    human: renderCheckHuman(checked.data, adapter.report),
  });
};

const runClose = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  context: Context,
): Promise<Outcome> => {
  const { options, loaded, store } = context;
  const id = options.positionals[0] ?? "";
  const closed = await closeWith(adapter, loaded, store, id, options.reason ?? "");
  if (!closed.ok) return closed;
  return ok({
    exitCode: EXIT.ok,
    json: { finding_id: closed.data.finding_id, closed: closed.data.closed },
    human: `Closed ${id}. It stays closed until its evidence changes.`,
  });
};

const percent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

const runEval = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  context: Context,
): Promise<Outcome> => {
  const { options, store } = context;
  if (options.labels === undefined) {
    return err(verdictError("config_invalid", "`eval` needs --labels <path>."));
  }
  const raw = await store.readJson(path.resolve(options.cwd, options.labels));
  if (!raw.ok) return raw;
  const labels = labelsSchema.safeParse(raw.data);
  if (!labels.success) {
    return err(verdictError("config_invalid", `Invalid labels file: ${labels.error.message}`));
  }
  const { records } = await store.readRecords();
  const candidates = await candidateIds(adapter, store);
  if (!candidates.ok) return candidates;
  const ids = candidates.data;
  const result = evaluate(
    records.filter((record) => ids.has(record.finding_id)),
    labels.data,
  );
  const human = [
    `Evaluation: ${result.judged} of ${result.labeled} labeled candidates assessed.`,
    "",
    `Dismissed findings that were safe    ${percent(result.dismissPrecision)}`,
    `Vulnerabilities wrongly dismissed   ${result.missedVulnerabilities.length}`,
    `Vulnerabilities marked likely       ${percent(result.survivorRecall)}`,
    `Safe findings dismissed             ${percent(result.noiseRemoved)}`,
    `Findings needing review             ${percent(result.reviewRate)}`,
    `Calibration error (lower is better) ${result.calibrationError?.toFixed(3) ?? "n/a"}`,
    "",
    result.unjudged > 0
      ? `Assessment is incomplete: ${result.unjudged} labeled candidates have no current verdict. Rates and calibration are unavailable until all are assessed.`
      : "n/a means there are no relevant examples or probabilities for that metric.",
    ...result.missedVulnerabilities.map((id) => `Wrongly dismissed vulnerability: ${id}`),
  ].join("\n");
  // A dismissed vulnerability is the one failure this tool must not have.
  return ok({
    exitCode:
      result.unjudged > 0
        ? EXIT.error
        : result.missedVulnerabilities.length > 0
          ? EXIT.findings
          : EXIT.ok,
    json: result,
    human,
  });
};

/** A usage error for an option that the selected kind does not support, or null. */
export const unsupportedOption = <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  options: CliOptions,
): VerdictError | null => {
  if (options.questionProfile !== undefined && !adapter.supports.questionProfile)
    return verdictError(
      "config_invalid",
      `--question-profile is not available for the ${adapter.kind} kind.`,
      "Remove --question-profile, or select a kind that supports it.",
    );
  if (options.command === "eval" && !adapter.supports.eval)
    return verdictError(
      "config_invalid",
      `\`eval\` is not available for the ${adapter.kind} kind.`,
    );
  return null;
};

/** Runs one command for one kind. The store must hold the state of that kind. */
export const dispatchKind = async <Output, Candidate, Built extends BuiltEvidence>(
  adapter: Adapter<Output, Candidate, Built>,
  context: Context,
): Promise<Outcome> => {
  const { options, loaded, store } = context;
  const scanOptions = { changedSince: options.changedSince, paths: options.positionals };
  const unsupported = unsupportedOption(adapter, options);
  if (unsupported !== null) return err(unsupported);
  const checked = checkStoreKind(store, adapter.kind);
  if (!checked.ok) return checked;

  if (options.command === "status") {
    const { records } = await store.readRecords();
    const report = buildReport(records, adapter.priority);
    return ok({
      exitCode: EXIT.ok,
      json: report,
      human: renderHuman(report, adapter.report, options.showDismissed),
    });
  }
  if (options.command === "check") return runCheck(adapter, context);
  const release = await store.lock();
  if (!release.ok) return release;
  try {
    if (options.command === "close") return await runClose(adapter, context);
    if (options.command === "eval") {
      const refreshed = await refreshVerdictsWith(adapter, loaded, store);
      if (!refreshed.ok) return refreshed;
      return runEval(adapter, context);
    }
    if (options.command === "scan" || options.command === "run") {
      const scanned = await scanWith(adapter, loaded, store, scanOptions);
      if (!scanned.ok) return scanned;
      const { candidates, added, resolved, reopened } = scanned.data;
      progress(
        options,
        `Scan complete: ${candidates} candidates. ${added} new, ${reopened} reopened, ${resolved} no longer reported.`,
      );
      if (options.command === "scan") return ok({ exitCode: EXIT.ok, json: scanned.data });
    }
    if (options.command === "judge" || options.command === "run") {
      const judged = await runJudge(adapter, context);
      if (!judged.ok) return judged;
      if (judged.data.outcome === "interrupted") return ok({ exitCode: EXIT.interrupted });
      if (judged.data.outcome === "error") {
        return err(
          judged.data.fatal ??
            verdictError("engine_circuit_open", "Assessment stopped after repeated Jev failures."),
        );
      }
      if (judged.data.outcome === "budget-exhausted") {
        progress(
          options,
          "Assessment limit reached. Remaining candidates are pending; run judge again to continue.",
        );
      }
      if (options.command === "judge" || options.dryRun) {
        const incomplete = judged.data.pending > 0;
        return ok({
          exitCode: !options.dryRun && incomplete ? EXIT.error : EXIT.ok,
          json: judged.data,
        });
      }
    }
    return await runReport(adapter, context);
  } finally {
    await release.data();
  }
};

const dispatch = (context: Context): Promise<Outcome> =>
  kindFor(context.options.analysisKind).use((adapter) => dispatchKind(adapter, context));

const printError = (error: VerdictError, format: CliOptions["format"]): void => {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ error: true, ...error, exit_code: EXIT.error })}\n`);
    return;
  }
  process.stderr.write(`Error: ${error.message}\nCode: ${error.code}\n`);
  if (error.hint !== undefined) process.stderr.write(`${error.hint}\n`);
};

export const main = async (argv: readonly string[]): Promise<number> => {
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    printError(parsed.error, "human");
    return EXIT.error;
  }
  if (parsed.data.kind === "help") {
    process.stdout.write(HELP);
    return EXIT.ok;
  }
  if (parsed.data.kind === "version") {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`${manifest.version}\n`);
    return EXIT.ok;
  }

  const { options } = parsed.data;
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  let outcome: Outcome;
  if (options.command === "init") {
    outcome = await runInit(options);
  } else {
    const loaded = await loadConfig(options.cwd, options.config);
    outcome = loaded.ok
      ? await dispatch({
          options,
          loaded: {
            ...loaded.data,
            config: {
              ...loaded.data.config,
              questionProfile: options.questionProfile ?? loaded.data.config.questionProfile,
            },
          },
          store: openStore(loaded.data.dataDir, options.analysisKind),
          signal: controller.signal,
        })
      : loaded;
  }

  if (!outcome.ok) {
    printError(outcome.error, options.format);
    return outcome.error.code === "interrupted" ? EXIT.interrupted : EXIT.error;
  }
  if (options.format === "json" && outcome.data.json !== undefined) {
    process.stdout.write(`${JSON.stringify(outcome.data.json, null, 2)}\n`);
  } else if (outcome.data.human !== undefined) {
    process.stdout.write(`${outcome.data.human}\n`);
  }
  return outcome.data.exitCode;
};
