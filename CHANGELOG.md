# Changelog

## 0.2.0 (2026-10-14)

### Added

- Add advisory review mode for functions and project rules with `--kind review`.
- Add preview similar-code assessments with `--kind similar-code`, confidence floors, and Fallow verdict exports.
- Add `check` to assess edited findings without writing state, and `close` to record a person's decision.
- Add command-specific help, JSON usage errors, and action commands in report and assessment outputs.
- Include coding-assistant skills and JSON schemas for check, report, and judgment outputs.
- Add staged npm publishing with OIDC, exact artifact verification, and signed tags created after verification.

### Changed

- Require agreeing assessments before security findings are dismissed by default.
- Require confirmation of similar-code dismissals and merge recommendations. Incomplete evidence needs human review.
- Keep incomplete similar-code scans from resolving stored findings, and cache complete inspect evidence between assessments.
- Use `jev-1.13.0` as the default model and pace requests with the configured rate limit.
- Stop immediately when Jev returns HTTP 402, using the error code `engine_out_of_credits`.

### Compatibility

- Security remains the default kind. Existing security state keeps its directory and record layout.
- Stop active runs and back up `.fallow-verdict/` before upgrading. Records without a kind still load as security records.
- Old dismissals without confirmation need reassessment. Changed model or evidence settings can also make saved decisions stale.
- Confirmation calls count toward the cost cap. Dry runs show their upper bound and send no engine requests.
- Unsupported command options now exit with code 2. Update scripts that relied on ignored options.
- This package remains a development preview. Unsupported record schemas need a separate data directory and fresh assessment.

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
