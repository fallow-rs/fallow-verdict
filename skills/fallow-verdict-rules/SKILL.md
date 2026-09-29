---
name: fallow-verdict-rules
description: Help a user write project review rules as sentences in the fallow-verdict config. First check whether a deterministic Fallow rule, such as boundaries, rule packs or health thresholds, can express the rule, and prefer that. Propose the change; the user applies it. Use when asked to add a code review rule, a team convention, an architecture rule or a coding standard that fallow-verdict review mode or Fallow should check.
license: MIT
---

# Write review rules

A review rule is one sentence in the fallow-verdict config. Review mode asks Jev whether each
function in the scope of the rule breaks it. A model answer costs money and can be wrong.
A deterministic Fallow rule is free, fast and gives the same result each time. Thus a rule goes
to Fallow when Fallow can express it.

## Rules

1. Run `--dry-run` first. Show the estimated cost to the user and wait for a yes.
2. Pass `--fail-on off` to each real run and to each `report`.
3. Parse `--format json --quiet` output. Use the `actions` arrays of `run`, `report` and
   `check`. Take commands and options only from `npx fallow-verdict <command> --help`. Do not
   invent options.
4. Config, suppressions, review rules, thresholds and `close` go to the user for a decision.
   Propose the exact change. Do not write the config file until the user says yes.
5. Never run fallow-verdict in a hook that fires on each commit or each assistant turn.
6. The Jev key is in `TYPESAFE_API_KEY`. Never ask the user to paste the key into the chat.
   The dry run works without a key. When the real run fails with `engine_auth_failed`, tell the
   user to set `TYPESAFE_API_KEY` in their environment, and stop.

## Steps

1. Ask the user for the rule in one sentence, and for the files it covers.
2. Check the Fallow options first. See [references/rules.md](references/rules.md).
   - Import direction between parts of the code: Fallow `boundaries`.
   - A banned call, import or side effect: a Fallow rule pack.
   - Function size or complexity: Fallow `health` thresholds.
3. When Fallow can express the rule, propose the Fallow config change. Stop there.
4. Otherwise, write a review rule: `name`, `where`, optional `except`, and `ensure`.
   `ensure` states what a function in scope must do, in one factual sentence.
5. Show the proposed rule to the user. After a yes, the user adds it, or you add it on request.
6. Try the rule on a small scope. Show the cost first:

   ```bash
   npx fallow-verdict run --kind review <path> --dry-run --fail-on off --format json --quiet
   npx fallow-verdict run --kind review <path> --fail-on off --format json --quiet
   npx fallow-verdict report --kind review --fail-on off --format json --quiet
   ```

7. Show the breaches with their probability. When the results are wrong, propose a clearer
   sentence or a narrower `where`. The user decides.
