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

export const HELP = `fallow-verdict: verdicts for fallow security candidates

Usage
  fallow-verdict <command> [options] [paths...]

Commands
  init      Write a starter config and ignore the state directory
  scan      Run \`fallow security\` and record the candidates (free, no engine calls)
  judge     Ask the decision engine about pending candidates
  report    Render verdicts and write the fallow verdicts file
  run       scan, judge, and report in one go
  status    Show what is recorded, without running anything
  eval      Score stored verdicts against a labels file

Options
  --config <path>          Config file (default: nearest fallow-verdict.config.*)
  --question-profile <p>   generic | category (experimental destination-specific questions)
  --cwd <path>             Directory to start from
  --format <human|json>    Output format (default: human)
  --quiet                  Suppress progress output
  --changed-since <ref>    Limit the scan to files changed since a git ref
  --rejudge                Judge again even when the evidence is unchanged
  --dry-run                Build packets and estimate cost, call nothing
  --limit <n>              Judge at most n candidates
  --max-cost-usd <usd>     Stop before estimated request spend passes this amount
  --max-duration <seconds> Stop after this long
  --fail-on <level>        off | survivor | needs-human-review (default: survivor)
  --show-dismissed         List dismissed candidates in human output
  --no-validate            Skip post-validation by \`fallow security survivors\`
  --labels <path>          Labels file for \`eval\`
  -h, --help               Show this help
  --version                Show the version

Exit codes
  0 no verdict at or above --fail-on   1 verdicts at or above --fail-on
  2 invalid input, execution error, or incomplete judgment   130 interrupted
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
