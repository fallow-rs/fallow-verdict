# Changelog

## Unreleased

- Initial pipeline: `scan`, `judge`, `report`, `run`, `status`, `eval`, `init`.

- Invalidate outdated decisions before budget stops and before reporting or evaluation.
- Require readable, valid evidence locations and reject oversized packets before calling Jev.
- Account for concurrent request costs before persisting results, and preserve active state locks.
- Return execution errors for incomplete runs and model failures.
- Add a labeled development corpus, live evaluation runner, and CLI contract tests with real fallow.
