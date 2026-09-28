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

## Shared additions

- **Batching per location.** When several analysis kinds point at the same function, send their
  questions in one request.
- **Cost control.** `--dry-run` estimates the cost for every kind. A per-kind maximum limits the
  number of units per run. `engine.requestsPerMinute` keeps large runs under the provider limit.

## Order and acceptance

| Phase | Kind                   | Fallow change needed | Main risk                       |
| ----- | ---------------------- | -------------------- | ------------------------------- |
| 0     | Refactor, `check` loop | No                   | Security regressions            |
| 1     | similar-code           | No                   | Near misses marked safe         |
| 2     | Review mode            | Maybe (callers)      | Noise on large changes          |
| 3     | Dead-code triage       | Yes (ids, join)      | Proposals that hide Fallow bugs |

Each phase ships only with its own labeled evaluation, a pinned model and repeated runs that
show stable decisions.

## Open decisions

1. One umbrella skill or one skill per kind.
2. `check` exit code 3 for "needs a person", or a JSON field only.
3. A default money cap for the advisory PR job.
4. Package name. "verdict" fits judge mode. Review mode could be a `review` subcommand in the
   same package or a separate package.
5. Dead code: a Fallow join command, or a report-only first version.
