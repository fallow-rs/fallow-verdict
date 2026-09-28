# Architecture

```text
fallow security ──> scan ──> packet ──> engine ──> policy ──> verdicts ──> fallow security survivors
   (candidates)    (state)  (evidence)  (answers)  (decision)  (contract)      (post-validation)
```

## Analysis kinds

The pipeline is generic over an analysis kind. Each kind is one Fallow analysis. The kinds are
`security`, the default, and `review` (see [review mode](review.md)). The `--kind <name>` flag selects the kind for
`scan`, `judge`, `run`, `report`, `status`, `eval`, `check` and `close`. An unknown kind is a usage error with exit
code 2, and the message lists the known kinds.

An adapter (`src/kinds/adapter.ts`) holds everything that is specific to one kind:

| Part        | Responsibility                                                         |
| ----------- | ---------------------------------------------------------------------- |
| `scan`      | Run the Fallow command, validate its schema version, return candidates |
| `identity`  | Give each candidate a stable, unique id, its locations and severity    |
| `match`     | A match key and the meaning of "the same rule", for `check`            |
| `priority`  | Order candidates for the budget and the report                         |
| `packet`    | Build the evidence packet, its fingerprint and its evidence summary    |
| `questions` | The question catalog, its version and its content hash                 |
| `policy`    | A pure function from answers to a decision, with a named rule          |
| `report`    | The words and evidence lines of the terminal and Markdown reports      |
| `supports`  | The options that the kind supports: `--question-profile` and `eval`    |
| `export`    | Write the verdict contract and run the Fallow join command, if any     |

Two optional parts let a kind differ from the security defaults. `confirmDismissals` says whether
a dismissal needs a second call; without it, `policy.confirmDismissals` applies. `failOn` gives
the `failOn` level when `--fail-on` is absent; without it, the top-level `failOn` applies.

The shared pipeline owns state, staleness, budgets, retries, locking and reports. It never reads
kind-specific fields.

Each kind owns these parts of its records and reports:

- **Locations.** A candidate has one or more locations. The first location fills `path`, `line`
  and `col`. A kind with more than one location, such as a similar-code pair, also stores the full
  list in `locations`. A security record has one location and no `locations` field.
- **Severity.** `severity` is the Fallow severity. It is null for a kind without one. The budget
  order and the report order come from the adapter `priority`, not from the severity. Security
  puts high severity first.
- **Evidence summary.** The pipeline reads only `evidence.truncated`. The kind owns the other
  fields. Security stores `windows`, `hasSource` and `hasTrace`.
- **Security contract.** A security record, which includes a record without `kind`, must have a
  severity and the full security evidence summary. Otherwise it is corrupt. The record JSON schema
  states this rule in an `allOf` with `if` and `then`.
- **Verdict.** `survivor`, `dismissed` and `needs-human-review` are the shared vocabulary. A kind
  maps its own outcome onto them and can store its own data in `decision.kindData`.
- **Report text.** The report layout is shared. The title, the name of a survivor and the lines
  for each finding come from the adapter `report` part.

An option that the selected kind does not support, such as `--question-profile` or `eval`, is a
usage error with exit code 2. The security adapter (`src/kinds/security.ts`) connects the existing
modules under `src/fallow`, `src/packet`, `src/questions`, `src/policy` and `src/verdicts`.
The registry (`src/kinds/registry.ts`) maps each name in `ANALYSIS_KINDS` to one adapter.

`ScanScope.complete` lists files in which the kind must list every candidate it can find, also
outside its own selection and cap. `check` sets it to the target files. Security lists every
finding, so it ignores the field. Review mode lists every function in these files, so `check`
always sees the edited function.

The review adapter (`src/kinds/review.ts`) connects `src/fallow/health.ts` and the modules under
`src/review`. It selects functions with `fallow health`, builds one packet per function, asks the
built-in questions and the project rules in one request, and exports
`fallow-verdict-review-verdicts/v1` with no Fallow join. Its dismissals are single calls unless
`review.confirmDismissals` is set, and it fails a run only when `review.failOn` or `--fail-on`
is set. Its match key is the path and the function name, and its rules block `resolved` for a
function with the same path and name or with the same source.

The stages below describe the security kind.

## Stages

**scan** runs `fallow security --format json --surface --quiet`, stores the output as
`candidates.json`, and reconciles finding records. New candidates become `pending`. Candidates
fallow no longer reports become `resolved`. A scoped scan (`--changed-since`, explicit paths) sees
only part of the project and therefore never resolves anything.

Every selected candidate must have a non-empty, unique finding ID. Invalid or ambiguous IDs
stop the scan before state is replaced. Loading stored candidates applies the same check before
judgment or reporting. A scoped scan checks the selected set, so collisions outside that scope
do not block it.

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

**engine** sends the packet as `state` with the question set in a single request. A dismissal
takes a second, identical request (see dismissal agreement below). Questions
are evaluated in parallel by the engine; their errors can be correlated. The response is validated: every
question must be answered in the type that was asked, and a choice must be one of the offered
options. Anything else is `engine_response_invalid`, never a partial success.

**policy** (`src/policy/decide.ts`) is a pure function from answers to a decision. It names the
rule that fired. See [questions.md](questions.md).

**dismissal agreement** (`src/policy/confirm.ts`) runs in the shared pipeline for every kind. When
the policy gives `dismissed`, the pipeline sends the same request again. The verdict stays
`dismissed` only when the second answers also map to `dismissed`. Otherwise the verdict is
`needs-human-review` with the rule `dismissal-unconfirmed`. `policy.confirmDismissals: false`
turns this off. A kind can replace this setting with its own: review mode uses
`review.confirmDismissals`, which is off by default. See [review mode](review.md#dismissal-confirmation).

**verdicts** exports `fallow-security-verdicts/v1`. The `finding_id` always comes from the stored
candidate, never from an engine response. `report` then runs `fallow security survivors`, which
rejects unknown or duplicate ids and malformed verdicts.

## State layout

```text
.fallow-verdict/
  candidates.json        last `fallow security` output
  findings/<hash>.json   one record per finding_id
  runs/<runId>.json      one record per judge run: kind, outcome, tokens, cost
  verdicts.json          fallow-security-verdicts/v1, derived
  report.md              derived
  .lock/                 held while a mutating command runs
  kinds/<kind>/          the same layout for each kind other than security
```

A record can also hold `closed`: a judgment by a person from `close`, with the reason and the
evidence fingerprint at that time. `report` removes the closure when the fingerprint changes.
The history keeps the judgment as an entry with `by: "person"`.

A finding record holds its analysis kind, the current decision, the evidence fingerprint it was made on, the
question set version and content hash, usage, and an append-only `history`. Records are written with a temp file
and rename, so a crash leaves the previous record intact. Unreadable records fail judgment, reporting, and evaluation closed. A fresh scan can reconstruct
current candidates.

Security state stays at the root of the state directory, so existing state needs no migration.
Every other kind has its own directory, `.fallow-verdict/kinds/<kind>/`, with the same layout.
`openStore(dataDir, kind)` opens the state of one kind, and each kind has its own candidates,
records, runs, verdict contract, report and lock.

The lock is per kind. The kinds share no files, so a run of one kind cannot change the state of
another kind. Thus runs of different kinds do not wait for each other. The security lock at the
root does not cover `kinds/`, because security never writes there.

A record file name is a hash of the finding id only, so two kinds must never share a directory.
Three guards keep them apart:

- A store writes only records of its own kind. Any other record is a programming error.
- A store reads a record of another kind as corrupt, so judgment and reporting stop.
- The scan, judge, report and status paths refuse a store of a different kind than the adapter,
  with the `state_corrupt` error code.

## Staleness

A stored verdict is current when its status is `judged` and its evidence fingerprint, question
set version, actual question content hash, requested model, and endpoint match. Editing any line inside a source window changes the fingerprint.
Changing a question's wording bumps `QUESTION_SET_VERSION`. Either makes the candidate pending
again. Pending decisions are invalidated before any budget, limit, or interruption can skip them.
Reports recheck the current source windows, and a changed policy remaps stored answers locally.
The remap uses both stored answer sets, `answers` and `confirmationAnswers`. Without a confirming
answer set, a remap gives `needs-human-review` with the rule `dismissal-unconfirmed`, never
`dismissed`.

With `policy.confirmDismissals: true`, `judge` also treats an unconfirmed stored dismissal as
pending: the first answers map to `dismissed`, and `confirmationAnswers` is absent. This covers a
record from before the confirmation rule, a record judged with `confirmDismissals: false`, and a
record whose second call failed with an engine error or was stopped by a budget or time limit.
`judge` asks again with a first call and a confirmation call, and the dry-run plan counts the
record as "to assess". Only a confirmation that disagreed is final for the current evidence,
because only a disagreement is a signal about the finding. The history keeps each failed attempt
with the rule `dismissal-unconfirmed`. `report` without `judge` makes no calls and shows the
review verdict with the rule `dismissal-unconfirmed`.

Older records without a question content hash load with `questionHash: null`. They require a
fresh judgment before their verdict can be reported. Their history remains available. Switching
profiles also requires fresh calls when it changes the questions; it never silently reuses answers
from another rubric.

The v2 packet adds matched attack-surface evidence. Its changed fingerprint also invalidates
decisions made with v1 packets, including findings whose source files have not changed. The raw
Fallow candidate output and exported `fallow-security-verdicts/v1` contract are unchanged.

## State compatibility

Version 0.1.0 reads `fallow-verdict-record/v1` records from the source preview.
Missing optional fields receive defaults. A record without a `kind` field loads as a
`security` record, and a run record without a `kind` field loads as a `security` run. Security
records keep their layout: one location in `path`, `line` and `col`, a severity, and the same
evidence summary. A record without `confirmationAnswers` stays valid and is remapped as before,
but a remap cannot make it `dismissed`: it gives `needs-human-review` with the rule
`dismissal-unconfirmed`. The next `judge` asks again for such a stored dismissal (see Staleness). Older evidence or engine settings can
make a stored decision stale, so the next assessment may require a Jev call.
Existing history is retained when those decisions are invalidated.

Before upgrading, stop active runs and back up `.fallow-verdict/`. There is no
automatic migration for an unsupported record schema. Invalid records stop
judgment and reporting with an error. To start again without losing the archive,
select a new `dataDir` in the config and run a fresh scan and assessment. This
creates new review history and can incur new Jev charges.

Future releases that change the stored schema must document the migration or
fresh-start procedure in their release notes. Keep the previous package version
and backup together if you need to return to an earlier review state.

## Failure handling

- Transient engine errors (408, 429, 5xx, 529, timeouts) are retried with jittered backoff and
  `retry-after` support.
- A rejected key opens the circuit breaker at once; repeated provider failures open it after a
  short streak. The run stops with exit code 2 instead of marking every candidate as errored.
  The dismissal confirmation call uses the same engine and breaker. A rejected key or an open
  circuit on that call also stops the run; the record keeps the review verdict.
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
