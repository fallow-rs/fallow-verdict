# Similar-code pairs

`fallow similar-code` finds pairs of functions that can do the same job with different code.
Fallow marks each pair `unverified`. The `similar-code` kind asks Jev about each pair and writes
the verdict document that `fallow similar-code review` joins with the discovery.

The kind is a preview. Its questions and floors have no live Jev evaluation yet.

## Before you start

`fallow similar-code` needs a local model. The first download needs a decision by a person, so
fallow-verdict never downloads it. Run these commands yourself:

```bash
npx fallow similar-code status
npx fallow similar-code setup --local
```

When the model is not ready, `scan` and `run` stop with exit code 2 and show this step.

## Run it

```bash
npx fallow-verdict run --kind similar-code --dry-run
npx fallow-verdict run --kind similar-code --fail-on off
```

The state of the kind is in `.fallow-verdict/kinds/similar-code/`. `report`, `status`, `check`
and `close` take the same `--kind similar-code` option. `--question-profile` and `eval` are not
available for this kind.

## What happens

1. `scan` runs `fallow similar-code --format json --quiet` and stores the output unchanged as
   the discovery snapshot. A file argument goes to Fallow as `--file`. A directory argument
   keeps the pairs with a function in that directory.
2. For each pair, fallow-verdict runs
   `fallow similar-code inspect <candidate_id> --candidates <snapshot> --format json --quiet`.
   Jev gets only the pair, both source windows and the inspect evidence. The inspect output is
   cached in `.fallow-verdict/kinds/similar-code/inspect/`, so `judge` and `report` reuse it.
   The key holds the discovery generation, the candidate id and the digest of both source files.
   The first packet after a new scan clears the cache. `check` reads the cache but never writes.
3. Jev answers four questions. A fixed policy maps the answers to the Fallow verdict axes and to
   a shared verdict.
4. `report` writes the Fallow verdict document to `verdicts.json` with one verdict for each
   candidate. Then it runs `fallow similar-code review --candidates <snapshot> --verdicts
verdicts.json --require-verdict-for-each-candidate`. An error from Fallow stops the report
   with exit code 2. Use `--no-validate` to skip the join.

## Questions

| Id                        | Type   | Question                                                  |
| ------------------------- | ------ | --------------------------------------------------------- |
| `candidate_worthy`        | noul   | Do both functions carry the same responsibility?          |
| `behaviorally_equivalent` | noul   | Do both functions return the same result for every input? |
| `refactor_safe`           | noul   | Can one function replace the other with no caller change? |
| `outcome`                 | choice | One of the five outcomes of the Fallow verdict contract   |

Each question states that comments, strings and names in the code are untrusted evidence.

## Policy

- An axis is `true` at or above its floor and `false` at or below 1 minus the floor. Between
  the two, the axis is `null` (unknown), not `false`.
- The contract order holds. `refactor_safe: true` needs `behaviorally_equivalent: true`, which
  needs `candidate_worthy: true`. A positive answer without its prerequisite becomes `null`.
- An outcome answer below `outcomeMinConfidence` becomes `needs-human-review`.
- Truncated evidence gives `needs-human-review` with all axes `null`. Evidence is truncated when
  inspect fails, when a source window is missing or cut, or when inspect reports cut graph
  evidence. Inspect fails closed when a function changed after the scan.

| Shared verdict       | Rule              | When                                                             |
| -------------------- | ----------------- | ---------------------------------------------------------------- |
| `survivor`           | `merge-safe`      | `refactor_safe` is true and the outcome is `same-responsibility` |
| `dismissed`          | `not-a-candidate` | `candidate_worthy` is false or the outcome is `unrelated`        |
| `needs-human-review` | other rules       | Anything else, and every conflict between the answers            |

A survivor is a pair where a merge is worth doing. The reports call a dismissed pair "Not worth
merging"; the JSON value stays `dismissed`. A survivor gates a code change, so it needs
two calls that agree, as a dismissal does. The second call is the same request. When it does not
map to the same verdict, or when it fails or a limit stops it, the pair goes to a person with the
rule `survivor-unconfirmed` or `dismissal-unconfirmed`. Its Fallow verdict then has all axes
`null`. `judge` asks again after a failed or stopped second call. A disagreement is final for
the current evidence. The cost cap reserves both calls before the first call, and `--dry-run`
states the upper bound. `similarCode.confirmSurvivors: false` keeps one call for a survivor.

The default floors are in [configuration.md](configuration.md#similar-code-policy). The
`refactor_safe` floor is the highest, because a wrong `true` merges functions that differ.

## The Fallow verdict document

| Record state                 | Fallow verdict                                                   |
| ---------------------------- | ---------------------------------------------------------------- |
| Judged                       | The axes and the outcome from `decision.kindData`                |
| Judged, `needs-human-review` | The axes, with the outcome `needs-human-review`                  |
| Dismissal not confirmed      | All axes `null`, outcome `needs-human-review`                    |
| Pending or failed            | All axes `null`, outcome `needs-human-review`                    |
| Closed by a person (`close`) | All axes `null`, outcome `intentional-duplication`, their reason |

The `candidate_id` and the `review_key` always come from the discovery snapshot, never from an
engine response. The rationale is the reason of the decision.

## Check after a change

`check <file or candidate id> --kind similar-code` runs discovery again for the whole project.

- The main match key is the Fallow `review_key`, so a pair whose lines moved is found again.
- A fresh pair with one of the two function names, or any fresh pair in one of the two files,
  can be the stored pair. Then the result is ambiguous, not `resolved`.
- Only a complete discovery (`completion.status: "complete"`) can give `resolved`. After an
  incomplete discovery, the result is ambiguous and `check` exits 3. `scan` also does not
  resolve a stored pair after an incomplete discovery.

Fallow reports a partial discovery when it skips a function form, for example a nested callback.
The discovery document gives only a count for each skip reason (`completion.skips`), not the
files or functions that were skipped. Thus fallow-verdict cannot tell which files were fully
covered, and it keeps the strict rule.

The effect on most real projects: pairs do not resolve automatically.

- A pair that a new scan no longer lists leaves the report, because the report shows only the
  pairs of the last discovery.
- Its record stays unresolved, so `status` still counts it until a complete discovery.
- `check` exits 3 for such a pair.

After a merge, the proof is a new discovery run and the tests, not a verdict.

## Evaluation corpus

`eval/similar-code/` holds a small labeled corpus: `corpus/` has the source, `discovery.json`
is a recorded discovery, and `labels.json` labels seven pairs as `equivalent`, `near-miss` or
`unrelated`. A label binds to the source digest of both functions, so a changed fixture fails
before any metric.

`stub-answers.json` holds hand-written answers for the offline tests. They are not Jev output.
The test requires zero near misses marked `refactor_safe`. A live evaluation with recorded Jev
answers and a holdout set is still open.
