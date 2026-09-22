# Evaluation

Do not trust a triage tool you have not measured on your own code.

1. Run `fallow-verdict run` on a project.
2. Label candidates by hand in a labels file:

```json
{
  "schema_version": "fallow-verdict-labels/v1",
  "labels": [
    { "finding_id": "example-vulnerable-id", "expected": "vulnerable" },
    {
      "finding_id": "example-safe-id",
      "expected": "safe",
      "note": "fixed origin and redirects disabled"
    }
  ]
}
```

3. Run `fallow-verdict eval --labels labels.json`.

| Metric            | Meaning                                                  | Target             |
| ----------------- | -------------------------------------------------------- | ------------------ |
| dismiss precision | of dismissed candidates, the share that really were safe | as close to 100%   |
| missed vulnerable | vulnerable candidates that were dismissed, listed by id  | zero               |
| survivor recall   | of vulnerable candidates, the share called survivor      | high               |
| noise removed     | of safe candidates, the share dismissed                  | the payoff         |
| review rate       | share left for a human                                   | the remaining cost |
| calibration error | expected calibration error of P(exploitable)             | low                |

`eval` exits 1 when any vulnerable candidate was dismissed, so it can gate a threshold change in
CI. It makes no engine calls; it scores what is stored.

Tune in this order: first get missed vulnerable to zero by tightening `dismissMaxExploitable` and
`dismissMinReasonStrength`, then look at how much noise is still removed. Compare
`packet.blind` on and off, and different `packet.radius` values, with `judge --rejudge`.

Include safe look-alikes in your labels, not only true vulnerabilities. A label set of only
vulnerable candidates cannot measure dismiss precision.

## Included development corpus

`eval/corpus` is a small application with both vulnerable operations and safe look-alikes that
fallow still reports. `eval/cases.json` records the reviewed label, threat assumptions, candidate category/callee, and
source SHA-256 for each file. Source or candidate drift requires an explicit label review.
Exported identifier arguments are assumed to be externally supplied. Request URLs are attacker
controlled; `Response.redirect` has Express-style redirect semantics; `Database.query` executes
SQL as given. These assumptions are part of the labels, not claims about every real caller.

```bash
npm run eval:live -- --dry-run
# With TYPESAFE_API_KEY already exported:
npm run eval:live
```

The runner scans the corpus, refuses unexpected/missing/duplicate candidates, derives finding IDs
from the current scanner, judges with a small cost budget, validates the exported verdicts, and
runs `eval`. Labels stay outside engine packets. State and generated labels are gitignored.
A rerun uses cached answers. Use `npm run eval:live -- --rejudge --question-profile category`
to request fresh answers with the experimental profile.

This is a development set, not an independent holdout or evidence of production calibration.
`dismissPrecision: null` means no dismissal was observed, not perfect accuracy. `eval` exits 2
when labeled candidates have no current judgment. Empty or duplicate labels are rejected. If any labeled candidate is pending, errored, resolved,
or missing, all aggregate rates are `null`; observed unsafe dismissals remain listed. See [validation.md](validation.md) for the initial live result.

## Fresh paired comparisons

The comparison runner bypasses persisted judgment caches. It sends the same evidence and policy
to the frozen generic baseline and category questions, alternates their order, and repeats every
case with the same concrete model version. Labels and threat assumptions are never sent to Jev.

```bash
npm run eval:compare -- --dataset development --dry-run
npm run eval:compare -- --dataset holdout --dry-run
# With TYPESAFE_API_KEY already exported:
npm run eval:compare -- --dataset development --output /tmp/development.json
npm run eval:compare -- --dataset holdout --output /tmp/holdout.json
```

Defaults are `jev-1.13.0`, three fresh calls per variant and case, and an estimated $0.05 cap.
Aliases are rejected, and an unexpected response model stops the run. Override `--repeats`,
`--model`, or `--max-cost-usd` explicitly. Dry runs make no engine calls. Live comparisons require `--output` and print their estimate
before making calls. The runner verifies
source labels and frozen question hashes before any call. Output includes evidence/question
hashes, raw answers, decisions, cost, missing observations, and verdict changes across repeats.
Each variant summary also includes `reviewByRule`, with observed counts for `evidence-missing`,
`tampering-suspected`, `truncated-evidence`, `evidence-conflict`, and `uncertain`.
`eligibleReviewRate` excludes cases labeled with `mustReview: true`, so adversarial
review guards are reported separately from review caused by ordinary uncertainty. The
rule counts are partial observations while a comparison is incomplete. `eligibleReviewRate`
is `null` for incomplete comparisons or when no eligible cases exist. The existing aggregate
`reviewRate` still includes every observed case for backwards compatibility.
Incomplete variants have `null` aggregate rates. Provider retries and failed requests can cost
more than recorded successful-response usage.

Live comparisons save an initial plan and replace the output atomically after each response,
before starting the next request. An interruption leaves the completed observations available
with their recorded cost. A storage failure stops further requests. Incomplete variants retain
null aggregate rates, and a response interrupted before it was saved may still incur provider
charges. These checkpoints do not resume a run; use a new output path for another comparison.

Exit 1 means a vulnerable case was dismissed or a mandatory human-review guard failed. Exit 2
means incomplete execution. Exit 0 means those checks passed; it does not establish stability,
calibration, or readiness to change the default. Repeated calls are not independent code examples.

The separately authored `eval/holdout` covers parsed URL restrictions, misleading prefix checks,
and adversarial reviewer comments. Its labels include executable runtime checks. It was first
queried after the category questions were frozen. It is now a consumed pilot holdout: future
tuning needs new unseen cases. See [evaluation-v2.md](evaluation-v2.md) for the published results.
