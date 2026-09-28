import { parseArgs } from "node:util";

import { ANALYSIS_KINDS, DEFAULT_KIND, parseKind, type AnalysisKind } from "../kinds/names.ts";
import { err, ok, type Result } from "../util/result.ts";
import { verdictError, type VerdictError } from "../util/errors.ts";

export const COMMANDS = [
  "init",
  "scan",
  "judge",
  "report",
  "run",
  "status",
  "eval",
  "check",
  "close",
] as const;
export type CommandName = (typeof COMMANDS)[number];

export type CliOptions = {
  command: CommandName;
  /** The arguments as given, used to print the same command again without `--dry-run`. */
  argv: readonly string[];
  analysisKind: AnalysisKind;
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
  /** The reason that a person gives with `close`. */
  reason?: string | undefined;
};

type OptionSpec = {
  type: "string" | "boolean";
  /** The value placeholder in the help, for example `<path>`. */
  value?: string;
  short?: "h";
  /** Help lines. The first line follows the option; the others go below it. */
  help: readonly string[];
};

/**
 * Every option, in help order. The parser and the help both read this table, so an option that
 * a command accepts is always in the help of that command.
 */
const OPTIONS = {
  config: {
    type: "string",
    value: "<path>",
    help: ["Config file (default: nearest fallow-verdict.config.*)"],
  },
  kind: {
    type: "string",
    value: "<name>",
    help: [
      "Fallow analysis to assess (default: security)",
      `Known kinds: ${ANALYSIS_KINDS.join(", ")}`,
    ],
  },
  "question-profile": {
    type: "string",
    value: "<name>",
    help: [
      "generic | category (default: generic)",
      "category uses experimental SSRF and open-redirect questions",
    ],
  },
  cwd: { type: "string", value: "<path>", help: ["Directory to start from"] },
  format: { type: "string", value: "<human|json>", help: ["Output format (default: human)"] },
  quiet: { type: "boolean", help: ["Hide progress messages"] },
  "changed-since": { type: "string", value: "<ref>", help: ["Scan files changed since a Git ref"] },
  rejudge: {
    type: "boolean",
    help: ["Assess candidates again, even with unchanged evidence"],
  },
  "dry-run": {
    type: "boolean",
    help: ["Prepare evidence and estimate cost without calling Jev"],
  },
  limit: { type: "string", value: "<n>", help: ["Assess at most n candidates"] },
  "max-cost-usd": { type: "string", value: "<usd>", help: ["Limit estimated request cost"] },
  "max-duration": { type: "string", value: "<seconds>", help: ["Limit assessment time"] },
  "fail-on": {
    type: "string",
    value: "<level>",
    help: [
      "off | survivor | needs-human-review",
      "(default: survivor; review mode: off)",
      "survivor means likely vulnerability in the report",
    ],
  },
  "show-dismissed": {
    type: "boolean",
    help: ["Include dismissed candidates in the terminal report"],
  },
  "no-validate": { type: "boolean", help: ["Skip validation by fallow security survivors"] },
  labels: { type: "string", value: "<path>", help: ["Labeled examples for eval"] },
  reason: { type: "string", value: "<text>", help: ["Reason for close (required)"] },
  help: { type: "boolean", short: "h", help: ["Show this help"] },
  version: { type: "boolean", help: ["Show the version"] },
} as const satisfies Record<string, OptionSpec>;

type OptionName = keyof typeof OPTIONS;

/** Options that every command accepts. They never appear in a command table. */
const GLOBAL_OPTIONS: readonly OptionName[] = ["help", "version"];

type CommandSpec = {
  summary: string;
  usage: string;
  options: readonly OptionName[];
  /** Exit codes and their meaning for this command. */
  exits: readonly (readonly [code: number, meaning: string])[];
};

const COMMON: readonly OptionName[] = ["config", "kind", "cwd", "format", "quiet"];
const COMMON_WITH_PROFILE: readonly OptionName[] = [
  "config",
  "kind",
  "question-profile",
  "cwd",
  "format",
  "quiet",
];
const BUDGET: readonly OptionName[] = [
  "rejudge",
  "dry-run",
  "limit",
  "max-cost-usd",
  "max-duration",
];
const REPORTING: readonly OptionName[] = ["fail-on", "show-dismissed", "no-validate"];

const INVALID = [2, "Invalid input or execution failed"] as const;
const INTERRUPTED = [130, "Interrupted"] as const;

const COMMAND_SPECS: Readonly<Record<CommandName, CommandSpec>> = {
  init: {
    summary: "Create a config file and add the state directory to .gitignore",
    usage: "fallow-verdict init [options]",
    options: ["cwd", "format", "quiet"],
    exits: [
      [0, "The config file was created"],
      [2, "Invalid input, or the config file exists"],
    ],
  },
  scan: {
    summary: "Find security candidates with fallow (no Jev requests)",
    usage: "fallow-verdict scan [options] [paths...]",
    options: [...COMMON, "changed-since"],
    exits: [[0, "The scan was saved"], INVALID, INTERRUPTED],
  },
  judge: {
    summary: "Assess pending candidates with Jev",
    usage: "fallow-verdict judge [options]",
    options: [...COMMON_WITH_PROFILE, ...BUDGET],
    exits: [
      [0, "All candidates have an assessment, or the dry run completed"],
      [2, "Invalid input, execution failed, or assessments are incomplete"],
      INTERRUPTED,
    ],
  },
  report: {
    summary: "Show saved verdicts and write Markdown and JSON reports",
    usage: "fallow-verdict report [options]",
    options: [...COMMON_WITH_PROFILE, ...REPORTING],
    exits: [
      [0, "No finding meets --fail-on"],
      [1, "Findings meet --fail-on"],
      [2, "Invalid input, execution failed, or assessments are incomplete"],
    ],
  },
  run: {
    summary: "Scan the project, assess candidates, and write reports",
    usage: "fallow-verdict run [options] [paths...]",
    options: [...COMMON_WITH_PROFILE, "changed-since", ...BUDGET, ...REPORTING],
    exits: [
      [0, "No finding meets --fail-on, or the dry run completed"],
      [1, "Findings meet --fail-on"],
      [2, "Invalid input, execution failed, or assessments are incomplete"],
      INTERRUPTED,
    ],
  },
  status: {
    summary: "Show saved results",
    usage: "fallow-verdict status [options]",
    options: [...COMMON, "show-dismissed"],
    exits: [[0, "The saved results were shown"], INVALID],
  },
  eval: {
    summary: "Compare saved verdicts with labeled examples",
    usage: "fallow-verdict eval --labels <path> [options]",
    options: [...COMMON_WITH_PROFILE, "labels"],
    exits: [
      [0, "No labeled vulnerability was dismissed"],
      [1, "A labeled vulnerability was dismissed"],
      [2, "Invalid input, execution failed, or assessments are incomplete"],
    ],
  },
  check: {
    summary: "Check one finding id or one file again after an edit (no state written)",
    usage: "fallow-verdict check <finding-id|path> [options]",
    options: [...COMMON_WITH_PROFILE, "dry-run"],
    exits: [
      [0, "The findings are resolved, dismissed or closed, or the dry run completed"],
      [1, "A finding stands"],
      [2, "Invalid input or execution failed"],
      [3, "A finding needs a person"],
      INTERRUPTED,
    ],
  },
  close: {
    summary: 'Record a judgment by a person: close <id> --reason "<text>"',
    usage: 'fallow-verdict close <finding-id> --reason "<text>" [options]',
    options: [...COMMON, "reason"],
    exits: [[0, "The judgment was recorded"], INVALID],
  },
};

const LABEL_WIDTH = 27;

const optionLines = (names: readonly OptionName[]): string[] =>
  names.flatMap((name) => {
    const spec: OptionSpec = OPTIONS[name];
    const flag = `${spec.short === undefined ? "" : `-${spec.short}, `}--${name}`;
    const label = spec.value === undefined ? flag : `${flag} ${spec.value}`;
    const [first = "", ...rest] = spec.help;
    return [
      `  ${label.padEnd(LABEL_WIDTH)}${first}`,
      ...rest.map((line) => `${" ".repeat(LABEL_WIDTH + 2)}${line}`),
    ];
  });

export const HELP = `fallow-verdict: assess security findings with Jev

Usage
  fallow-verdict <command> [options] [paths...]
  fallow-verdict <command> --help

Commands
${COMMANDS.map((name) => `  ${name.padEnd(10)}${COMMAND_SPECS[name].summary}`).join("\n")}

Options
${optionLines(Object.keys(OPTIONS) as OptionName[]).join("\n")}

Exit codes
  0    Command completed without a failing verdict
  1    Findings meet --fail-on, or eval found a dismissed vulnerability
  2    Invalid input, execution failed, or assessments are incomplete
  3    check only: a finding needs a person
  130  Interrupted

  check exits 0 when the findings are resolved, dismissed or closed, and 1 when a
  finding stands. See docs/check.md.
`;

/** The help of one command: its usage, the options that it accepts, and its exit codes. */
export const commandHelp = (command: CommandName): string => {
  const spec = COMMAND_SPECS[command];
  return `fallow-verdict ${command}: ${spec.summary}

Usage
  ${spec.usage}

Options
${optionLines([...spec.options, "help"]).join("\n")}

Exit codes
${spec.exits.map(([code, meaning]) => `  ${String(code).padEnd(5)}${meaning}`).join("\n")}

Run \`fallow-verdict --help\` for all commands.
`;
};

/** The help text for a command, or the overview for null. */
export const helpFor = (command: CommandName | null): string =>
  command === null ? HELP : commandHelp(command);

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
  | { kind: "help"; command: CommandName | null }
  | { kind: "version" }
  | { kind: "command"; options: CliOptions };

const isCommand = (name: string): name is CommandName =>
  (COMMANDS as readonly string[]).includes(name);

const unknownCommand = (name: string): VerdictError =>
  verdictError("config_invalid", `Unknown command \`${name}\`.`, "Run `fallow-verdict --help`.");

const PARSE_OPTIONS = Object.fromEntries(
  Object.entries(OPTIONS).map(([name, spec]: [string, OptionSpec]) => [
    name,
    spec.short === undefined ? { type: spec.type } : { type: spec.type, short: spec.short },
  ]),
) as { [Name in OptionName]: { type: (typeof OPTIONS)[Name]["type"] } };

/** A usage error for the first option that the command does not accept, or null. */
const rejectedOption = (command: CommandName, present: readonly string[]): VerdictError | null => {
  const accepted = new Set<string>([...COMMAND_SPECS[command].options, ...GLOBAL_OPTIONS]);
  const rejected = present.find((name) => !accepted.has(name));
  return rejected === undefined
    ? null
    : verdictError(
        "config_invalid",
        `\`${command}\` does not accept --${rejected}.`,
        `Run \`fallow-verdict ${command} --help\` for the options of ${command}.`,
      );
};

export const parseCli = (argv: readonly string[]): Result<ParsedCli, VerdictError> => {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: PARSE_OPTIONS });
  } catch (cause) {
    return err(
      verdictError("config_invalid", cause instanceof Error ? cause.message : String(cause)),
    );
  }

  const { values, positionals } = parsed;
  if (values.version) return ok({ kind: "version" });
  const [command, ...rest] = positionals;
  if (command === "help") {
    const target = rest[0];
    if (target === undefined) return ok({ kind: "help", command: null });
    return isCommand(target) ? ok({ kind: "help", command: target }) : err(unknownCommand(target));
  }
  if (command === undefined) return ok({ kind: "help", command: null });
  if (values.help) return ok({ kind: "help", command: isCommand(command) ? command : null });
  if (!isCommand(command)) return err(unknownCommand(command));
  const rejected = rejectedOption(command, Object.keys(values));
  if (rejected !== null) return err(rejected);

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

  const analysisKind = parseKind(values.kind ?? DEFAULT_KIND);
  if (!analysisKind.ok) return analysisKind;

  const questionProfile = values["question-profile"];
  if (
    questionProfile !== undefined &&
    questionProfile !== "generic" &&
    questionProfile !== "category"
  )
    return err(verdictError("config_invalid", "--question-profile must be generic or category."));

  const reason = values.reason?.trim();
  if (command === "close" && (reason === undefined || reason === ""))
    return err(
      verdictError(
        "config_invalid",
        "`close` needs --reason <text>.",
        "Say why a person accepts the finding.",
      ),
    );
  if ((command === "close" || command === "check") && rest.length !== 1)
    return err(
      verdictError(
        "config_invalid",
        command === "close"
          ? "`close` needs exactly one finding id."
          : "`check` needs exactly one target: a finding id or a file path.",
      ),
    );

  return ok({
    kind: "command",
    options: {
      command,
      argv: [...argv],
      analysisKind: analysisKind.data,
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
      reason,
    },
  });
};
