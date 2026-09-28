# Security triage: details

## Scope

- The whole project: no path.
- Changed files only: add `--changed-since <ref>`, for example the base branch of the PR.
- Some files or directories: give the paths after the options.
- A cost limit: add `--limit <n>` or `--max-cost-usd <usd>` to the real run.

## Output of the dry run

`npx fallow-verdict run --dry-run --fail-on off --format json --quiet` prints one object. Show `pending`,
`estimatedUsd` and `maxConfirmationUsd` to the user. `maxConfirmationUsd` is the upper bound of
the second calls that confirm a dismissal. Its `actions` array has one `run` action: the same
command without `--dry-run`. Run that command after a yes from the user.

## Fields of `report`

`npx fallow-verdict report --fail-on off --format json --quiet` prints `fallow-verdict-report/v1`.

| Field                   | Use                                                                       |
| ----------------------- | ------------------------------------------------------------------------- |
| `summary`               | Counts: `survivors`, `needsHumanReview`, `dismissed`, `pending`, `errors` |
| `finding_id`            | The id for `check` and `close`                                            |
| `path`, `line`, `col`   | The location                                                              |
| `category`              | For example `sql-injection`                                               |
| `decision.verdict`      | `survivor`, `needs-human-review` or `dismissed`                           |
| `decision.confidence`   | The decision confidence                                                   |
| `decision.reason`       | Why. Show it with each finding.                                           |
| `decision.fixDirection` | A fix hint, or null                                                       |

## Actions of `run` and `report`

The report output of `run` and `report` has an `actions` array. Each action has `type`,
`auto_fixable` (always `false`), `description`, `command` and, for one finding, `finding_id`.

| Type    | When                                         | Next step                         |
| ------- | -------------------------------------------- | --------------------------------- |
| `judge` | Findings are pending or failed               | Tell the user. Run it after a yes |
| `check` | A survivor or a `needs-human-review` finding | Run it after a fix                |
| `close` | A `needs-human-review` finding               | Send it to the user. Never run it |

Dismissed and closed findings have no action.

`pending` or `errors` above zero means an incomplete run. Tell the user. A run with incomplete
assessments exits 2, also with `--fail-on off`.

## The check loop

`npx fallow-verdict check <finding-id> --format json --quiet` reruns Fallow and judges the
current source. It writes no state. A file path is also a valid target.

| Exit code | Meaning                                              | Next step                          |
| --------- | ---------------------------------------------------- | ---------------------------------- |
| `0`       | Cleared: resolved, dismissed or closed               | Stop. Report the result.           |
| `1`       | The finding stands                                   | Fix again, then check again.       |
| `2`       | Error: invalid input, failed Fallow run, failed call | Read `error`. Report it.           |
| `3`       | A person must decide                                 | Stop. Send the result to the user. |

- Exit 0 after a dismissal is "likely noise", not "safe". Say so in the report.
- A check that needs an assessment calls Jev. Estimate first with `--dry-run` when the user
  asks for a cost limit.
- The `actions` array lists the next steps. `rerun-check` and `scan` are safe to run.
  A `close` action goes to the user: never run it yourself.
- Stop after three fix attempts on one finding and ask the user.

## After the loop

Run `npx fallow-verdict run --fail-on off --format json --quiet` again, or `scan`, to save the
new state. `check` does not save state.
