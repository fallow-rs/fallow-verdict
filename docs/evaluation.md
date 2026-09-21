# Evaluation

Do not trust a triage tool you have not measured on your own code.

1. Run `fallow-verdict run` on a project.
2. Label candidates by hand in a labels file:

```json
{
  "schema_version": "fallow-verdict-labels/v1",
  "labels": [
    { "finding_id": "5ee39bdd47c05233", "expected": "vulnerable" },
    { "finding_id": "c0d67469c85a2b03", "expected": "safe", "note": "identifier is quoted" }
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
