# Initial validation

The September 21, 2026 validation used the real Jev API, Fallow 3.27.0, and the default
question set and policy. Concrete model IDs and responses for the included development corpus
are recorded in [initial-jev.json](../eval/results/initial-jev.json), alongside a corpus hash.
Credentials and request authorization headers are excluded.

## Observed behavior

The labeled corpus retained each vulnerable example as `survivor`. The safe fixed-origin fetch
and same-origin redirect were both sent to human review. Nothing was dismissed. This run
therefore demonstrates conservative triage on these examples, but does not measure dismissal
precision or show a reduction in review work. No threshold or question was tuned to this run.

The full scan, packet, real Jev call, persisted answers, report export and Fallow post-validation
also completed on public projects:

- [Fallow fixtures](https://github.com/fallow-rs/fallow/tree/d4264c27859c6b307fbebd269c969c0b107984ee/tests/fixtures),
  specifically the SQL-injection and SSRF projects. Results included survivors and human review;
  neither fixture produced dismissals.
- [OWASP NodeGoat](https://github.com/OWASP/NodeGoat/tree/c5cb68a7084e4ae7dcc60e6a98768720a81841e8),
  scoped to application routes and configuration. Injection and open-redirect candidates were
  retained; ambiguous configuration and other candidates required human review. Vendored assets
  were outside this scoped run. This is integration evidence, not a fully labeled accuracy study.

Exit code 1 on these completed runs indicates retained findings. It is not an execution failure.

## Reliability validation

Minimal regression tests reproduce stale dismissals after interrupted or budget-limited work,
missing evidence, invalid source locations, model-cache drift, historical evaluation results,
concurrent cost-accounting gaps, and unsafe state-lock recovery. The corrected behavior passes
the regression suite. The CLI suite also runs a real Fallow binary against the included
application, exercises a local HTTP engine, checks resumability and scoped reporting, and
verifies that provider failures and incomplete reports return execution errors.

The local HTTP engine tests only the integration contract. Actual assessment observations above
come from real Jev responses. The complete typecheck, lint, format, test and build workflow is
required in CI, followed by schema regeneration and installation of the packed CLI.

## Limits

This pilot is too small and too narrow to establish production calibration or accuracy parity
with another security tool. It has no independent holdout, repeated-run estimate, or adversarial
prompt-injection evaluation. Source windows can omit relevant callers and guards. Even complete
requested windows are not complete program evidence. Keep human review in the workflow and
follow the evaluation gates in [roadmap.md](roadmap.md) before relying on automatic dismissal.
