# Fallow and fallow-verdict responsibilities

Fallow establishes facts about the code and reports security candidates. Fallow-verdict selects
the evidence for Jev and applies a review policy to its answers. A wrong verdict can originate in
either layer, so reproduce the behavior before changing a detector or a decision threshold.

| Concern                         | Owner          | Required behavior                                                                              |
| ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| URL construction and data flow  | Fallow         | Describe whether input can change the final origin. A trusted-looking prefix is insufficient.  |
| Guards and runtime API identity | Fallow         | Attach source-backed controls and identify the actual API where the analysis can establish it. |
| Evidence selection              | fallow-verdict | Include matching attack-surface paths and controls, with readable source windows.              |
| Category interpretation         | fallow-verdict | Ask whether the supplied code permits the claimed attack, including relevant runtime behavior. |
| Verdict policy and presentation | fallow-verdict | Keep model estimates separate from mandatory review and preserve the reason for each decision. |

## Changes in fallow-verdict

The packet builder consumes Fallow's top-level `attack_surface` output. It matches surfaces to the
candidate using the sink location and category, retaining distinct paths to the same sink. Older
inline surface evidence remains supported. Controls and their source windows travel with the
packet; a control name alone does not establish that the protection is effective.

The packet makes that limit explicit in `defensive_controls_scope`: controls are observations
from files on the trace, and their applicability to the sink is not established. A control may
belong to another function or check a different value. Later mutations can also defeat a check.

Packets use `fallow-security-verifier-input/v2`. The changed packet fingerprint invalidates older
decisions before reporting or reuse, while their history remains available. Added locations use
the existing project-root containment checks and token budget. Unreadable evidence or a packet
shortened to fit the budget cannot justify an automatic dismissal.

Reports distinguish `Review required` from `Assessment inconclusive`. A model may estimate that a
finding is exploitable while the policy requires review because its evidence contains suspected
instructions to the reviewer. The estimate remains visible in either case. This wording change
does not change verdict thresholds or make the tampering heuristic infallible.

## Work in Fallow

A URL prefix such as `https://service.example` can still be extended with `.attacker.example`.
A leading `/` can become `//attacker.example`. Fallow must retain that possibility in URL-shape
metadata until known characters establish the authority boundary. Constant aliases followed by
a fixed path need to remain distinguishable from these unsafe constructions.

Node's built-in HTTP header methods reject invalid header characters, but a custom object can
also expose a method named `writeHead`. Suppression based on that method name would hide unsafe
implementations. Recognizing a built-in safeguard requires receiver provenance and handling of
shadowed or replaced methods. This runtime-modeling work is still open. See the
[Node HTTP contract](https://nodejs.org/docs/latest-v24.x/api/http.html#responsewriteheadstatuscode-statusmessage-headers).

Exact comparisons of an `.origin` property against a known string belong in Fallow's control
observations when the mismatch branch exits. That does not establish a built-in URL receiver or
prove the check protects the sink. That requires tracing the value through the check to the sink,
including any mutations. Even a correctly applied origin check cannot automatically suppress SSRF:
outbound redirects can escape it, and the destination must match the application's trust policy.

## Evaluation boundary

Restoring evidence and clarifying reports are independently testable corrections. They do not
establish that Jev now dismisses more false positives. The pilot's complete URL handlers and Node
HTTP wrapper already reached Jev, so missing source text did not explain those wrong assessments.
Further prompt changes need a fresh evaluation with safe and vulnerable neighbors. Keep the
current thresholds until that evaluation supports changing them.
