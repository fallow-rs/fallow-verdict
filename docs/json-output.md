# JSON output and actions

Pass `--format json` to get one JSON object on standard output. Add `--quiet` to hide the
progress messages on standard error. The JSON Schemas are in `schemas/`.

| Command                   | Output                                       | Schema                                                |
| ------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| `report`, `status`, `run` | The report, `fallow-verdict-report/v1`       | [`report.schema.json`](../schemas/report.schema.json) |
| `judge`, `run --dry-run`  | The assessment summary and the cost estimate | [`judge.schema.json`](../schemas/judge.schema.json)   |
| `check`                   | The check report, `fallow-verdict-check/v1`  | [`check.schema.json`](../schemas/check.schema.json)   |
| Any command, on an error  | `{ "error": true, code, message, hint }`     | None                                                  |

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

A command names `--kind <name>` for a kind other than `security`.

### Actions of the report

| Type    | When                                                    | Command                                         |
| ------- | ------------------------------------------------------- | ----------------------------------------------- |
| `judge` | At least one finding is pending or has a failed request | `fallow-verdict judge`                          |
| `check` | For each survivor and each `needs-human-review` finding | `fallow-verdict check <id>`                     |
| `close` | For each `needs-human-review` finding                   | `fallow-verdict close <id> --reason "<reason>"` |

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

The actions of `check` are in [check.md](check.md).

## Help for each command

`fallow-verdict <command> --help` and `fallow-verdict help <command>` print the usage, the options
and the exit codes of that command. `fallow-verdict --help` prints the overview of all commands
and options. An option that a command does not accept is an error with exit code 2, for example
`status --dry-run`.
