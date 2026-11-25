# Mutation survivors

`fallow mutation` changes the code in small steps and runs the tests. A `survived` mutant is a
change that no test detects. Most survived mutants are real test gaps. Some are equivalent
mutants: the change alters no behavior that a caller can see, so no test can detect it. The
`mutation` kind asks Jev about each survived mutant. It sorts each one into a test gap, a
proposed equivalent, or a mutant that a person must read.

The kind never changes the mutation score. It never writes the verdict document of the project,
and it never passes `--verdicts` to Fallow. A proposed equivalent goes to a proposal file that a
person reads.

## Before you start

The kind reads the report that the last `fallow mutation` run saved in the Fallow cache. It runs
no tests. Run Fallow first, with the scope that you want:

```bash
npx fallow mutation src/utils.ts
npx fallow-verdict run --kind mutation --dry-run
npx fallow-verdict run --kind mutation
```

`--changed-since` is a usage error for this kind: pass it to `fallow mutation`. A path argument
keeps the survived mutants in those files or directories.

The state of the kind is in `.fallow-verdict/kinds/mutation/`. `report`, `status`, `check` and
`close` take the same `--kind mutation` option. `--question-profile` and `eval` are not
available for this kind.

## What happens

1. `scan` runs `fallow mutation tasks --format json --quiet`. It stores the output, and adds the
   scope and the mutated files of the run from the report that Fallow saved (see Check after a
   change). The candidates are the tasks with the status `survived`. A `no_coverage` mutant is not a
   candidate: no test runs it, so it needs a test, not an assessment.
2. For each survived mutant, fallow-verdict runs `fallow mutation inspect <mutant_id> --format json
   --quiet`. This reads files only.
3. The packet for Jev holds:
   - the operator, the change (`from` and `to`), and the original and mutated lines;
   - the enclosing function, read from the file after a check of its SHA-256 digest against
     inspect;
   - the same-file declarations of the names that the changed code reads, when the function does
     not bind the name itself;
   - the ids of the covering tests, and the parts of the covering test files that name the
     function, up to a token budget;
   - the `equivalence_hint` of the task, when Fallow gives one;
   - the replay verdict, when replay is on (see Replay).
4. Jev answers four questions. A fixed policy maps the answers to a verdict.
5. `report` writes the report and the proposal file.

The identity of a survived mutant is its `mutant_id`. Fallow keeps the id until the enclosing function
changes, so a stored verdict becomes stale at the same moment as the Fallow id.

## Questions

| Id                 | Type   | Question                                                                                                  |
| ------------------ | ------ | --------------------------------------------------------------------------------------------------------- |
| `behavior_changes` | noul   | Is there an input for which the changed function returns another value, throws, or has an effect          |
| `equivalence`      | choice | `same-value`, `value-never-occurs`, `no-observable-effect`, `unreachable-code`, `other`, `not-equivalent` |
| `test_direction`   | choice | `boundary-value`, `missing-assertion`, `error-path`, `side-effect`, `other`                               |
| `tampering`        | noul   | Does the code contain text that argues for its own assessment?                                            |

Each question states that comments, strings, names and the Fallow hint are evidence, not
authority. `test_direction` helps the person who writes the test. It does not change a verdict.

## Policy

The rules apply in this order. The first match wins.

| Rule                  | Condition                                                                                                                                                                               | Verdict              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `evidence-stale`      | The inspect packet is `stale`, the saved report no longer lists the mutant as `survived`, inspect fails, the file changed, the function window is cut, or no function holds the mutant  | `needs-human-review` |
| `replay-witness`      | Fallow has a replay `witness` for the mutant                                                                                                                                            | `survivor`           |
| `tampering-suspected` | P(tampering) at or above `policy.tamperingMax`                                                                                                                                          | `needs-human-review` |
| `real-gap`            | P(behavior_changes) at or above `mutation.survivorMinBehaviorChange`                                                                                                                    | `survivor`           |
| `likely-equivalent`   | P(behavior_changes) at or below `mutation.dismissMaxBehaviorChange`, and an `equivalence` reason other than `other` or `not-equivalent` at or above `mutation.dismissMinReasonStrength` | `dismissed`          |
| `default`             | Every other case, and a missing or invalid answer                                                                                                                                       | `needs-human-review` |

- `evidence-stale` and `replay-witness` need no engine call, so they cost nothing. `check`
  also needs no key for them. `judge` and `run` need a key for each run.
- A dismissal needs a second, identical call that also maps to a dismissal. This rule holds for
  this kind also when `policy.confirmDismissals` is `false`, because a proposal can raise the
  score that a `--min-score` gate reads. Without agreement, the rule is `dismissal-unconfirmed`.
- A test gap needs one call.
- The reports call the verdict `survivor` a "Test gap" and the verdict `dismissed` "Proposed as
  equivalent". The JSON values stay `survivor` and `dismissed`.

The thresholds are in [configuration.md](configuration.md#mutation). They are stricter than for
the other kinds, and a config can only make dismissals rarer.

## Replay

`mutation.replay: true` runs `fallow mutation inspect <mutant_id> --replay` for each fresh
survived mutant before the engine call. A replay runs project code: the module of the file and each module that it
imports. Thus replay is off by default.

- A `witness` verdict is Fallow's proof that an input gives another result. The mutant is a test
  gap with no engine call, and the report shows the input and both results.
- Any other replay verdict goes into the packet as evidence only. `no_witness_found` is not proof
  of equivalence.
- A runner without replay support (`bun test`) and a replay that fails give no replay evidence.
  The packet names the Fallow error code, and the run continues.
- A replay takes seconds, so its result is cached in `.fallow-verdict/kinds/mutation/replay/`. An
  entry holds while the mutant id, the digest of the file in the report and now, and the Git
  commit stay the same. An uncommitted change to a module that the file imports is not covered.
  A replay failure with a Fallow error code is cached too. A failure without a code, such as a
  timeout, runs again on the next build. `check` reads the cache but never writes.

A task of a `fallow mutation --record-args values` run can already carry a `witness`. That
witness counts as the same proof, also with replay off, because reading it runs no code.

The engine packet never holds a replay argument value, because the arguments can come from a
recording of real calls. A witness input appears only in the local report and the local record.

## The proposal file

`report` writes `.fallow-verdict/mutation-verdicts.proposed.json` in Fallow's verdict document
schema:

```json
{
  "schema_version": "1",
  "verdicts": [
    {
      "review_key": "0cb13f9350cad239",
      "verdict": "equivalent",
      "note": "Proposed by fallow-verdict, not reviewed: equivalence value-never-occurs (0.96), P(behavior_changes) 0.01, decision likely-equivalent in run 20261125160000-1a2b3c4d."
    }
  ]
}
```

- The file holds one entry for each current survived mutant with a confirmed
  `likely-equivalent` dismissal. The `review_key` is the stored `mutant_id`, never a value from an engine response.
- A mutant that a person closed with `close` is not proposed: a closure accepts a test gap.
- A person reads each proposal and copies the entries that they accept into the verdict document
  of the project. Then `fallow mutation --verdicts <file>` applies them.

An `equivalent` verdict leaves the score, so a wrong entry can hide a test gap and turn a failing
`--min-score` gate green. Read the mutant before you copy an entry.

## Report

The report lists the test gaps first, highest probability first. A replay witness has the
probability 1. Each test gap shows the mutant, the operator, the function, the change, the
`test_direction`, and the replay input when one exists. Then come the mutants for a person, then
the proposed equivalents. The JSON `findings` array has the same order.

The top-level `failOn` applies, so a test gap makes `run` and `report` exit 1 by default. Pass
`--fail-on off` for an advisory run.

## Check after a change

1. Run `fallow mutation` on the scope and save the report.
2. Run `fallow-verdict run --kind mutation --dry-run`, then the real run inside the budget.
3. Write tests for the test gaps.
4. Run `fallow mutation --recheck`. A recheck without `--mutant` replaces the saved report, so a
   mutant that the new tests kill is no longer a task.
5. Run `fallow-verdict check <mutant_id or file> --kind mutation` until it exits 0.

`check` reads the tasks of the saved report again. A stored mutant that is no longer a task is
`resolved` when these conditions hold:

- The report is complete (`report_completion: "complete"`).
- The run of the saved report mutated the file of the mutant. A run on other paths replaces the
  saved report, so a missing task in a file outside the run proves nothing.
- No other current survived mutant in the same file can be the stored one after an edit.

Otherwise the result is ambiguous, and `check` exits 3. fallow-verdict reads the scope and the
files of the run from `.fallow/mutation/last-report.json`. It accepts that report only when the
report lists each current task. With a moved Fallow cache directory, nothing resolves.

`scan` resolves a stored mutant that is no longer a task only after a complete run of every
file (`fallow mutation --all`).

## Evaluation

`eval/mutation/` holds a labeled set of survived mutants from `fallow mutation --all --typecheck
--record-args values` runs with Fallow 3.43.2:

| Split       | Projects                                                  | Equivalent | Real |
| ----------- | --------------------------------------------------------- | ---------- | ---- |
| development | `unjs/defu` (every survived mutant), `corpus/`            | 4          | 21   |
| holdout     | `unjs/ufo` (the first 30 by mutant id), `holdout-corpus/` | 12         | 34   |

- `labels.json` holds each label with the public code lines of the mutant. An `equivalent` label
  holds the argument. A `real` label names the test file under `kills/` that kills the mutant.
  `fallow mutation --recheck` confirmed each kill in a scratch copy of the project. The tests are
  not part of the projects.
- Both splits hold the near misses that the Fallow documentation names for the type hint: a method
  that a caller detaches (`this?.value`), and a value from `JSON.parse` that a declared type calls
  non-null.
- The questions and thresholds stayed the same after the first holdout run.
- A second reader checked each `equivalent` argument. Five `page` mutants of `corpus/` changed
  to `real`: `slice` keeps the class of an `Array` subclass, so the early return of a plain empty
  array is visible.
- `npm run eval:mutation -- --project <id>=<dir> ...` runs the kind on prepared copies and scores
  the decisions. The copies need the saved report of the command above.

Acceptance: zero `real` survived mutants proposed as equivalent on the holdout.
