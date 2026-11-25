---
name: fallow-verdict-mutation
description: Close the test gaps that fallow mutation finds. fallow-verdict asks Jev which survived mutants are test gaps. You write tests for the gaps, and fallow mutation --recheck proves each test. Use when asked to act on mutation survivors, to triage survived mutants, or to find equivalent mutants in TypeScript or JavaScript.
license: MIT
---

# Close mutation test gaps

`fallow mutation` reports mutants that no test detects. fallow-verdict sorts each survived
mutant into a test gap, a proposed equivalent, or a mutant that a person must read. You write tests for the
test gaps. `fallow mutation --recheck` is the proof, not the verdict.

## Rules

1. Run `--dry-run` first. Show the estimated cost to the user and wait for a yes.
2. Pass `--fail-on off` to each real run and to each `report`.
3. Parse `--format json --quiet` output. Use the `actions` arrays of `run`, `report` and
   `check`. Take commands and options only from `npx fallow-verdict <command> --help`. Do not
   invent options.
4. Never copy a proposed equivalent into the verdict document of the project. A proposal goes
   to the user. Only the user decides that a mutant is equivalent.
5. Never set `mutation.replay` yourself. A replay runs project code, so the user decides.
6. Config, suppressions, thresholds and `close` go to the user for a decision.
7. Never run fallow-verdict in a hook that fires on each commit or each assistant turn.
8. The Jev key is in `TYPESAFE_API_KEY`. Never ask the user to paste the key into the chat.
   The dry run works without a key. When the real run fails with `engine_auth_failed`, tell the
   user to set `TYPESAFE_API_KEY` in their environment, and stop.

## Prerequisites

- `fallow` and `fallow-verdict` are in the project: `npm install --save-dev fallow-verdict fallow`.
- The project runs its tests with Vitest, `node:test` or `bun test`.

## Scope

The task scope is the set of paths that the user named. Write tests only for mutants in that
scope. Change only test files. Report mutants outside the scope to the user.

## Loop

1. Run the mutants on the scope. This runs the tests of the project:

   ```bash
   npx fallow mutation src/utils.ts --format json --quiet
   ```

2. Estimate the cost, then wait for a yes:

   ```bash
   npx fallow-verdict run --kind mutation --dry-run --fail-on off --format json --quiet
   ```

3. Run the command of the `run` action of the dry run. Then read the report:

   ```bash
   npx fallow-verdict run --kind mutation --fail-on off --format json --quiet
   npx fallow-verdict report --kind mutation --fail-on off --format json --quiet
   ```

4. Select the findings where `decision.verdict` is `survivor`. They come first, highest
   `decision.confidence` first. `decision.kindData.test_direction` names the kind of test.
   When `decision.kindData.witness` is present, its `input` and `original` give a ready test:
   call the function with the input and assert the original result.
5. Write one test for each test gap, in the test files of the project. Run the tests.
6. Run `npx fallow mutation --recheck`. A mutant that the new test kills is gone from the
   tasks. Then run `npx fallow-verdict check <mutant_id> --kind mutation --format json --quiet`.
7. Report these items to the user:
   - the tests that you wrote, and the recheck result;
   - the mutants that need a person;
   - the proposed equivalents in `.fallow-verdict/mutation-verdicts.proposed.json`.

## What a verdict is not

A verdict is a model estimate, not proof. A proposed equivalent changes nothing until the user
copies it into the verdict document. A wrong proposal hides a test gap and raises the mutation
score. A `needs-human-review` mutant goes to the user with its
`decision.reason`. The recheck and the tests are the proof.
