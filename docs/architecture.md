# Architecture

```text
fallow security ──> scan ──> packet ──> engine ──> policy ──> verdicts ──> fallow security survivors
   (candidates)    (state)  (evidence)  (answers)  (decision)  (contract)      (post-validation)
```

## Stages

**scan** runs `fallow security --format json --surface --quiet`, stores the output as
`candidates.json`, and reconciles finding records. New candidates become `pending`. Candidates
fallow no longer reports become `resolved`. A scoped scan (`--changed-since`, explicit paths) sees
only part of the project and therefore never resolves anything.

**packet** builds one self-contained `fallow-security-verifier-input/v2` evidence packet per candidate.
It matches Fallow's top-level attack-surface entries by sink location and category, preserving
distinct paths and their controls. Legacy inline surfaces remain supported. Fallow never
emits source text, so the packet builder reads numbered source windows from disk around the sink,
the source endpoints, trace hops, and detected defensive controls. Overlapping windows
are merged so a line is sent once. If the packet exceeds the token budget, the window radius
shrinks stepwise; if that is not enough, trace, control, and source windows are dropped in that
order. The sink window is never dropped. A packet that was cut is marked `truncated`.

`defensive_controls_scope` states that controls were found in files on the trace and their
applicability to the sink is not established. This scope covers both the flattened controls and
those retained per attack surface. A control may belong to another function or operate on a
different value. Its presence alone cannot establish effective mitigation.

**engine** sends the packet as `state` with the question set in a single request. Questions
are evaluated in parallel by the engine; their errors can be correlated. The response is validated: every
question must be answered in the type that was asked, and a choice must be one of the offered
options. Anything else is `engine_response_invalid`, never a partial success.

**policy** (`src/policy/decide.ts`) is a pure function from answers to a decision. It names the
rule that fired. See [questions.md](questions.md).

**verdicts** exports `fallow-security-verdicts/v1`. The `finding_id` always comes from the stored
candidate, never from an engine response. `report` then runs `fallow security survivors`, which
rejects unknown or duplicate ids and malformed verdicts.

## State layout

```text
.fallow-verdict/
  candidates.json        last `fallow security` output
  findings/<hash>.json   one record per finding_id
  runs/<runId>.json      one record per judge run: outcome, tokens, cost
  verdicts.json          fallow-security-verdicts/v1, derived
  report.md              derived
  .lock/                 held while a mutating command runs
```

A finding record holds the current decision, the evidence fingerprint it was made on, the
question set version and content hash, usage, and an append-only `history`. Records are written with a temp file
and rename, so a crash leaves the previous record intact. Unreadable records fail judgment, reporting, and evaluation closed. A fresh scan can reconstruct
current candidates.

## Staleness

A stored verdict is current when its status is `judged` and its evidence fingerprint, question
set version, actual question content hash, requested model, and endpoint match. Editing any line inside a source window changes the fingerprint.
Changing a question's wording bumps `QUESTION_SET_VERSION`. Either makes the candidate pending
again. Pending decisions are invalidated before any budget, limit, or interruption can skip them.
Reports recheck the current source windows, and a changed policy remaps stored answers locally.

Older records without a question content hash load with `questionHash: null`. They require a
fresh judgment before their verdict can be reported. Their history remains available. Switching
profiles also requires fresh calls when it changes the questions; it never silently reuses answers
from another rubric.

The v2 packet adds matched attack-surface evidence. Its changed fingerprint also invalidates
decisions made with v1 packets, including findings whose source files have not changed. The raw
Fallow candidate output and exported `fallow-security-verdicts/v1` contract are unchanged.

## Failure handling

- Transient engine errors (408, 429, 5xx, 529, timeouts) are retried with jittered backoff and
  `retry-after` support.
- A rejected key opens the circuit breaker at once; repeated provider failures open it after a
  short streak. The run stops with exit code 2 instead of marking every candidate as errored.
- A failed forced re-judge keeps the verdict that is still valid for the current evidence.
- Error codes are a stable, add-only list (`src/util/errors.ts`).

## Design decisions

- **The engine decides nothing on its own.** It returns probabilities. Thresholds live in code
  and config where they can be reviewed, tested, and changed without touching a prompt.
- **No tools for the engine.** It cannot read files, run commands, or reach the network, so
  hostile repository content can at most shift a probability. The policy is built so that shift
  still requires human validation; it does not prove immunity to prompt injection.
- **One dependency.** `zod` validates config, state, and engine responses. The engine client uses
  `fetch`.
- **fallow owns the contracts.** Types come from `fallow/types`. The supported
  `fallow security` schema versions are pinned and checked at runtime.
