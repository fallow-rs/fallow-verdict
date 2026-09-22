# Changelog

## Unreleased

- Include matching top-level Fallow attack-surface evidence and controls in v2 verifier packets; invalidate decisions made with older packets.
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
