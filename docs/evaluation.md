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
fallow still reports. `eval/cases.json` records the reviewed label and rationale for each file.
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
A rerun uses cached answers; use `judge --cwd eval/corpus --rejudge` to request new answers.

This is a development set, not an independent holdout or evidence of production calibration.
`dismissPrecision: null` means no dismissal was observed, not perfect accuracy. `eval` exits 2
when labeled candidates have no current judgment. Pending, errored and resolved decisions are
excluded from scoring. See [validation.md](validation.md) for the initial live result.
