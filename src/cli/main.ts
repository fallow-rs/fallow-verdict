import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig, type LoadedConfig } from "../config/load.ts";
import { withCircuitBreaker } from "../engine/breaker.ts";
import { createJevEngine } from "../engine/jev.ts";
import type { DecisionEngine } from "../engine/types.ts";
import { evaluate, labelsSchema } from "../eval/metrics.ts";
import { parseSecurityOutput, runSurvivors } from "../fallow/run.ts";
import {
  judge,
  refreshVerdicts,
  type JudgeProgress,
  type JudgeSummary,
} from "../pipeline/judge.ts";
import { scan } from "../pipeline/scan.ts";
import { buildReport, renderHuman, renderMarkdown, type Report } from "../report/render.ts";
import { openStore, type Store } from "../state/store.ts";
import { EXIT, verdictError, type VerdictError } from "../util/errors.ts";
import { err, ok, type Result } from "../util/result.ts";
import { formatUsd } from "../util/tokens.ts";
import { toVerdictsFile } from "../verdicts/export.ts";
import { HELP, parseCli, type CliOptions } from "./args.ts";

const STARTER_CONFIG = `import { defineConfig } from "fallow-verdict/config";

export default defineConfig({
  // failOn: "survivor",
  // policy: { survivorMinExploitable: 0.7 },
});
`;

type Context = { options: CliOptions; loaded: LoadedConfig; store: Store; signal: AbortSignal };
type Outcome = Result<{ exitCode: number; json?: unknown; human?: string }, VerdictError>;

const progress = (options: CliOptions, line: string): void => {
  if (!options.quiet) process.stderr.write(`${line}\n`);
};

const createEngine = (loaded: LoadedConfig): Result<DecisionEngine, VerdictError> => {
  const { apiKeyEnv, baseUrl, model, timeoutMs } = loaded.config.engine;
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
  return ok(withCircuitBreaker(createJevEngine({ apiKey, baseUrl, model, timeoutMs })));
};

const onJudgeProgress =
  (options: CliOptions) =>
  (event: JudgeProgress): void => {
    if (event.type === "plan") {
      progress(
        options,
        `Assessment plan: ${event.toJudge} to assess, ${event.upToDate} up to date.\nEstimated request cost: ${formatUsd(event.estimatedUsd)} (about ${event.estimatedTokens} input tokens).${options.dryRun ? "\nDry run: no requests will be sent to Jev." : ""}`,
      );
    } else if (event.type === "judged") {
      const decision = event.record.decision;
      const label =
        decision?.verdict === "survivor"
          ? "Likely vulnerability"
          : decision?.verdict === "dismissed"
            ? "Dismissed"
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

const runJudge = async (context: Context): Promise<Result<JudgeSummary, VerdictError>> => {
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
  return judge(loaded, store, engine ?? unreachable, {
    rejudge: options.rejudge,
    dryRun: options.dryRun,
    limit: options.limit,
    maxCostUsd: options.maxCostUsd,
    maxDurationMs: options.maxDurationMs,
    signal,
    onProgress: onJudgeProgress(options),
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

const runReport = async (context: Context): Promise<Outcome> => {
  const { options, loaded, store } = context;
  const refreshed = await refreshVerdicts(loaded, store);
  if (!refreshed.ok) return refreshed;
  const { records, corrupt } = await store.readRecords();
  for (const name of corrupt) progress(options, `Warning: could not read saved result ${name}.`);

  const raw = await store.readJson(store.candidatesPath);
  if (!raw.ok) return raw;
  const candidates = parseSecurityOutput(raw.data);
  if (!candidates.ok) return candidates;
  const ids = new Set(candidates.data.security_findings.map((finding) => finding.finding_id));

  await store.writeJson(store.verdictsPath, toVerdictsFile(records, ids));
  if (options.validate) {
    const validated = await runSurvivors({
      root: loaded.root,
      binary: loaded.config.fallow.binary,
      candidatesPath: store.candidatesPath,
      verdictsPath: store.verdictsPath,
    });
    if (!validated.ok) return validated;
  }

  const report = buildReport(records.filter((record) => ids.has(record.finding_id)));
  await writeFile(store.reportPath, renderMarkdown(report));
  return ok({
    exitCode: exitCodeFor(report, options.failOn ?? loaded.config.failOn),
    json: report,
    human: renderHuman(report, options.showDismissed),
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

const percent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

const runEval = async (context: Context): Promise<Outcome> => {
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
  const rawCandidates = await store.readJson(store.candidatesPath);
  if (!rawCandidates.ok) return rawCandidates;
  const candidates = parseSecurityOutput(rawCandidates.data);
  if (!candidates.ok) return candidates;
  const ids = new Set(candidates.data.security_findings.map((finding) => finding.finding_id));
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

const dispatch = async (context: Context): Promise<Outcome> => {
  const { options, loaded, store } = context;
  const scanOptions = { changedSince: options.changedSince, paths: options.positionals };

  if (options.command === "status") {
    const { records } = await store.readRecords();
    const report = buildReport(records);
    return ok({
      exitCode: EXIT.ok,
      json: report,
      human: renderHuman(report, options.showDismissed),
    });
  }
  const release = await store.lock();
  if (!release.ok) return release;
  try {
    if (options.command === "eval") {
      const refreshed = await refreshVerdicts(loaded, store);
      if (!refreshed.ok) return refreshed;
      return runEval(context);
    }
    if (options.command === "scan" || options.command === "run") {
      const scanned = await scan(loaded, store, scanOptions);
      if (!scanned.ok) return scanned;
      const { candidates, added, resolved, reopened } = scanned.data;
      progress(
        options,
        `Scan complete: ${candidates} candidates. ${added} new, ${reopened} reopened, ${resolved} no longer reported.`,
      );
      if (options.command === "scan") return ok({ exitCode: EXIT.ok, json: scanned.data });
    }
    if (options.command === "judge" || options.command === "run") {
      const judged = await runJudge(context);
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
    return await runReport(context);
  } finally {
    await release.data();
  }
};

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
          store: openStore(loaded.data.dataDir),
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
