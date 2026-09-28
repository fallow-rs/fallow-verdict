---
name: fallow-verdict-similar-code
description: Consolidate functions that do the same job with different code. Fallow similar-code finds candidate pairs, fallow-verdict asks Jev whether a merge is safe, and the tests and a new discovery prove each merge. Use when asked to merge similar or duplicated functions, reduce near-duplicate code, or act on fallow similar-code candidates in TypeScript or JavaScript.
license: MIT
---

# Consolidate similar functions

Fallow finds pairs of functions that can do the same job. fallow-verdict asks Jev three
questions about each pair: same responsibility, same behavior, safe to merge. You merge only
the pairs that Jev marks safe, and the tests prove each merge.

## Rules

1. Run `--dry-run` first. Show the estimated cost to the user and wait for a yes.
2. Pass `--fail-on off` to each real run.
3. Parse `--format json --quiet` output. Take commands and options only from
   `npx fallow-verdict --help`. Do not invent options.
4. Config, suppressions, thresholds and `close` go to the user for a decision.
5. Never run fallow-verdict in a hook that fires on each commit or each assistant turn.
6. The Jev key is in `TYPESAFE_API_KEY`. Never ask the user to paste the key into the chat.

## Prerequisites

- `fallow` and `fallow-verdict` are in the project: `npm install --save-dev fallow-verdict fallow`.
- `fallow similar-code` needs a local model. The download needs a decision by a person. Run
  `fallow similar-code status --format json --quiet`. When the model is not ready, tell the user
  to run `fallow similar-code setup --local` and stop. Never run the setup yourself.

## Loop

1. Exact clones need no verdict. Run `fallow dupes --format json --quiet` and merge those
   clones with the normal tests.
2. Estimate the cost. fallow-verdict runs the discovery itself:

   ```bash
   npx fallow-verdict run --kind similar-code --dry-run --format json --quiet
   ```

3. After a yes from the user, run the assessment and read the report:

   ```bash
   npx fallow-verdict run --kind similar-code --fail-on off --format json --quiet
   npx fallow-verdict report --kind similar-code --format json --quiet
   ```

4. Select the findings where `decision.kindData.refactor_safe` is `true`. Sort them by
   `decision.probabilities.refactor_safe`, highest first. Do not merge any other pair.
5. Merge one pair at a time, only inside the scope of the task. Keep the callers unchanged.
6. After each merge, run the tests of the project. Then run the discovery again (step 2 and
   step 3). A failed test stops the loop: undo the merge or fix it.
7. Report to the user: the pairs you merged, the test result, and the pairs that need a person.

Details, report fields and stop conditions: [references/loop.md](references/loop.md).

## What a verdict is not

A verdict is a model estimate, not proof. The tests and a new Fallow discovery are the proof.
A `needs-human-review` pair goes to the user. `fallow-verdict check` exits 3 for most merged
pairs, because only a complete discovery can resolve a pair. That is expected.
