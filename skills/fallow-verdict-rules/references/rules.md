# Review rules: details

## Fallow first

Use a Fallow rule when the rule is about structure, not about meaning. Fallow checks it for free
on each save, commit and pull request. Read `fallow config-schema` for the keys that the
installed Fallow version supports, and `fallow guard <files>` for the architecture rules that
apply to a file.

| The rule says                               | Fallow option                                                        |
| ------------------------------------------- | -------------------------------------------------------------------- |
| "The UI does not import the database layer" | `boundaries`: zones and the allowed imports                          |
| "Only the API client calls `fetch`"         | `boundaries.calls.forbidden`, or a `banned-call` rule in a rule pack |
| "Do not import `lodash`"                    | A `banned-import` rule in a rule pack                                |
| "Do not write to disk in this directory"    | A `banned-effect` rule in a rule pack                                |
| "Functions stay short and simple"           | `health`: `maxCyclomatic`, `maxCognitive`, `maxUnitSize`             |
| "No unused exports", "no circular imports"  | Default Fallow analyses. No rule is necessary.                       |

Rule packs are JSON files that the Fallow config names in `rulePacks`. They report
`policy-violation` findings.

## When a review rule fits

A review rule fits when the rule is about what the code does, and no syntax check can decide it.
Examples:

- "This function takes its configuration as arguments and does not read process.env."
- "This handler checks that the user owns the record before it changes the record."
- "This function returns a new array and does not change its argument."

## Format

A review rule is an entry of `review.rules` in `fallow-verdict.config.{ts,mjs,js,json}`:

```json
{
  "review": {
    "rules": [
      {
        "name": "env-read-once",
        "where": "src/**/*.ts",
        "except": ["src/config/**"],
        "ensure": "This function takes its configuration as arguments and does not read process.env."
      }
    ]
  }
}
```

| Field    | Meaning                                                                                       |
| -------- | --------------------------------------------------------------------------------------------- |
| `name`   | Unique. Lowercase letters, digits and `-`. The question id is `rule_<name>` with `_` for `-`. |
| `where`  | One glob or a list of globs of project-relative files                                         |
| `except` | Optional globs of files that the rule does not cover                                          |
| `ensure` | The sentence that a function in scope must satisfy                                            |
| `floor`  | Optional minimum probability of a breach. The default is `review.ruleFloor`.                  |

## How to write `ensure`

- Write one fact about one function. Start with "This function".
- State what must be true, not what is bad. "Takes its configuration as arguments" is better
  than "Does not have bad config handling".
- Do not ask about importance, quality or style. The answer to such a question is not reliable.
- Keep `where` narrow. Each rule adds one question to the request of each function in scope.
  It does not add a request.
- A change to `floor` or `review.ruleFloor` is a threshold change. The user decides.

## Try a rule

Run review mode on a small path that has a known breach and a known correct function. The
breach must have a high `rule_<name>` probability. The correct function must have a low one.
When they do not, the sentence is not clear. Propose a new sentence to the user.
