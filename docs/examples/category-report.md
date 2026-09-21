# Security verdicts

5 candidates: 3 survivors, 0 need review, 2 dismissed

Candidates come from `fallow security`. A fixed policy maps model probabilities to verdicts. A verdict is a triage result, not proof.

## Survivors (3)

| Severity | Location            | Category      | Confidence | Rule     | Impact  | Fix direction | Reason                                                                                   |
| -------- | ------------------- | ------------- | ---------- | -------- | ------- | ------------- | ---------------------------------------------------------------------------------------- |
| medium   | `src/proxy.ts:3`    | ssrf          | 0.95       | survivor | serious | restrict-url  | Survivor: exploitable 0.95, attacker-controlled 0.97, reaches sink 0.95, mitigated 0.03. |
| medium   | `src/redirect.ts:5` | open-redirect | 0.85       | survivor | serious | restrict-url  | Survivor: exploitable 0.85, attacker-controlled 0.93, reaches sink 0.92, mitigated 0.13. |
| low      | `src/query.ts:5`    | sql-injection | 0.94       | survivor | serious | avoid-shell   | Survivor: exploitable 0.94, attacker-controlled 0.61, reaches sink 0.95, mitigated 0.03. |

## Dismissed (2)

| Severity | Location           | Category      | Confidence | Rule      | Impact | Fix direction | Reason                                                                                                     |
| -------- | ------------------ | ------------- | ---------- | --------- | ------ | ------------- | ---------------------------------------------------------------------------------------------------------- |
| low      | `src/lookup.ts:3`  | ssrf          | 0.90       | mitigated |        |               | Dismissed (mitigated 0.90): exploitable 0.06, attacker-controlled 0.65, reaches sink 0.90, mitigated 0.90. |
| low      | `src/profile.ts:5` | open-redirect | 0.85       | mitigated |        |               | Dismissed (mitigated 0.85): exploitable 0.08, attacker-controlled 0.72, reaches sink 0.94, mitigated 0.85. |
