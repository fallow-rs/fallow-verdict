# Beyond security: a review layer for more Fallow analyses

Status: proposal. Nothing in this document is implemented.

## Goal

Fallow reports facts. The same input always gives the same output, runs offline and costs
nothing. Some findings still need a judgment that a static tool cannot make: is this unused
export really unused, are these two functions really the same, does this change introduce a bug.

fallow-verdict already makes that judgment for `fallow security` candidates. This plan extends
the same pipeline to other Fallow analyses. The result is two layers:

| Layer          | Output                    | Deterministic | Cost    | Default |
| -------------- | ------------------------- | ------------- | ------- | ------- |
| Fallow         | Facts and candidates      | Yes           | None    | On      |
| fallow-verdict | Judgments with confidence | No            | Per run | Opt-in  |

## Two modes

**Judge mode.** Fallow gives a candidate. Jev answers typed questions about it. A fixed policy
in code maps the answers to `survivor`, `dismissed` or `needs-human-review`. This is the current
security flow.

**Review mode.** Fallow does not give a candidate. It selects the places to read: changed code,
complexity hotspots, files with a large blast radius. Jev answers open questions about those
places ("does this function contain a bug", "does it do what its name says") and the rules that
the project writes as sentences.

Judge mode improves precision on what Fallow already reports. Review mode finds problems that no
deterministic detector reports.

## Principles

These apply to every analysis kind. Most of them already hold for security.

1. The engine decides nothing. It returns probabilities. Thresholds live in code and config.
2. The engine gets no tools. The packet builder collects all evidence before the request.
3. fallow-verdict never changes Fallow output, exit codes, SARIF or editor diagnostics. Its
   results live in its own report and contracts.
4. Uncertain, truncated or conflicting evidence goes to a person. It never gives an automatic
   dismissal.
5. A scoped run never resolves findings outside its scope.
6. A stored answer is reused only when the evidence fingerprint, the question set hash, the
   model and the endpoint are all unchanged.
7. A dismissed deterministic finding is also a possible Fallow defect. The report records it as
   detector feedback, so the cause can move into Fallow instead of staying in the review layer.

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

Thus this phase needs no change in Fallow.

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

Evaluation: a labeled corpus of pairs. Include true equivalents, near misses (for example, one
function keeps empty values and the other drops them) and unrelated pairs that share vocabulary.
Acceptance requires zero near misses marked `refactor_safe` on the holdout.

## Phase 2: dead code (judge mode)

Unused exports, files and class members are the Fallow findings with the most false positives
in practice. The usual cause is a mechanism that a static graph does not see.

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
- Any other option at high confidence gives `dismissed` with the option as the reason. The
  report also suggests the Fallow fix: a config entry (`entry`, `ignoreExports`, a plugin
  setting) or a detector issue for a missing plugin.
- Everything else gives `needs-human-review`.

Prerequisites in Fallow, to verify before the work starts:

- A stable, unique id for each dead-code finding in JSON output.
- A decision on a join command (like `fallow security survivors`), or a report-only first
  version.

## Phase 3: review mode

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

All questions and rules for one function go in one request. A rule adds questions, not requests.

Output is advisory by default. A project can make it fail CI only with explicit config. Every
finding carries its confidence, and the report never shows a model estimate as a Fallow fact.

## Shared additions

- **`check <id>`.** Re-judge one finding against the current source on disk. Write no state.
  Exit non-zero while the finding stands. This gives an edit loop for a developer or a coding
  assistant.
- **Batching per location.** When several analysis kinds point at the same function, send their
  questions in one request.
- **Cost control.** `--dry-run` estimates the cost for every kind. A per-kind maximum limits the
  number of units per run.

## Order and acceptance

| Phase | Kind         | Fallow change needed | Main risk                        |
| ----- | ------------ | -------------------- | -------------------------------- |
| 0     | Refactor     | No                   | Security regressions             |
| 1     | similar-code | No                   | Near misses marked safe          |
| 2     | Dead code    | Yes (ids, join)      | Dismissals that hide Fallow bugs |
| 3     | Review mode  | Maybe (callers)      | Cost and noise on large changes  |

Each phase ships only with its own labeled evaluation, a pinned model and repeated runs that
show stable decisions.

## Open decisions

1. Package name. "verdict" fits judge mode. Review mode could be a `review` subcommand in the
   same package or a separate package.
2. Dead code: a Fallow join command, or a report-only first version.
3. Review mode: advisory only, or an optional CI gate.
