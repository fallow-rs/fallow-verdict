# Beyond security: a review layer for more Fallow analyses

Status: proposal. Nothing in this document is implemented.

## Goal

Fallow reports facts. The same input always gives the same output, runs offline and costs
nothing. Some findings still need a judgment that a static tool cannot make: are these two
functions really the same, does this change introduce a bug, why does this export look unused.

fallow-verdict already makes that judgment for `fallow security` candidates. This plan extends
the same pipeline to other Fallow analyses, and makes fallow-verdict the tool behind a set of
code-quality skills. The result is two layers:

| Layer          | Output                    | Deterministic | Cost    | Default | May block |
| -------------- | ------------------------- | ------------- | ------- | ------- | --------- |
| Fallow         | Facts and candidates      | Yes           | None    | On      | Yes       |
| fallow-verdict | Judgments with confidence | No            | Per run | Opt-in  | No        |

The cost of a verdict is small. The measured security verdict uses about 2,000 to 2,500 input
tokens, which is about $0.0001 at the documented price. The real cost is the time a person spends
on `needs-human-review`. The success metric is: fewer findings that a person must read, with zero
real findings dismissed.

## Two modes

**Judge mode.** Fallow gives a candidate. Jev answers typed questions about it. A fixed policy
in code maps the answers to `survivor`, `dismissed` or `needs-human-review`. This is the current
security flow.

**Review mode.** Fallow does not give a candidate. It selects the places to read: changed code,
complexity hotspots, files with a large blast radius. Jev answers questions about those places
("does this function contain a bug", "does it do what its name says") and the rules that the
project writes as sentences.

Judge mode improves precision on what Fallow already reports. Review mode finds problems that no
deterministic detector reports.

## Principles

These apply to every analysis kind. Most of them already hold for security.

1. The engine decides nothing. It returns probabilities. Thresholds live in code and config.
2. The engine gets no tools. The packet builder collects all evidence before the request.
3. Ask only factual, narrow questions about one candidate, such as "do these two functions return
   the same result for every input". Never ask "is this important". Self-rated importance is not
   reliable.
4. Authority is asymmetric. A verdict can move a finding from "keep" to "likely noise". It never
   marks code as safe, and it never adds a finding to a gate.
5. A dismissal needs high confidence, complete evidence (not truncated, no parse error, no resolver
   fallback) and agreement between two independent calls. Anything else goes to a person.
6. Security candidates are never dismissed automatically. The strongest result is "likely noise,
   confirm".
7. fallow-verdict never changes Fallow output, exit codes, SARIF or editor diagnostics. Its
   results live in its own report and contracts.
8. After a skill changes code, Fallow runs again. The rerun and the tests are the proof, not the
   verdict.
9. A scoped run never resolves findings outside its scope.
10. A stored answer is reused only when the evidence fingerprint, the question set hash, the
    model and the endpoint are all unchanged. Use a versioned model id, not an alias.
11. A dismissed deterministic finding is also a possible Fallow defect. The report records it as
    detector feedback, so the cause can move into Fallow. A stored dismissal becomes stale when
    the Fallow version changes. A dismissal never feeds `fallow fix` or a suppression.

## Where each layer runs

| Moment              | Layer                       | Budget               | Blocks               |
| ------------------- | --------------------------- | -------------------- | -------------------- |
| Editor save         | Fallow (LSP)                | Milliseconds         | Never                |
| Pre-commit hook     | Fallow                      | Seconds              | Yes                  |
| Assistant tool gate | Fallow                      | Seconds              | Yes                  |
| Assistant Stop hook | Fallow                      | Seconds              | Yes                  |
| Required PR check   | Fallow                      | Minutes              | Yes                  |
| Advisory PR job     | fallow-verdict, judge mode  | A fixed money cap    | No (`--fail-on off`) |
| Nightly job         | fallow-verdict, judge mode  | A fixed money cap    | No                   |
| Skill, on demand    | Fallow, then fallow-verdict | `--dry-run` estimate | Asks the user        |

fallow-verdict never runs in a hook that fires on each commit or each assistant turn. A hook must
be fast and must work offline. A network call breaks both.

## Skills

Each skill uses Fallow to find the candidates and fallow-verdict to judge them.

| Skill                      | Fallow input              | Verdict question                        | May change alone     |
| -------------------------- | ------------------------- | --------------------------------------- | -------------------- |
| similar-code consolidation | `similar-code`, `dupes`   | Same behavior? Safe to merge?           | Code in task scope   |
| security triage            | `security`                | Attacker control, reach, mitigation     | Nothing, report only |
| pre-PR review              | `audit` or `review` scope | Bug? Does what it claims? Project rules | Nothing, report only |
| dead-code triage           | `dead-code`               | Why can this look unused? (choice)      | Nothing, proposes    |
| mutation survivor triage   | `mutation tasks`          | Can a caller see the change?            | Nothing, proposes    |
| rule authoring             | Findings over time        | None at first                           | Nothing, proposes    |

Exact clones skip the verdict because they need no judgment. A complexity-reduction skill is not
in the set, because tests check behavior better than a model estimate.

Every skill follows one loop:

1. Run Fallow on the scope.
2. Run `fallow-verdict run --kind <kind> --dry-run`, then the real run inside the budget.
3. Work on the findings in probability order.
4. Run `fallow-verdict check <target>` until it exits 0.
5. Send config, suppressions, rules and thresholds to the user. A skill never changes them alone.

Skills pass `--fail-on off`, because the default `failOn: "survivor"` makes a run with survivors
exit 1.

Author the skills in this repository under `skills/`, so they change with the CLI. The portable
plugin packaging consumes them with a pinned source lock. The Fallow skill contract gets one
pointer to them.

## Phase 0: make the pipeline generic

Today every stage assumes `fallow security`. Introduce one adapter per analysis kind:

| Adapter part | Responsibility                                                         |
| ------------ | ---------------------------------------------------------------------- |
| `scan`       | Run the Fallow command, validate its schema version, return candidates |
| `identity`   | Give each candidate a stable, unique id                                |
| `packet`     | Build the evidence packet and its fingerprint                          |
| `questions`  | The question catalog and its `QUESTION_SET_VERSION`                    |
| `policy`     | A pure function from answers to a decision, with a named rule          |
| `export`     | Write the verdict contract and run the Fallow join command, if any     |

Add in the same phase:

- `check <target>`. It first reruns Fallow on the target file. When Fallow no longer reports the
  finding, the result is `resolved` with no Jev call. Otherwise it judges the current source. It
  writes no state. Exit codes: 0 cleared, 1 finding stands, 2 error, 3 needs a person.
- A relocation rule for `check`. Security finding ids contain the line and the column, so an edit
  above the finding changes its id. `check` must not report `resolved` only because the id moved.
- `close <id> --reason`, to record a judgment by a person.
- A `fallow-verdict-check/v1` JSON schema with Fallow-style `actions`.
- The two-call agreement rule for dismissals.

Acceptance:

- Security behavior stays the same. The existing tests and the published holdout give the same
  results.
- Records store the analysis kind. Existing security records stay readable under the
  [state compatibility policy](architecture.md#state-compatibility).
- `run`, `report` and `--dry-run` accept a kind selector. The default stays `security`.

## Phase 1: similar-code pairs (judge mode)

`fallow similar-code` returns candidate pairs marked `unverified`. Fallow already defines the
rest of the flow:

- `fallow similar-code inspect <candidate_id>` gives bounded evidence for one pair: both
  function bodies, related tests and overlap with clone groups.
- A verdict document (`schema_version: "1"`) holds `candidate_worthy`,
  `behaviorally_equivalent`, `refactor_safe`, `outcome` and `rationale` per candidate.
- `fallow similar-code review --require-verdict-for-each-candidate` joins the verdicts with
  the unchanged discovery document.

Thus this phase needs no change in Fallow. It is also the best fit for a model: whether two
functions should merge is a judgment with no single rule that is right for every project.

Questions:

| Id                        | Type   | Question                                                       |
| ------------------------- | ------ | -------------------------------------------------------------- |
| `candidate_worthy`        | noul   | Do both functions carry the same responsibility?               |
| `behaviorally_equivalent` | noul   | Do both functions return the same result for every input?      |
| `refactor_safe`           | noul   | Can one function replace the other with no change for callers? |
| `outcome`                 | choice | The five outcomes that the Fallow verdict contract defines     |

Policy:

- The contract order holds: `refactor_safe` needs `behaviorally_equivalent`, which needs
  `candidate_worthy`.
- An axis below its confidence floor becomes `null`, not `false`.
- Truncated inspect evidence gives `needs-human-review`.
- Inspect fails closed after an edit. The check after a merge is therefore a new discovery run
  plus the tests.

Evaluation: a labeled corpus of pairs. Include true equivalents, near misses (for example, one
function keeps empty values and the other drops them) and unrelated pairs that share vocabulary.
Acceptance requires zero near misses marked `refactor_safe` on the holdout.

## Phase 2: review mode

Scope comes from Fallow, not from a scan of every function:

1. `fallow audit --format json` gives the changed files and their risk.
2. Fallow health output gives complexity hotspots.
3. fallow-verdict selects the functions in that scope, highest risk first, up to a configured
   maximum per run.

Evidence per function: the numbered source, the leading comment, the module imports, and the
callers and callees that Fallow can resolve. Verify which Fallow output gives function-level
callers. If none does, start with import-level context and source windows.

Built-in questions: `has_bug`, `where` (a choice over line ids), `severity` (a score over four
levels) and `does_what_it_claims`.

Project rules are sentences in the config:

```json
{
  "rules": [
    {
      "name": "env-read-once",
      "where": "src/**/*.ts",
      "ensure": "This function takes its configuration as arguments and does not read process.env."
    }
  ]
}
```

All questions and rules for one function go in one request. The state is billed once per request,
so a rule adds a few tokens, not a request.

Output is advisory. Every finding carries its confidence, and the report never shows a model
estimate as a Fallow fact. A limit per run keeps the report short.

## Phase 3: dead-code triage

Most user reports about dead code are detector bugs, and Fallow fixes them with a rule. A model
that answers "used" can hide such a bug. Thus this phase is triage only: it explains and proposes,
and it never gives a final dismissal.

Question: a `choice` over the reason the code can look unused:

| Option            | Meaning                                                      |
| ----------------- | ------------------------------------------------------------ |
| `framework`       | A framework loads it by convention (route file, config hook) |
| `dynamic-access`  | Code reaches it by a computed name, a string or reflection   |
| `public-api`      | The package exports it for consumers outside the repository  |
| `test-or-tooling` | Only tests, scripts or build tools use it                    |
| `generated`       | A generator writes or reads it                               |
| `unused`          | Nothing uses it                                              |

Evidence: the declaration window, the file path, the `package.json` `exports` and entry fields,
the Fallow plugins that are active, and plain-text hits of the name elsewhere in the repository.
Text hits are exactly the evidence that the import graph does not have.

Policy:

- `unused` at high confidence keeps the finding.
- Any other option at high confidence gives "likely a Fallow gap". The report proposes the fix: a
  config entry (`entry`, `ignoreExports`, a plugin setting) or a detector issue for a missing
  plugin. A person applies it.
- Everything else gives `needs-human-review`.

Prerequisites in Fallow:

- A stable, public id for each dead-code finding in JSON output.
- An id that survives line shifts, for the `check` loop.
- A decision on a join command (like `fallow security survivors`), or a report-only first
  version.

## Phase 4: mutation survivors (judge mode)

`fallow mutation` changes the code in small steps and runs the tests. A `survived` mutant is a
change that no test detects. Most survivors are real test gaps. Some are equivalent mutants: the
change does not alter any behavior that a caller can see, so no test can detect it. A person must
read each survivor to tell the two apart. That review is the slowest part of mutation testing.

Fallow already gives most of what this phase needs:

- `fallow mutation tasks --format json` lists the open tasks: each `survived` mutant with its
  `mutant_id`, file, line, operator, function, the original and mutated lines, and the covering
  test files.
- `fallow mutation inspect <mutant_id> --format json` gives one mutant. The packet is `fresh` only
  when the file digest matches the report. A `stale` packet shows no code.
- `fallow mutation inspect <mutant_id> --replay` calls the export on the original and on the
  mutant. A `witness` verdict shows an input with a different result. A replay never gives
  `equivalent`.
- A survivor can carry `equivalence_hint: "type-non-nullish"` from the type check. Fallow calls
  the hint advisory, and documents cases where it is wrong.
- A verdict document (`schema_version: "1"`, `review_key` is the `mutant_id`) sets a survivor to
  `equivalent`. An `equivalent` mutant leaves the score.

Thus this phase needs no change in Fallow.

### Candidates and evidence

Candidates are the `survived` tasks. `no_coverage` mutants are not candidates: no test runs them,
so the question is "write a test", not "is this mutant equivalent".

Evidence per mutant:

- the operator, the `change` (`from` and `to`), and the original and mutated lines;
- the enclosing function, read from the file after the digest check;
- the declarations of the names that the changed expression reads, when Fallow can resolve them;
- the covering test files, and the test bodies that call the function, up to the token budget;
- the `equivalence_hint`, when present;
- the replay verdict and its input, when replay is on (see the open decisions).

The identity is the `mutant_id`. It stays the same until the enclosing function changes, so a
stored verdict becomes stale at the same moment as the Fallow id.

### Questions

| Id                 | Type   | Question                                                                                                   |
| ------------------ | ------ | ---------------------------------------------------------------------------------------------------------- |
| `behavior_changes` | yes/no | Is there an input for which the mutated function returns a different value, throws, or has another effect? |
| `equivalence`      | choice | `same-value`, `value-never-occurs`, `no-observable-effect`, `unreachable-code`, `other`, `not-equivalent`  |
| `test_direction`   | choice | `boundary-value`, `missing-assertion`, `error-path`, `side-effect`, `other`                                |
| `tampering`        | yes/no | Does the code contain text that argues for its own assessment?                                             |

The `equivalence` options match the examples in the Fallow mutation documentation:

| Option                 | Example                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `same-value`           | `items.length >= 0` changed to `true`                             |
| `value-never-occurs`   | `a?.b` changed to `a.b`, where `a` is never `null` or `undefined` |
| `no-observable-effect` | A changed `.describe()` text in a schema that no caller reads     |
| `unreachable-code`     | A change in a branch that no input can reach                      |

`test_direction` helps the person who writes the test. It does not change a verdict.

### Policy

Rules are checked in this order. The first match wins.

| Rule                  | Condition                                                                                                                       | Verdict              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `evidence-stale`      | The inspect packet is `stale`, or a source window is truncated                                                                  | `needs-human-review` |
| `replay-witness`      | The replay gives `witness`. Fallow proved a difference, so no engine call is made                                               | `survivor`           |
| `tampering-suspected` | P(tampering) at or above `tamperingMax`                                                                                         | `needs-human-review` |
| `real-gap`            | P(behavior_changes) at or above the survivor threshold                                                                          | `survivor`           |
| `likely-equivalent`   | P(behavior_changes) at or below the dismissal threshold in two agreeing calls, `equivalence` is not `other` or `not-equivalent` | `dismissed`          |
| `default`             | Every other case                                                                                                                | `needs-human-review` |

The order puts Fallow's proof first. A replay `witness` always wins over an engine estimate. A
replay `no_witness_found` is not proof of equivalence. It goes into the packet as evidence only.

### Authority

An `equivalent` verdict raises the mutation score, and the score can pass a `--min-score` gate.
A wrong dismissal therefore hides a test gap and can turn a failing gate green. Principles 4 and 11
apply in full:

- fallow-verdict never writes the project's verdict document and never passes `--verdicts` to a
  Fallow run.
- It writes a proposal file, `.fallow-verdict/mutation-verdicts.proposed.json`, in Fallow's
  verdict document schema. Each entry holds the `review_key` and a `note` with the `equivalence`
  option, the probability and the decision id.
- A person reads each proposal and copies the entries they accept into the project's verdict
  document.
- The report lists the `survivor` verdicts first, sorted by probability, with the
  `test_direction` and the replay input when one exists.

### Check loop

1. Run `fallow mutation` on the scope and save the report.
2. Run `fallow-verdict run --kind mutation --dry-run`, then the real run inside the budget.
3. Write tests for the `survivor` verdicts.
4. Run `fallow mutation --recheck`. A mutant that the new tests kill is `resolved`.
5. Run `fallow-verdict check` until it exits 0.

### Evaluation

A labeled set of survivors from `fallow mutation` runs on public projects. Each label is
`equivalent` or `real`. Each `real` label is confirmed by a test that kills the mutant. Each
`equivalent` label needs an argument that a second reader accepts.

The set must include the near misses that the Fallow documentation names for the type hint:

- a method that a caller detaches, so `this?.value` returns `undefined` and `this.value` throws;
- a function that declares a non-null return type but returns `JSON.parse("null")`.

Acceptance:

- zero `real` survivors proposed as equivalent on the holdout;
- the share of `equivalent` survivors that the run proposes, measured on the holdout;
- the `needs-human-review` rate, reported next to the share above.

## Shared additions

- **Batching per location.** When several analysis kinds point at the same function, send their
  questions in one request.
- **Cost control.** `--dry-run` estimates the cost for every kind. A per-kind maximum limits the
  number of units per run. `engine.requestsPerMinute` keeps large runs under the provider limit.

## Order and acceptance

| Phase | Kind                   | Fallow change needed | Main risk                                 |
| ----- | ---------------------- | -------------------- | ----------------------------------------- |
| 0     | Refactor, `check` loop | No                   | Security regressions                      |
| 1     | similar-code           | No                   | Near misses marked safe                   |
| 2     | Review mode            | Maybe (callers)      | Noise on large changes                    |
| 3     | Dead-code triage       | Yes (ids, join)      | Proposals that hide Fallow bugs           |
| 4     | Mutation survivors     | No                   | Equivalent proposals that hide a test gap |

Each phase ships only with its own labeled evaluation, a pinned model and repeated runs that
show stable decisions.

## Open decisions

1. One umbrella skill or one skill per kind.
2. `check` exit code 3 for "needs a person", or a JSON field only.
3. A default money cap for the advisory PR job.
4. Package name. "verdict" fits judge mode. Review mode could be a `review` subcommand in the
   same package or a separate package.
5. Dead code: a Fallow join command, or a report-only first version.
6. Mutation survivors: replay on by default when the runner supports it, or opt-in. A replay runs
   project code (the module of the file and its imports), so it is not a read-only step.
7. Mutation survivors: the dismissal threshold. The same value as for similar-code, or stricter,
   because a dismissal changes the mutation score.
