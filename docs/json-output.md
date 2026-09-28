# JSON output and actions

Pass `--format json` to get one JSON object on standard output. Add `--quiet` to hide the
progress messages on standard error. The JSON Schemas are in `schemas/`.

| Command                   | Output                                              | Schema                                                |
| ------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| `report`, `status`, `run` | The report, `fallow-verdict-report/v1`              | [`report.schema.json`](../schemas/report.schema.json) |
| `judge`, `run --dry-run`  | The assessment summary and the cost estimate        | [`judge.schema.json`](../schemas/judge.schema.json)   |
| `check`                   | The check report, `fallow-verdict-check/v1`         | [`check.schema.json`](../schemas/check.schema.json)   |
| Any command, on an error  | `{ "error": true, code, message, hint, exit_code }` | None                                                  |

## Actions

The outputs of `report`, `status`, `run`, `judge` and `check` have an `actions` array. It lists
the next steps in the Fallow style. A coding assistant can run a command from an action and does
not need to build one. Each action has these fields:

| Field          | Meaning                                                          |
| -------------- | ---------------------------------------------------------------- |
| `type`         | The kind of step. See below.                                     |
| `auto_fixable` | Always `false`. A person or a coding assistant runs the command. |
| `description`  | What the step does, and who must do it                           |
| `command`      | The command line to run                                          |
| `finding_id`   | The finding that the step is for. Absent for a project step.     |

### How a command is built

Each command starts with the invocation that ran fallow-verdict. The CLI reads it from the
`npm_config_user_agent` variable that package managers set:

| Agent                               | Invocation                 |
| ----------------------------------- | -------------------------- |
| pnpm                                | `pnpm exec fallow-verdict` |
| Yarn                                | `yarn fallow-verdict`      |
| Bun                                 | `bunx fallow-verdict`      |
| npm, `npx`, `npm exec`, or no agent | `npx fallow-verdict`       |

A dev dependency is not on the `PATH`, so a direct call also gives `npx fallow-verdict`. That
invocation also finds a global install.

Then come the command, its arguments, and the context options of the command that made the
output: `--kind` (for a kind other than `security`), `--question-profile`, `--config` and
`--cwd`. An action repeats an option only when its command accepts it. For example, `close` has
no `--question-profile`. The tables below leave out the invocation and the context options.

A dry run gives the same arguments without `--dry-run`, after the invocation.

### Actions of the report

| Type    | When                                                    | Command                                         |
| ------- | ------------------------------------------------------- | ----------------------------------------------- |
| `judge` | At least one finding is pending or has a failed request | `fallow-verdict judge`                          |
| `check` | For each survivor and each `needs-human-review` finding | `fallow-verdict check <id>`                     |
| `close` | For each survivor and each `needs-human-review` finding | `fallow-verdict close <id> --reason "<reason>"` |

The `judge` action comes first. The finding actions follow the order of `findings`. Dismissed
findings and closed findings have no action.

Only a person can close a finding. A coding assistant must send a `close` action to the user
and never run it. Replace `<reason>` with the reason of the person.

### Actions of `judge` and of a dry run

| Type     | When                                          | Command                            |
| -------- | --------------------------------------------- | ---------------------------------- |
| `run`    | After `run --dry-run`                         | The same command without --dry-run |
| `judge`  | After `judge --dry-run` with pending findings | The same command without --dry-run |
| `judge`  | After `judge` when findings are still pending | `fallow-verdict judge`             |
| `report` | After `judge`                                 | `fallow-verdict report`            |

The command without `--dry-run` sends requests to Jev. Show the estimate of the dry run to the
user before you run it.

The actions of `check` are in [check.md](check.md). They follow the same rules.

## Errors

With `--format json`, an error prints one JSON object on standard output, also for a usage
error such as an unknown option. The object has `error: true`, the stable `code` (for example
`config_invalid`), `message`, an optional `hint` and `exit_code`. Standard error stays empty.

## Help for each command

`fallow-verdict <command> --help` and `fallow-verdict help <command>` print the usage, the options
and the exit codes of that command. `fallow-verdict --help` prints the overview of all commands
and options. An option that a command does not accept is an error with exit code 2, for example
`status --dry-run`.
