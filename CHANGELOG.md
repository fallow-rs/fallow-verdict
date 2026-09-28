# Changelog

## Unreleased

- Stop the run at once when Jev reports that the account is out of credits (HTTP 402), with the new error code `engine_out_of_credits`. It was retried like an outage.
- Space Jev requests under `engine.requestsPerMinute` (default 1,000) across all workers, so large runs stay below the documented limit of 1,200 requests per minute.
- Default `engine.model` to the versioned `jev-1.13.0` instead of the `jev-latest` alias. Stored decisions made with the alias need one fresh assessment.
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
- Add `check <target>` for an edit loop. It reruns Fallow for one finding id or one file, reports `resolved` with no Jev call when the finding is gone, and otherwise judges the current source with the normal policy. It writes no state. It exits 0 when cleared, 1 when a finding stands, 2 on an error and 3 when a finding needs a person. `--dry-run` prints the estimate and sends nothing.
- `check` follows a finding that an edit moved. It matches the finding by rule, path, sink and evidence text, and reports an ambiguous match as "needs a person", never as `resolved`. Before `resolved`, it runs Fallow for the whole project and treats the same sink with other evidence text, or the same code in a renamed file, as an ambiguous match.
- Add the `fallow-verdict-check/v1` JSON schema with Fallow-style `actions`.
- Add `close <id> --reason "<text>"` to record a judgment by a person. A closed finding stays closed until its evidence fingerprint changes. `report` shows closed findings in a separate section, and they do not count toward `--fail-on`. `judge` and `run` do not send a closed finding to Jev while its evidence is the same. The verdict export for Fallow gives it the verdict `dismissed`, with the reason of the person. `close` refuses a finding whose code changed after the last scan. `scan`, `judge` and `run` remove a closure whose evidence changed.
- Add the optional `closed` field to finding records, and the optional `by` and `reason` fields to history entries.

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
