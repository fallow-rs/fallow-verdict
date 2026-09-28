# Pre-PR review: details

## Scope

| Scope                   | Functions                                                      |
| ----------------------- | -------------------------------------------------------------- |
| `--changed-since <ref>` | Every function in a file changed since `<ref>`, and hotspots   |
| Paths                   | Every function in the named files or directories, and hotspots |
| No scope                | Complexity hotspots of the whole project                       |

The config key `review.maxUnits` (default 50) limits the functions per scan, highest risk first.
To limit the cost of one run, add `--limit <n>` or `--max-cost-usd <usd>`. A change to
`review.maxUnits` is a config change: ask the user.

## Output of the dry run

`npx fallow-verdict run --kind review --changed-since <base> --dry-run --format json --quiet`
prints one object. Show `pending` (functions to assess) and `estimatedUsd` to the user.

## Fields of `report`

`npx fallow-verdict report --kind review --format json --quiet` prints
`fallow-verdict-report/v1`. Each entry of `findings` is one function.

| Field                    | Use                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `finding_id`             | The unit id: path, function name and a source hash                                   |
| `path`, `line`           | The location                                                                         |
| `category`               | Why it is in scope: `changed`, `path` or a hotspot level                             |
| `decision.verdict`       | `survivor` (likely problem), `dismissed` (no likely problem) or `needs-human-review` |
| `decision.rule`          | `has-bug`, `claim-mismatch`, `rule-breach`, or another rule                          |
| `decision.probabilities` | `has_bug`, `does_what_it_claims` and one `rule_<name>` per project rule              |
| `decision.reason`        | The reason. Show it with each result.                                                |
| `decision.kindData`      | `claimMismatch` and `breaches` when more than one reason applies                     |

A `needs-human-review` result with the rule `source-changed` or `truncated-evidence` means that
the evidence was not complete. Tell the user. Do not guess.

## What to report

1. Likely bugs (`has-bug`), highest `has_bug` probability first.
2. Claim mismatches (`claim-mismatch`): the name or comment says one thing, the code does another.
3. Rule breaches (`rule-breach`): name the rule and quote its sentence from the config.
4. The count of functions with no likely problem.
5. Results that need a person.

Keep each result to one or two sentences. Do not repeat the source.

## After a fix

`npx fallow-verdict check <file> --kind review --format json --quiet` lists every function in
the file and judges each changed function again. It writes no state.

| Exit code | Meaning                                                    |
| --------- | ---------------------------------------------------------- |
| `0`       | No likely problem remains in the target                    |
| `1`       | A likely problem remains                                   |
| `2`       | Error                                                      |
| `3`       | A person must decide, for example after a deleted function |

A `close` action in the `actions` array goes to the user. Never close a result yourself.
A Fallow suppression comment also removes a function from the output. Never add one to make a
check pass.
