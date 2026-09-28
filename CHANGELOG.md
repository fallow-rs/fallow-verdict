# Changelog

## Unreleased

- Stop the run at once when Jev reports that the account is out of credits (HTTP 402), with the new error code `engine_out_of_credits`. It was retried like an outage.
- Space Jev requests under `engine.requestsPerMinute` (default 1,000) across all workers, so large runs stay below the documented limit of 1,200 requests per minute.
- Default `engine.model` to the versioned `jev-1.13.0` instead of the `jev-latest` alias. Stored decisions made with the alias need one fresh assessment.
- Add help for each command: `fallow-verdict <command> --help` and `fallow-verdict help <command>` print the usage, the options and the exit codes of that command. `--help` alone still prints the overview. One table defines the options of each command, and the parser and the help both read it.
- An option that a command does not accept is now a usage error with exit code 2 that names the command, for example `status --dry-run`. Before, the command ignored the option.
- Add a Fallow-style `actions` array to the JSON output of `report`, `status` and `run`: a `judge` action when findings are pending or failed, a `check` action for each survivor and each `needs-human-review` finding, and a `close` action for each of these findings, as `check` gives. Only a person can close a finding. See [JSON output and actions](docs/json-output.md).
- Add an `actions` array to the JSON output of `judge` and `run --dry-run`. A dry run gives the same command without `--dry-run`. A real `judge` gives `judge` while findings are pending, then `report`.
- Add the JSON schemas `report.schema.json` and `judge.schema.json` for these outputs. `check.schema.json` does not change.
- The skills use the `actions` arrays of `run` and `report`, and pass `--fail-on off` to the dry run, so that its `run` action is the real command. The skills test checks each option in a skill against the help of the named command.
- Add four skills for coding assistants in `skills/`: `fallow-verdict-similar-code`, `fallow-verdict-security-triage`, `fallow-verdict-review` and `fallow-verdict-rules`. The npm package ships them. A test keeps every command, option and kind in the skills in step with `fallow-verdict --help`. See the "Skills" section of the README.
- Add staged npm releases with OIDC, artifact verification, and checks before creating release tags.
- Add `--kind <name>` to select the Fallow analysis. `security` is the only kind and the default, so behavior does not change.
- Store the analysis kind on each finding record. Records without it load as `security` records.
- Store the analysis kind on each run record. Run records without it load as `security` runs.
- Keep the state of each kind other than `security` in `.fallow-verdict/kinds/<kind>/`, with its own lock. Security state stays at the root, so existing state needs no migration.
- Allow more than one location per finding record (`locations`), a null `severity` and kind-specific evidence summary fields in the record schema for kinds other than `security`. Security records do not change, and they still need a severity and the full evidence summary.
- Reject `--question-profile` and `eval` with exit code 2 for a kind that does not support them.
- Require two engine calls that agree before a candidate is dismissed. A disagreement, a failed second call or a budget stop gives `needs-human-review` with the new rule `dismissal-unconfirmed`. Records store the second answer set in `confirmationAnswers`.
- Add `policy.confirmDismissals` (default `true`). Set it to `false` to keep the single-call behavior for evaluation comparisons.
- Count the confirmation call in record usage, run cost and the cost cap. Each candidate reserves the cost of both calls before its first call, so a candidate starts only when the cap leaves room for both. The plan and `--dry-run` state an upper bound for confirmation calls.
- Stop the run when the confirmation call fails with a rejected key or an open circuit, as for the first call.
- A policy remap of a record without a confirming answer set, for example a record from before this change, gives `needs-human-review` instead of `dismissed`. `judge` treats a stored dismissal without a second answer set as pending and asks again, also after a failed second call; `report` alone shows the review verdict. Only a disagreement is final for the current evidence.
- Report `dismissalsUnconfirmed` in `eval` output, split into `disagreed` and `notConfirmed`.
- Add `check <target>` for an edit loop. It reruns Fallow for one finding id or one file, reports `resolved` with no Jev call when the finding is gone, and otherwise judges the current source with the normal policy. It writes no state. It exits 0 when cleared, 1 when a finding stands, 2 on an error and 3 when a finding needs a person. `--dry-run` prints the estimate, with the upper bound for confirmation calls, and sends nothing. The two-call rule for dismissals applies, so a disagreed or failed confirmation gives exit code 3.
- `check` follows a finding that an edit moved. It matches the finding by rule, path, sink and evidence text, and reports an ambiguous match as "needs a person", never as `resolved`. `resolved` needs a clean project: any fresh finding with the same rule anywhere, or any fresh finding in the original file, gives exit code 3, unless an unchanged saved finding claims it. `check` runs Fallow once, for the whole project. A failed Fallow run exits 2. A rejected key or an open circuit exits 2 and stops further assessments.
- Add the `fallow-verdict-check/v1` JSON schema with Fallow-style `actions`.
- Add `close <id> --reason "<text>"` to record a judgment by a person. A closed finding stays closed until its evidence fingerprint changes. `report` shows closed findings in a separate section, and they do not count toward `--fail-on`. `judge` and `run` do not send a closed finding to Jev while its evidence is the same. The verdict export for Fallow gives it the verdict `dismissed`, with the reason of the person. `close` refuses a finding whose code changed after the last scan. `scan`, `judge` and `run` remove a closure whose evidence changed.
- Add the optional `closed` field to finding records, and the optional `by` and `reason` fields to history entries.
- Add review mode (`--kind review`, advisory). It selects the functions that `fallow health` reports as complexity hotspots, plus every function in the files of `--changed-since` or the given paths, highest risk first and capped by `review.maxUnits` (default 50). Jev answers `has_bug`, `where`, `severity`, `does_what_it_claims` and one question per project rule in one request per function. See [review mode](docs/review.md).
- Add the `review` config section: `maxUnits`, `bugFloor`, `claimFloor`, `ruleFloor`, `rules` (`name`, `where`, `except`, `ensure`, `floor`), `confirmDismissals` (default `false`) and `failOn` (default `off`).
- Let a kind set its own dismissal confirmation and `failOn` default. Security keeps `policy.confirmDismissals` and the top-level `failOn`.
- `check` names the target files in its Fallow run (`exhaustiveIn`), so a kind that selects candidates lists every candidate in these files. A kind can state that its output is not conclusive for these files; `check` then gives `ambiguous`, never `resolved`. The reason of an `ambiguous` result now tells which case applies.
- Let a kind name `dismissed` in its reports. Review mode says "No likely problem". The JSON value stays `dismissed`.
- Add the `similar-code` kind (preview). `--kind similar-code` judges `fallow similar-code` pairs with four questions, maps the answers to the Fallow verdict axes with confidence floors and the contract order, and joins the verdicts with `fallow similar-code review --require-verdict-for-each-candidate`. Truncated inspect evidence gives `needs-human-review`. fallow-verdict never runs `fallow similar-code setup`. See `docs/similar-code.md`.
- Add the `similarCode.policy` config section with the floors of the `similar-code` kind.
- A `similar-code` survivor needs a second call that agrees, as a dismissal does. Otherwise the pair gets `needs-human-review` with the new rule `survivor-unconfirmed`. Add `similarCode.confirmSurvivors` (default `true`). The cost reservation and the dry-run bound cover the second call.
- Cache `fallow similar-code inspect` output in `.fallow-verdict/kinds/similar-code/inspect/`, so `judge` and `report` reuse it. A new scan clears the cache, and `check` never writes to it.
- Let a kind state that Fallow did not finish a scan (`scan.complete`). Then `scan` resolves no stored findings. Similar-code uses it and `scan.conclusive` for an incomplete discovery, so neither `scan` nor `check` resolves a pair after it. Security and review do not change.
- Let a kind ask for a second call that agrees before a survivor stands (`confirmSurvivors`), next to its dismissal confirmation. Security and review do not change.
- Similar-code reports name `dismissed` "Not worth merging". The JSON value stays `dismissed`.
- Similar-code: export one verdict for each review key. Candidates that share a key (a verbatim copy of a function) get one verdict, which abstains when their verdicts differ. The Fallow join then runs without `--require-verdict-for-each-candidate`, and the report states why and how many candidates share a key.
- Similar-code: the inspect cache and the evidence fingerprint also cover the caller, callee and test files that inspect names, the CODEOWNERS files and the Git commit.
- Similar-code does not fail a run by default (`similarCode.failOn: "off"`). `--fail-on` overrides it.
- `check` and `close` build packets for a fresh Fallow run read-only, so a kind cache is never written from them.
- Let a kind add notes to the report (`export.notes`).
- Let a kind word the upper bound for confirmation calls in the plan and in `check --dry-run`. Security keeps "Dismissal confirmation calls can add up to". Similar-code says "Confirmation calls (dismissals and merge recommendations) can add up to". A kind that confirms nothing shows no line.

## 0.1.0 (2026-09-23)

First npm release, available as a development preview.

- Document npm installation and compatibility with saved preview records.
- Separate mandatory reviews from uncertain assessments in evaluation summaries.

- Preserve source columns in saved findings and reports so separate sinks on one line remain distinguishable; show the pending-assessment instruction once per report.
- Reject duplicate or missing finding IDs before replacing scan state or judging candidates.
- Preserve completed comparison answers and recorded cost during interruptions; stop requests when checkpoint storage fails.
- Include matching top-level Fallow attack-surface evidence and controls in v2 verifier packets; invalidate decisions made with older packets.
- Label defensive controls as observations from files on the trace, with applicability to the sink unproven.
- Distinguish mandatory review from inconclusive model assessments in terminal and Markdown reports.

- Rewrite terminal messages and reports with plain-language verdicts, labeled model estimates, and expandable assessment details.

- Initial pipeline: `scan`, `judge`, `report`, `run`, `status`, `eval`, `init`.

- Invalidate outdated decisions before budget stops and before reporting or evaluation.
- Require readable, valid evidence locations and reject oversized packets before calling Jev.
- Account for concurrent request costs before persisting results, and preserve active state locks.
- Return execution errors for incomplete runs and model failures.
- Add a labeled development corpus, live evaluation runner, and CLI contract tests with real fallow.

- Add an opt-in category question profile for SSRF and open redirects, with content-based cache invalidation.
- Publish fresh paired Jev comparisons, frozen questions, and a separately authored pilot holdout.
- Reject empty, duplicate, and drifted evaluation labels; withhold rates for incomplete evaluations.
- Include decision reasons and incomplete judgments in human and Markdown reports.
