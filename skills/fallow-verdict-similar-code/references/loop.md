# Similar-code loop: details

## Output of `run`

`npx fallow-verdict run --kind similar-code --dry-run --format json --quiet` prints one object.
Show these fields to the user before the real run:

| Field                | Meaning                                                 |
| -------------------- | ------------------------------------------------------- |
| `pending`            | Pairs that need an assessment                           |
| `estimatedUsd`       | Estimated cost of the first call for each pair          |
| `maxConfirmationUsd` | Upper bound of the second calls that confirm a decision |
| `fatal`              | Null, or the error that stopped the run                 |

Exit code 2 with a message about the local model means that the model is not ready
(`model_ready: false` in `fallow similar-code status --format json --quiet`). Tell the
user to run `fallow similar-code setup --local`, and stop.

To limit the cost, add `--limit <n>` or `--max-cost-usd <usd>` to the real run.

The default `similarCode.failOn` is `off`, but the project config can change it. Thus always pass
`--fail-on off` in this skill, as for every kind.

## Fields of `report`

`npx fallow-verdict report --kind similar-code --fail-on off --format json --quiet` prints
`fallow-verdict-report/v1`. Each entry of `findings` is one pair:

| Field                                       | Use                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `finding_id`                                | The Fallow candidate id of the pair                                  |
| `locations`                                 | Both functions: `path`, `line`, `col`                                |
| `decision.verdict`                          | `survivor` (merge is worth it), `dismissed`, or `needs-human-review` |
| `decision.kindData.refactor_safe`           | `true`, `false` or `null` (unknown)                                  |
| `decision.kindData.behaviorally_equivalent` | `true`, `false` or `null`                                            |
| `decision.kindData.candidate_worthy`        | `true`, `false` or `null`                                            |
| `decision.probabilities.refactor_safe`      | The model estimate for the sort order                                |
| `decision.reason`                           | The rationale. Show it to the user with each merge.                  |

`null` means unknown. It never means `false` and it never means `true`.

## Which pairs to merge

- Merge a pair only when `decision.verdict` is `survivor` (rule `merge-safe`). A survivor has
  `refactor_safe: true` and the outcome `same-responsibility`, confirmed by two calls that agree.
- `refactor_safe: true` alone is not enough. When the outcome does not agree, the policy gives
  `needs-human-review` (rule `answers-conflict`). Send that pair to the user.
- A pair with `needs-human-review` goes to the user with its `decision.reason`.
- A `dismissed` pair is "not worth merging". Do not merge it, and do not suppress it.

## Shared review keys

Two candidates can share one Fallow review key, for example when a function has a verbatim copy
in another file. Fallow accepts one verdict for each review key. The report then adds a note with
the number of candidates and keys.

- Treat the candidates of a shared key as one decision. Merge them only when the verdict of the
  key is `survivor`.
- When the candidates of a key have different verdicts, the verdict has all axes `null` and the
  outcome `needs-human-review`. Send it to the user.
- Fallow reports the other candidates of the key as `unverified`. That is expected.

## How to merge

- Keep one function and point the callers of the other function to it, or extract a shared
  function. Keep the public signature of an exported function.
- Do not change behavior. When the two functions differ for an input, the pair is not safe.
  Stop and tell the user.
- Merge only inside the scope of the task. Tell the user about safe pairs outside the scope.

## Proof after a merge

1. Run the tests of the project.
2. Run the discovery again with `run --kind similar-code`. The merged pair must be gone from
   the report. The report shows only the pairs of the last discovery.
3. `npx fallow-verdict check <finding-id> --kind similar-code --format json --quiet` exits 3
   for most merged pairs. Only a complete discovery can resolve a pair, and Fallow often skips
   some function forms. Do not treat exit 3 as a failed merge. The tests and the new discovery
   are the proof.

## Stop and ask the user

- The local model is not ready.
- The dry-run cost is higher than the user expects.
- A test fails after a merge and the cause is not clear.
- A safe pair touches a public API or code outside the task scope.
- A pair has `needs-human-review`.
- A pair needs `close`. Only the user decides to close: `npx fallow-verdict close <id> --reason "<text>"`.
