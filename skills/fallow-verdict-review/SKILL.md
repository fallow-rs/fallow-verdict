---
name: fallow-verdict-review
description: Review a branch before a pull request. Fallow selects the risky functions in the changed files, and fallow-verdict asks Jev about likely bugs, functions that do not do what their name says, and breaches of project rules. Report only, with a confidence for each result. Use when asked for a pre-PR review, a review of changed code, or a check of changes against the project review rules in TypeScript or JavaScript.
license: MIT
---

# Review a branch before a pull request

Fallow selects the functions to read: every function in the changed files, and the complexity
hotspots. fallow-verdict asks Jev whether each function has a bug, does what its name states,
and follows the project rules. Each result is a model estimate with a probability, never a
Fallow fact.

## Rules

1. Run `--dry-run` first. Show the estimated cost to the user and wait for a yes.
2. Pass `--fail-on off` to each real run and to each `report`.
3. Parse `--format json --quiet` output. Use the `actions` array of `check`. Take commands and
   options only from `npx fallow-verdict --help`. Do not invent options.
4. Config, suppressions, review rules, thresholds and `close` go to the user for a decision.
5. Never run fallow-verdict in a hook that fires on each commit or each assistant turn.
6. The Jev key is in `TYPESAFE_API_KEY`. Never ask the user to paste the key into the chat.
   The dry run works without a key. When the real run fails with `engine_auth_failed`, tell the
   user to set `TYPESAFE_API_KEY` in their environment, and stop.

## Loop

1. Find the base branch of the pull request, for example `main`.
2. Estimate the cost:

   ```bash
   npx fallow-verdict run --kind review --changed-since <base> --dry-run --format json --quiet
   ```

3. After a yes from the user, run the review and read the report:

   ```bash
   npx fallow-verdict run --kind review --changed-since <base> --fail-on off --format json --quiet
   npx fallow-verdict report --kind review --fail-on off --format json --quiet
   ```

4. Report the survivors, highest probability first: the function, the line, the reason and the
   probability. Group them as likely bugs, claim mismatches and rule breaches.
5. Do not edit code. The user decides what to fix.
6. After the user or you fix a function on request, suggest the check:

   ```bash
   npx fallow-verdict check <file> --kind review --format json --quiet
   ```

Report fields and wording: [references/results.md](references/results.md).

## How to word the results

- Say "likely bug (72%)", never "bug". Say "no likely problem", never "correct" or "safe".
- A function without a likely problem is not reviewed code. It only means that no probability
  reached its floor.
