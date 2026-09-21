# Security review

5 candidates: 3 likely vulnerabilities, 0 need review, 2 dismissed

Fallow found these candidates; Jev assessed the supplied code. Review the evidence before acting on a verdict.

## Likely vulnerabilities (3)

Jev assessed these as exploitable in the supplied code.

### src/proxy.ts:3

SSRF | Fallow severity: medium

Model estimate of exploitability: 95%.

Suggested approach: Restrict the destination URL.

<details>
<summary>Assessment details</summary>

Decision rule: survivor.
Jev impact estimate: serious.

Survivor: exploitable 0.95, attacker-controlled 0.97, reaches sink 0.95, mitigated 0.03.

</details>

### src/redirect.ts:5

open redirect | Fallow severity: medium

Model estimate of exploitability: 85%.

Suggested approach: Restrict the destination URL.

<details>
<summary>Assessment details</summary>

Decision rule: survivor.
Jev impact estimate: serious.

Survivor: exploitable 0.85, attacker-controlled 0.93, reaches sink 0.92, mitigated 0.13.

</details>

### src/query.ts:5

SQL injection | Fallow severity: low

Model estimate of exploitability: 94%.

Suggested approach: Use an API that keeps input separate from commands or queries.

<details>
<summary>Assessment details</summary>

Decision rule: survivor.
Jev impact estimate: serious.

Survivor: exploitable 0.94, attacker-controlled 0.61, reaches sink 0.95, mitigated 0.03.

</details>

## Dismissed (2)

### src/lookup.ts:3

SSRF | Fallow severity: low

Jev considers the protection in the supplied code effective.

Model estimate of exploitability: 6%.

<details>
<summary>Assessment details</summary>

Decision rule: dismissed.

Dismissed (mitigated 0.90): exploitable 0.06, attacker-controlled 0.65, reaches sink 0.90, mitigated 0.90.

</details>

### src/profile.ts:5

open redirect | Fallow severity: low

Jev considers the protection in the supplied code effective.

Model estimate of exploitability: 8%.

<details>
<summary>Assessment details</summary>

Decision rule: dismissed.

Dismissed (mitigated 0.85): exploitable 0.08, attacker-controlled 0.72, reaches sink 0.94, mitigated 0.85.

</details>

Review suggested approaches against the code before making changes.

Recorded assessment cost: $0.0005
