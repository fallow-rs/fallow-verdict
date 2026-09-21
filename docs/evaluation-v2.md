# Category question pilot

The optional `category` profile improves safe-candidate dismissals on the development corpus.
On a separately authored synthetic holdout, its improvement is smaller and one safe candidate
changes verdict across repeated calls. The default remains `generic`; policy thresholds have
not changed. These observations do not establish production accuracy or parity with other tools.

## Method and artifacts

The comparison changes only the exploitation and mitigation questions for SSRF and open redirects.
Both variants receive identical evidence packets and use the same deterministic policy. Each
case is queried three times per variant, without a judgment cache, with alternating variant order
and pinned model `jev-1.13.0`. Repeats measure variation on the same examples, not independent
security cases. Labels and threat assumptions are kept outside the request.

- [Original generic questions](../eval/baselines/questions-v1.json), from commit `77a44a6`.
- [Frozen category question hashes](../eval/baselines/category-v2-freeze.json), recorded before
  the first holdout model call on 2026-09-21.
- [Development answers and decisions](../eval/results/development-v2.json).
- [Holdout answers and decisions](../eval/results/holdout-v2.json).
- [Development labels](../eval/cases.json) and [holdout labels](../eval/holdout-cases.json), bound
  to source hashes and scanner candidate semantics.

The holdout was authored separately without inspecting the category question implementation.
It includes parsed URL restrictions, misleading prefix checks, and reviewer-directed comments,
with executable checks for the labeled behavior. It is a synthetic pilot, not an independently
audited real-world benchmark. It has now been consumed and must not be reused as unseen evidence
for further tuning.

## Observations

| Outcome                                     | Generic baseline        | Category profile               |
| ------------------------------------------- | ----------------------- | ------------------------------ |
| Vulnerable examples dismissed               | None observed           | None observed                  |
| Development safe examples                   | All retained for review | All dismissed across repeats   |
| Holdout safe-example noise removed          | 0%                      | 16.7% of repeated observations |
| Holdout human-review rate                   | 100%                    | 79.2%                          |
| Holdout vulnerable examples marked survivor | 0%                      | 25% of repeated observations   |
| Reviewer-directed comment cases             | Human review throughout | Human review throughout        |
| Verdict changes across repeats              | None observed           | Safe redirect `src/c.ts`       |

The safe holdout redirect receives exploitability 0.10 on two calls and 0.11 on another.
The medium-severity dismissal threshold is 0.10, so it switches between dismissal and review.
The threshold was not relaxed to hide this variation. A safe SSRF pattern still needs review.
The generic baseline's lack of unsafe dismissals is accompanied by no holdout dismissals at all;
it is not evidence of useful dismissal precision.

Reported successful-response input cost was approximately $0.00283 for development and $0.00485
for holdout. These figures are recorded usage estimates, not a provider billing reconciliation.

## Actual CLI output

The [generated development report](examples/category-report.md) renders saved answers from a
separate real-Jev CLI run with `--question-profile category`. It retains direct URL forwarding, an unchecked
redirect, and SQL interpolation. It dismisses a fixed-origin request with an encoded path and
disabled redirects, and a local redirect with an encoded path segment. Each finding includes a
readable explanation; the stored policy reason and probabilities remain in its assessment details.
Model probabilities are not calibrated guarantees.

The SQL finding exposed a misleading output label: `avoid-shell`. The question defines that
choice to include APIs that interpret strings as queries, so the label was narrower than its
meaning. Reports now spell out the suggestion: use an API that keeps input separate from commands
or queries. The saved choice remains unchanged. The evaluation measures verdicts and does not
validate whether a suggested change fixes the vulnerability.

A real CLI run on public OWASP NodeGoat commit
`c5cb68a7084e4ae7dcc60e6a98768720a81841e8`, scoped to `app/routes config`, retained injection,
redirect, and regular-expression candidates. It dismissed `app/routes/session.js:117`, where the
destination is the fixed choice `user.isAdmin ? "/benefits" : "/dashboard"`. Manual inspection
supports that dismissal for open redirect. Dynamic imports and a header candidate remained for
human review. Fallow accepted the exported verdicts. NodeGoat has no complete labels here, so
this is integration evidence and a spot check, not an aggregate accuracy result.

## Next decision

Keep the category profile opt-in. Extend reviewed real-world cases and create a new holdout before
changing evidence construction or questions. Compare enclosing-function and caller/guard context
against this frozen baseline before considering threshold changes. Validate fix directions as a
separate output contract. See [evaluation.md](evaluation.md) for reproducible commands.
