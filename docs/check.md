# Check and close

`check` and `close` support an edit loop. A developer or a coding assistant changes the code,
then runs `check` until it exits `0`. The Fallow rerun is the proof that a finding is gone, not
the verdict.

## `check <target>`

```bash
npx fallow-verdict check <finding-id>
npx fallow-verdict check src/routes/user.ts
npx fallow-verdict check src/routes/user.ts --dry-run --format json
```

A target is a finding id from the last saved scan, or a file path. A file target covers all
current findings in that file. The command accepts `--kind`, `--dry-run`, `--format`,
`--config` and `--question-profile`.

Steps:

1. Rerun Fallow for the kind, scoped to the files of the target.
2. Find each stored finding in the fresh output. See [relocation](#relocation).
3. A finding that Fallow no longer reports is `resolved`. There is no Jev call. Before this
   result, Fallow runs once more for the whole project. See [relocation](#relocation).
4. A finding that a person closed stays `closed` while its evidence fingerprint is the same.
5. Build the packet from the current source on disk and judge it with the normal policy.
   The two-call rule applies: a dismissal needs a second call that agrees. `check` has no
   cost cap, so a dismissal always gets its second call. A disagreed or failed second call
   gives `needs-human-review` with the rule `dismissal-unconfirmed`, so exit code `3`.

`check` writes no state. It does not change records, candidates, reports or runs, and it takes
no lock. Run `scan` or `run` to save the new state.

A Jev API key is necessary only when a finding needs an assessment. A check that finds only
resolved or closed findings works without a key.

With `--dry-run`, the command prints the estimate and sends nothing to Jev. Each finding that
needs an assessment has the status `not-assessed`. The estimate also states an upper bound for
the confirmation calls, as `judge` does: one more call for each finding.

### Exit codes

| Exit code | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `0`       | Cleared: each finding is resolved, dismissed or closed. Also a dry run.     |
| `1`       | A finding stands: Jev assessed it as a survivor.                            |
| `2`       | An error: invalid input, a failed Fallow run, or a failed assessment.       |
| `3`       | A finding needs a person: `needs-human-review`, or an ambiguous relocation. |
| `130`     | The command was interrupted.                                                |

When the results differ, the most severe result sets the exit code, in this order: `2`, `1`,
`3`, `0`. A finding that stands comes before a result that needs a person, because the code
must change in either case. Read `results` to find the findings that need a person.

A dry run exits `0` when no result is an error or needs a person. The findings that need an
assessment are still open. Read `outcome`, which is `estimated` in that case.

### Relocation

A security finding id contains the line and the column. An edit above a finding thus changes
its id. `check <id>` does not conclude `resolved` only because the id moved.

Each kind supplies a match key without the parts of the location that an edit moves. For
security, the key is the rule (finding kind and category), the path, the sink (category and
callee) and the evidence text. The rules:

- A fresh finding with the same key and the same id is the stored finding.
- One fresh finding with the same key is the stored finding at a new location. This applies
  only when the last scan had no other finding with that key in the file.
- More than one possible match is ambiguous. The result is `ambiguous`, with exit code `3`.
- No fresh finding with the same key: a fresh finding with the same id is the stored finding
  with changed evidence text, unless another stored finding has its key.
- Otherwise the check runs Fallow for the whole project and compares the similar keys. For
  security, one similar key leaves out the evidence text: Fallow adds optional prefixes to it,
  for example when it finds a source trace. The other similar key leaves out the path, for a
  renamed file. A fresh finding that shares a similar key is a possible match, and the result
  is `ambiguous`. A fresh finding with the id and the key of another stored finding is that
  finding, unchanged, so it is not a possible match.
- Only when there is no possible match is the finding `resolved`.

The scoped run cannot see a renamed file, so the run for the whole project is necessary. It
happens only when a finding would be `resolved`. For security, a scoped run already analyzes
the whole project and filters the findings, so the second run takes about the same time.

## `close <id> --reason "<text>"`

```bash
npx fallow-verdict close <finding-id> --reason "The input comes from a fixed list."
```

`close` records a judgment by a person. `--reason` is required. The finding id must be in the
last saved scan, and Fallow must still report the finding.

The last scan holds line positions. `close` runs Fallow for the files of the finding, and the
fresh output must report the same id with the same evidence fingerprint. Otherwise the code
changed after the last scan, and `close` refuses with `config_invalid`. Run `scan`, then close
the finding with its current id. Thus a closure never binds to other code.

The record gets a `closed` field with the time, the reason and the evidence fingerprint. The
history gets an entry with `rule: "closed-by-person"`, `by: "person"` and the reason. The Jev
decision stays on the record.

A closed finding stays closed until its evidence fingerprint changes. An edit inside the
evidence windows changes the fingerprint. `report` then removes the closure, and the finding
is back in its verdict group. `check` compares the fingerprint of the current source. `scan`,
`judge` and `run` also remove a stale closure when they read the finding.

`report` shows closed findings in a separate section, "Closed by a person". They do not count
toward `--fail-on`. The JSON report has `summary.closed` and `closed` only when a finding is
closed.

`judge` and `run` skip a closed finding while its evidence fingerprint is the same. There is no
Jev request, and the plan and the dry-run estimate do not count it, also with `--rejudge`.
When the fingerprint changes, the finding is judged again, and `report` removes the closure.

The verdict export (`fallow-security-verdicts/v1`) gives a closed finding the verdict
`dismissed`. Fallow accepts free text in `reason`, so `reason` is
`Closed by a person: <reason>`. `dismissal_reason` is `closed-by-person`, and `confidence` is
`1.00`. Fallow accepts `dismissal_reason` but does not validate or render it.

## JSON contract: `fallow-verdict-check/v1`

`check --format json` prints one object. The JSON schema is
[`schemas/check.schema.json`](../schemas/check.schema.json).

| Field            | Meaning                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `schema_version` | `fallow-verdict-check/v1`                                                                              |
| `kind`           | The analysis kind                                                                                      |
| `target`         | `{ type: "finding" \| "path", value }`. A path is project-relative.                                    |
| `dry_run`        | True for `--dry-run`                                                                                   |
| `outcome`        | `cleared`, `stands`, `needs-person`, `error` or `estimated`                                            |
| `exit_code`      | `0`, `1`, `2` or `3`                                                                                   |
| `estimate`       | Estimated `input_tokens` and `usd`, and `max_confirmation_usd`: the upper bound for confirmation calls |
| `usage`          | Recorded `input_tokens` and `cost_usd` of the requests that were sent                                  |
| `results`        | One entry for each finding. See below.                                                                 |
| `actions`        | Next steps in Fallow style. See below.                                                                 |

Each result has:

| Field        | Meaning                                                                       |
| ------------ | ----------------------------------------------------------------------------- |
| `status`     | `resolved`, `closed`, `judged`, `ambiguous`, `not-assessed` or `error`        |
| `finding_id` | The id in the fresh Fallow output. Null for `resolved` and `ambiguous`.       |
| `stored_id`  | The id in the last saved scan. Null for a finding that the scan did not have. |
| `locations`  | Current locations, or the saved locations of a resolved finding               |
| `category`   | The finding category, or null                                                 |
| `verdict`    | `survivor`, `dismissed` or `needs-human-review` for `judged`, otherwise null  |
| `rule`       | The policy rule that fired, or null                                           |
| `confidence` | The decision confidence, or null                                              |
| `reason`     | The decision reason, the closure reason, or why there is no assessment        |
| `matches`    | The fresh ids that match. More than one only for `ambiguous`.                 |
| `error`      | `{ code, message }` for `error`, otherwise null                               |

A `finding_id` that differs from `stored_id` means that the finding moved.

Each action has `type`, `auto_fixable` (always `false`), `description` and `command`:

| Type          | When                                                | Command                                         |
| ------------- | --------------------------------------------------- | ----------------------------------------------- |
| `rerun-check` | The outcome is not `cleared`                        | `fallow-verdict check <target>`                 |
| `close`       | An open finding with the same id as the scan        | `fallow-verdict close <id> --reason "<reason>"` |
| `scan`        | An open finding that moved, is new, or is ambiguous | `fallow-verdict scan`                           |

A `close` action also has `finding_id`. Replace `<reason>` before you run it. A coding
assistant must not close a finding without a person: send the action to the user.
