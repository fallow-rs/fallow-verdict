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

**packet** builds one self-contained evidence packet per candidate, following the
`fallow-security-verifier-input/v1` convention from fallow's verification recipe. fallow never
emits source text, so the packet builder reads numbered source windows from disk around the sink,
the source endpoint, every trace hop, and every detected defensive control. Overlapping windows
are merged so a line is sent once. If the packet exceeds the token budget, the window radius
shrinks stepwise; if that is not enough, trace, control, and source windows are dropped in that
order. The sink window is never dropped. A packet that was cut is marked `truncated`.

**engine** sends the packet as `state` with the question set in a single request. All questions
are evaluated independently and in parallel by the engine. The response is validated: every
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
question set version, usage, and an append-only `history`. Records are written with a temp file
and rename, so a crash leaves the previous record intact. A record that fails validation is
skipped with a warning instead of failing the run.

## Staleness

A stored verdict is current when three things match: status `judged`, the evidence fingerprint,
and the question set version. Editing any line inside a source window changes the fingerprint.
Changing a question's wording bumps `QUESTION_SET_VERSION`. Either makes the candidate pending
again.

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
  cannot produce a silent dismissal.
- **One dependency.** `zod` validates config, state, and engine responses. The engine client uses
  `fetch`.
- **fallow owns the contracts.** Types come from `fallow/types`. The supported
  `fallow security` schema versions are pinned and checked at runtime.
