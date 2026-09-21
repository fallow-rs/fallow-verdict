import { parseArgs } from "node:util";

import { err, ok, type Result } from "../util/result.ts";
import { verdictError, type VerdictError } from "../util/errors.ts";

export const COMMANDS = ["init", "scan", "judge", "report", "run", "status", "eval"] as const;
export type CommandName = (typeof COMMANDS)[number];

export type CliOptions = {
  command: CommandName;
  positionals: string[];
  config?: string | undefined;
  cwd: string;
  format: "human" | "json";
  quiet: boolean;
  changedSince?: string | undefined;
  rejudge: boolean;
  dryRun: boolean;
  limit?: number | undefined;
  maxCostUsd?: number | undefined;
  maxDurationMs?: number | undefined;
  failOn?: "off" | "survivor" | "needs-human-review" | undefined;
  showDismissed: boolean;
  validate: boolean;
  labels?: string | undefined;
  questionProfile?: "generic" | "category" | undefined;
};

export const HELP = `fallow-verdict: assess security findings with Jev

Usage
  fallow-verdict <command> [options] [paths...]

Commands
  init      Create a config file and add the state directory to .gitignore
  scan      Find security candidates with fallow (no Jev requests)
  judge     Assess pending candidates with Jev
  report    Show saved verdicts and write Markdown and JSON reports
  run       Scan the project, assess candidates, and write reports
  status    Show saved results
  eval      Compare saved verdicts with labeled examples

Options
  --config <path>            Config file (default: nearest fallow-verdict.config.*)
  --question-profile <name>  generic | category (default: generic)
                             category uses experimental SSRF and open-redirect questions
  --cwd <path>               Directory to start from
  --format <human|json>      Output format (default: human)
  --quiet                    Hide progress messages
  --changed-since <ref>      Scan files changed since a Git ref
  --rejudge                  Assess candidates again, even with unchanged evidence
  --dry-run                  Prepare evidence and estimate cost without calling Jev
  --limit <n>                Assess at most n candidates
  --max-cost-usd <usd>       Limit estimated request cost
  --max-duration <seconds>   Limit assessment time
  --fail-on <level>          off | survivor | needs-human-review (default: survivor)
                             survivor means likely vulnerability in the report
  --show-dismissed           Include dismissed candidates in the terminal report
  --no-validate              Skip validation by fallow security survivors
  --labels <path>            Labeled examples for eval
  -h, --help                 Show this help
  --version                  Show the version

Exit codes
  0    Command completed without a failing verdict
  1    Findings meet --fail-on, or eval found a dismissed vulnerability
  2    Invalid input, execution failed, or assessments are incomplete
  130  Interrupted
`;

const positiveNumber = (
  name: string,
  raw: string | undefined,
): Result<number | undefined, VerdictError> => {
  if (raw === undefined) return ok(undefined);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? ok(value)
    : err(verdictError("config_invalid", `--${name} expects a positive number, got \`${raw}\`.`));
};

export type ParsedCli =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "command"; options: CliOptions };

export const parseCli = (argv: readonly string[]): Result<ParsedCli, VerdictError> => {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        config: { type: "string" },
        "question-profile": { type: "string" },
        cwd: { type: "string" },
        format: { type: "string" },
        quiet: { type: "boolean" },
        "changed-since": { type: "string" },
        rejudge: { type: "boolean" },
        "dry-run": { type: "boolean" },
        limit: { type: "string" },
        "max-cost-usd": { type: "string" },
        "max-duration": { type: "string" },
        "fail-on": { type: "string" },
        "show-dismissed": { type: "boolean" },
        "no-validate": { type: "boolean" },
        labels: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (cause) {
    return err(
      verdictError("config_invalid", cause instanceof Error ? cause.message : String(cause)),
    );
  }

  const { values, positionals } = parsed;
  if (values.version) return ok({ kind: "version" });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === "help") return ok({ kind: "help" });
  if (!(COMMANDS as readonly string[]).includes(command)) {
    return err(
      verdictError(
        "config_invalid",
        `Unknown command \`${command}\`.`,
        "Run `fallow-verdict --help`.",
      ),
    );
  }
  const format = values.format ?? "human";
  if (format !== "human" && format !== "json") {
    return err(
      verdictError("config_invalid", `--format must be human or json, got \`${format}\`.`),
    );
  }
  const failOn = values["fail-on"];
  if (
    failOn !== undefined &&
    failOn !== "off" &&
    failOn !== "survivor" &&
    failOn !== "needs-human-review"
  ) {
    return err(
      verdictError("config_invalid", `--fail-on must be off, survivor, or needs-human-review.`),
    );
  }
  const limit = positiveNumber("limit", values.limit);
  if (!limit.ok) return limit;
  const maxCostUsd = positiveNumber("max-cost-usd", values["max-cost-usd"]);
  if (!maxCostUsd.ok) return maxCostUsd;
  const maxDuration = positiveNumber("max-duration", values["max-duration"]);
  if (!maxDuration.ok) return maxDuration;

  const questionProfile = values["question-profile"];
  if (
    questionProfile !== undefined &&
    questionProfile !== "generic" &&
    questionProfile !== "category"
  )
    return err(verdictError("config_invalid", "--question-profile must be generic or category."));

  return ok({
    kind: "command",
    options: {
      command: command as CommandName,
      positionals: rest,
      config: values.config,
      cwd: values.cwd ?? process.cwd(),
      format,
      quiet: values.quiet ?? false,
      changedSince: values["changed-since"],
      rejudge: values.rejudge ?? false,
      dryRun: values["dry-run"] ?? false,
      limit: limit.data === undefined ? undefined : Math.floor(limit.data),
      maxCostUsd: maxCostUsd.data,
      maxDurationMs: maxDuration.data === undefined ? undefined : maxDuration.data * 1000,
      failOn,
      showDismissed: values["show-dismissed"] ?? false,
      validate: !(values["no-validate"] ?? false),
      labels: values.labels,
      questionProfile,
    },
  });
};
