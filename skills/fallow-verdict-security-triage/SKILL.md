---
name: fallow-verdict-security-triage
description: Triage fallow security candidates with Jev verdicts. Report likely vulnerabilities first, send uncertain findings to a person, and confirm each fix with fallow-verdict check. Use when asked to triage, verify or fix fallow security findings, review SAST candidates, or check whether a security fix removed a finding in TypeScript or JavaScript.
license: MIT
---

# Triage security findings

`fallow security` reports candidates: code that can be vulnerable. fallow-verdict asks Jev
about each candidate and sorts it into `survivor` (likely vulnerable), `needs-human-review` or
`dismissed` (likely noise). This skill reports. It changes code only when the user asks for a fix.

## Rules

1. Run `--dry-run` first. Show the estimated cost to the user and wait for a yes.
2. Pass `--fail-on off` to each real run and to each `report`.
3. Parse `--format json --quiet` output. Use the `actions` arrays of `run`, `report` and
   `check`. Take commands and options only from `npx fallow-verdict <command> --help`. Do not
   invent options.
4. Config, suppressions, thresholds and `close` go to the user for a decision.
5. Never run fallow-verdict in a hook that fires on each commit or each assistant turn.
6. The Jev key is in `TYPESAFE_API_KEY`. Never ask the user to paste the key into the chat.
   The dry run works without a key. When the real run fails with `engine_auth_failed`, tell the
   user to set `TYPESAFE_API_KEY` in their environment, and stop.

## Loop

1. Estimate the cost:

   ```bash
   npx fallow-verdict run --dry-run --fail-on off --format json --quiet
   ```

2. After a yes from the user, run the command of the `run` action of the dry run. It is the
   same command without `--dry-run`. Then read the report:

   ```bash
   npx fallow-verdict run --fail-on off --format json --quiet
   npx fallow-verdict report --fail-on off --format json --quiet
   ```

3. Report survivors first, then `needs-human-review`, then the count of dismissed findings.
   Give the path, the line, the category, the confidence and `decision.reason` for each.
   A `judge` action in the report means that assessments are incomplete. Tell the user.
4. When the user asks for a fix, fix one finding. Then run the `check` action of that finding:

   ```bash
   npx fallow-verdict check <finding-id> --format json --quiet
   ```

5. Repeat the fix and the check until `check` exits 0 or 3. Exit 3 goes to the user.

Details and exit codes: [references/triage.md](references/triage.md).

## A dismissal is not proof of safety

- A verdict can move a finding from "keep" to "likely noise". It never marks code as safe.
- The tool can mark a finding `dismissed`. That means "likely noise". Say "likely noise,
  confirm" for a dismissed finding, never "safe" or "not vulnerable".
- Never suppress a finding, close a finding, delete code or change a threshold because of a
  dismissal without the user. Send the `close` action to the user.
