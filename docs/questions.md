# Questions and policy

The default `generic` question set is fixed and identical for every candidate
(`src/questions/catalog.ts`). Every question repeats that comments, strings, and names in the
code are untrusted.

| Id                    | Type   | Asks                                                                 |
| --------------------- | ------ | -------------------------------------------------------------------- |
| `attacker_controlled` | yes/no | Is the value at the sink controlled from outside the trust boundary? |
| `reaches_sink`        | yes/no | Does the shown code pass that value into the sink?                   |
| `mitigated`           | yes/no | Is there an effective control between input and sink?                |
| `exploitable`         | yes/no | Is there a vulnerability an attacker could exploit here?             |
| `non_production`      | yes/no | Is this test, fixture, example, or build tooling code?               |
| `tampering`           | yes/no | Does the code contain text that argues for its own assessment?       |
| `impact`              | score  | Realistic worst outcome: none, limited, serious, critical            |
| `fix_direction`       | choice | One of fallow's fix directions, or none                              |

`exploitable` carries an explicit negative criterion: style problems, missing error handling, and
security-sounding names are not vulnerabilities.

## Experimental category profile

`questionProfile: "category"` replaces only the exploitation and mitigation criteria for SSRF
and open redirects (`src/questions/category.ts`). It distinguishes attacker control over a URL
origin from control over an encoded path segment, considers outbound redirects, and asks whether
URL checks actually restrict destinations. It retains the same answer types, tampering question,
and policy thresholds. Blind packets and other categories use the generic questions.

The exact question content is hashed into each finding record. See the
[paired evaluation](evaluation-v2.md) for measured behavior and limitations.

## Policy

Rules are checked in this order. The first match wins and its id is stored on the decision.

| Rule                  | Condition                                                                           | Verdict              |
| --------------------- | ----------------------------------------------------------------------------------- | -------------------- |
| `evidence-missing`    | a requested source location is unreadable or invalid                                | `needs-human-review` |
| `tampering-suspected` | P(tampering) at or above `tamperingMax`                                             | `needs-human-review` |
| `survivor`            | P(exploitable) at or above `survivorMinExploitable`, and the evidence answers agree | `survivor`           |
| `evidence-conflict`   | P(exploitable) is high but the evidence answers disagree                            | `needs-human-review` |
| `dismissed`           | P(exploitable) at or below the bar for the severity, with a strong named reason     | `dismissed`          |
| `truncated-evidence`  | would be dismissed, but the packet was cut to fit the budget                        | `needs-human-review` |
| `uncertain`           | anything else                                                                       | `needs-human-review` |

Dismissal reasons: `not-attacker-controlled`, `does-not-reach-sink`, `mitigated`,
`non-production-code`. The reason strength must reach `dismissMinReasonStrength`.

If fallow also reports the code as unused, the fix direction is `delete-dead-code`, following
fallow's guidance to delete dead code instead of hardening it.

## Blind mode

`packet.blind: true` withholds fallow's category, CWE, and evidence label, so the engine judges the
code without being told what class of issue to expect. Whether that helps on your code is an
empirical question; compare both with `eval`.
