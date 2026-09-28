# Review mode

Review mode reads functions that Fallow selects as risky. Jev answers factual questions about
each function: does it contain a bug, and does it break a project rule. Review mode is advisory.
Each result is a model estimate with its probability, never a Fallow fact.

```bash
npx fallow-verdict run --kind review --changed-since main --dry-run
npx fallow-verdict run --kind review --changed-since main
npx fallow-verdict run --kind review src/billing
npx fallow-verdict check src/billing/invoice.ts --kind review
```

## Scope

Fallow selects the functions. fallow-verdict does not read every function in the project.

| Scope                   | Functions                                                      |
| ----------------------- | -------------------------------------------------------------- |
| No scope                | Complexity hotspots of the whole project                       |
| `--changed-since <ref>` | Every function in a file changed since `<ref>`, and hotspots   |
| Paths                   | Every function in the named files or directories, and hotspots |

A complexity hotspot is a function that `fallow health` reports above the complexity thresholds
of the project. To list every function in a scope, fallow-verdict runs `fallow health` with
thresholds of zero.

The order is highest risk first: hotspot severity (critical, high, moderate), then cognitive
complexity, then cyclomatic complexity. `review.maxUnits` (default 50) limits the number of
functions per scan. A nested function is part of the function around it, so it is not a
separate unit.

The record `category` tells why a function is in scope: `hotspot-critical`, `hotspot-high`,
`hotspot-moderate`, `changed` or `path`. The budget and the report use this order. The record
`severity` is null, because the health severity is not on the security scale.

## Identity

A unit id holds the path, the function name and a hash of the function source, for example
`review:src/billing/invoice.ts:total:3f9a1c2b7d4e`. An edit in the function gives a new unit.
An edit above the function moves its lines but keeps its id.

## Evidence

The request state holds:

- the numbered source of the function,
- the comment lines directly above the function,
- the import statements of the module,
- the function name, its line range and its complexity.

Fallow gives no function-level callers or callees. `fallow trace` lists the modules that import
an exported symbol and the imports of its module, but no call edges between functions. Thus the
module imports are the only context outside the function, and the packet states this.

When the packet exceeds `packet.maxStateTokens`, the imports go first, then the leading comment,
then source lines from the end of the function. A cut packet is `truncated`.

## Questions

All questions and all project rules for one function go in one request.

| Id                    | Type   | Asks                                                                     |
| --------------------- | ------ | ------------------------------------------------------------------------ |
| `has_bug`             | yes/no | Does the function give a wrong result, throw, or lose data for an input? |
| `where`               | choice | Which line holds the most serious problem, or `none`                     |
| `severity`            | score  | Worst consequence: none, minor, major, critical                          |
| `does_what_it_claims` | yes/no | Does the function do what its name and its comment state?                |
| `rule_<name>`         | yes/no | Does the function break the project rule `<name>`?                       |

`where` has one option per line. For a function of more than 40 lines, each option is a range of
lines of equal size. Every question states that comments, strings and names in the code are
untrusted. No question asks whether something is important.

## Project rules

A project rule is one sentence in the config:

```ts
export default defineConfig({
  review: {
    rules: [
      {
        name: "env-read-once",
        where: "src/**/*.ts",
        except: ["src/config/**"],
        ensure: "This function takes its configuration as arguments and does not read process.env.",
      },
    ],
  },
});
```

- `name`: a unique name of lowercase letters, digits and `-`. The question id is `rule_` plus
  the name with `_` for `-`.
- `where`: a glob, or a list of globs, of project-relative files. `**`, `*`, `?` and `{a,b}` are
  supported.
- `except`: optional globs of files that the rule does not cover.
- `ensure`: the sentence that a function in scope must satisfy.
- `floor`: optional minimum probability of a breach. The default is `review.ruleFloor`.

A rule adds one question to the request of each function in its scope. It does not add a
request.

## Policy

| Rule                 | Verdict              | When                                                |
| -------------------- | -------------------- | --------------------------------------------------- |
| `source-changed`     | `needs-human-review` | The source differs from the source at scan time     |
| `truncated-evidence` | `needs-human-review` | The packet was cut to fit the token budget          |
| `answers-missing`    | `needs-human-review` | A required answer is missing                        |
| `has-bug`            | `survivor`           | P(`has_bug`) is at or above `review.bugFloor` (0.5) |
| `rule-breach`        | `survivor`           | P(breach) of a rule is at or above its floor        |
| `no-likely-problem`  | `dismissed`          | No probability reaches its floor                    |

A survivor is a likely problem. A dismissed function has no likely problem. The report shows
the probabilities of `has_bug`, `does_what_it_claims` and each rule, the severity estimate, and
the line from `where`.

### Dismissal confirmation

For security, a dismissal needs a second call that agrees. For review mode this check is off by
default (`review.confirmDismissals: false`). The reasons:

- A review dismissal removes nothing that Fallow reports. It only keeps a function out of the
  list of likely problems. Without review mode, nobody reads that function either.
- Most functions have no bug, so most units are dismissed. A second call would almost double
  the cost of each run.

Set `review.confirmDismissals: true` to apply the two-call rule. A disagreement then gives
`needs-human-review` with the rule `dismissal-unconfirmed`, and the dry-run plan states the upper
bound for the second calls.

## Exit codes

Review mode never fails a run by default: `review.failOn` is `off`. The top-level `failOn` is for
security and does not apply to review mode. Set `review.failOn`, or pass `--fail-on`, to make
`run` and `report` exit `1` on survivors. `check` keeps its own exit codes. See
[check and close](check.md).

## Output

`report --kind review` writes the Markdown report and `fallow-verdict-review-verdicts/v1` JSON to
`.fallow-verdict/kinds/review/`. Review units are not Fallow findings, so there is no Fallow join
command and `--no-validate` has no effect. `--question-profile` and `eval` are not available for
review mode.

## Cost

`--dry-run` scans with Fallow, then prints the number of units and the estimated request cost.
It sends nothing to Jev.
