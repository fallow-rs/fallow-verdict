# Development roadmap

## Current pilot

Fresh paired comparisons, source-bound labels, and a separately authored synthetic holdout are
implemented. The experimental category profile improves development examples, with limited and
variable holdout noise reduction. No vulnerable examples were dismissed in these observations.
The profile stays opt-in and thresholds remain unchanged. See [evaluation-v2.md](evaluation-v2.md).

## Measure useful dismissals

Expand the labeled corpus with safe candidates that Fallow still reports, paired with vulnerable
near-neighbors. Cover URL parsing and redirects, SQL identifier/value contexts, path containment,
authorization checks, and multi-module flows. Document attacker control and deployment assumptions
for every label. Create a new unseen holdout before further tuning: the published pilot holdout has now been used.

Acceptance requires no dismissed vulnerable holdout examples, useful safe-candidate dismissals,
and stable behavior across repeated runs with a pinned model. Report uncertainty and abstentions;
an absence of dismissals cannot establish dismissal precision. Add adversarial comments,
missing files and truncated context to every evaluation pass.

## Improve evidence before relaxing thresholds

Inspect why the safe examples still require review. Compare source windows with enclosing
functions and explicit caller/guard context, then compare them against the frozen category-question baseline.
Change one dimension at a time and version both the packet and question set. Preserve raw answers
so policy experiments remain local. Retain the current conservative thresholds until the holdout
supports a change.

## Validate remediation guidance

Reports now explain broad fix-direction labels such as `avoid-shell` in plain language, including
their query-related meaning. Validate the suggested changes against category semantics and fallow
contracts, then test them on real examples before relying on them for remediation.

## Make review results useful in CI

Add SARIF or a GitHub Check integration with stable finding identities, current evidence links,
and an explicit incomplete-run state. PR scoping should retain graph context, and cached state
must never hide changed or unjudged candidates. Keep credentials unavailable to untrusted fork
code and use JSON configuration when reviewing untrusted repositories.

## Release gates

The package is a development preview. Each npm release requires green CI on the
exact release commit and a clean packed-install smoke test. Changes to saved data
must follow the [state compatibility policy](architecture.md#state-compatibility).
Keep the published holdout evaluation available alongside each release.
Provider-side billing limits remain necessary for a hard cost
cap. Accuracy comparisons with deepsec or Warden require the same pinned projects, labels and
scope, including findings outside Fallow's catalogue.
