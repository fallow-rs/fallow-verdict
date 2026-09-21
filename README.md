# fallow-verdict

Verdicts for [`fallow security`](https://github.com/fallow-rs/fallow) candidates.

`fallow security` finds security candidates deterministically: syntactic sinks, ranked by
reachability over the module graph. It deliberately stops there. It does not decide whether a
candidate is exploitable. `fallow-verdict` adds that step. It builds a self-contained evidence
packet for every candidate, asks [Jev](https://docs.typesafe.ai) a fixed set of typed questions,
and maps the calibrated probabilities to one of fallow's three verdicts with a fixed, auditable
policy:

- `survivor`: the evidence supports a real exploit path
- `dismissed`: there is a named reason the candidate is not exploitable
- `needs-human-review`: everything else

The verdicts are written in the `fallow-security-verdict/v1` contract and post-validated by
`fallow security survivors`, so they plug into everything that already reads fallow output.

```bash
npm i -D fallow fallow-verdict
export TYPESAFE_API_KEY=...
npx fallow-verdict run
```

## How it differs from agent-based scanners

Agent scanners hand a coding agent a file list and let it investigate. That finds issues no
matcher anticipated, and it costs accordingly. `fallow-verdict` makes a different trade:

|                     | Agent scanner                         | fallow-verdict                                   |
| ------------------- | ------------------------------------- | ------------------------------------------------ |
| Candidates          | Regex matchers, then the agent's eyes | fallow's AST and module-graph analysis           |
| Judgment            | Free-form agent investigation         | Typed questions, calibrated probabilities        |
| Output of the model | Prose that has to be parsed           | Probabilities inside a schema, nothing to parse  |
| Policy              | Inside the prompt                     | Code you can read, configure, and test           |
| Model capabilities  | Shell, file reads, network            | None. It answers questions about a packet.       |
| Repeatability       | Varies run to run                     | Same evidence and policy give the same verdict   |
| Cost                | Agent turns per file                  | One small request per candidate, printed upfront |

It does not find vulnerabilities fallow did not flag. It triages what fallow found.

## What leaves your machine

Be clear-eyed about this before you run it.

- For each candidate, a packet is sent to the Jev API: fallow's candidate metadata plus numbered
  source windows (20 lines by default) around the sink, the source, the trace hops, and any
  detected defensive controls. Nothing else is read, and files outside the project root are never
  read, including through symlinks.
- `fallow-verdict scan` and `--dry-run` send nothing. Use `--dry-run` to see how many candidates
  would be sent and what it would cost.
- The API key is read from an environment variable and is never written to config or state.
- State in `.fallow-verdict/` contains candidate evidence. `init` adds it to `.gitignore`.
- There is no telemetry.

See [docs/privacy.md](docs/privacy.md) for the exact packet shape and the engine's data terms.

## Commands

| Command  | What it does                                                         | Engine calls |
| -------- | -------------------------------------------------------------------- | ------------ |
| `init`   | Write a starter config and ignore the state directory                | no           |
| `scan`   | Run `fallow security`, record candidates, resolve ones that are gone | no           |
| `judge`  | Judge pending candidates; skip those whose evidence is unchanged     | yes          |
| `report` | Write `verdicts.json` and `report.md`, validate through fallow       | no           |
| `run`    | `scan`, `judge`, `report`                                            | yes          |
| `status` | Show what is recorded                                                | no           |
| `eval`   | Score stored verdicts against a labels file                          | no           |

Every command takes `--format json`. Useful flags on `judge` and `run`: `--dry-run`, `--limit`,
`--max-cost-usd`, `--max-duration`, `--rejudge`, `--changed-since <ref>`.

Exit codes: `0` nothing at or above `--fail-on`, `1` verdicts at or above `--fail-on`
(default `survivor`), `2` invalid input or execution error, `130` interrupted.

## Why you can trust a dismissal

A wrong `survivor` costs a reviewer a few minutes. A wrong `dismissed` hides a vulnerability. The
policy is asymmetric for that reason. A candidate is dismissed only when all of this holds:

1. P(exploitable) is below the bar for its severity (stricter for `high`).
2. There is a named reason that is itself strong: not attacker-controlled, does not reach the
   sink, mitigated, or non-production code.
3. The evidence was complete. Packets that had to be cut to fit the budget are never dismissed.
4. The code does not argue for its own assessment. A canary question looks for comments or
   strings addressed at reviewers or tools; when it fires, the candidate goes to a human.

Everything that fails these checks is `needs-human-review`, never silently dropped. Each stored
decision records the rule that produced it, the probabilities behind it, the model version, and
an append-only history, so a verdict that flips stays visible.

Verdicts are triage results, not proof. Measure before you rely on them:
[docs/evaluation.md](docs/evaluation.md).

## Resumable and incremental

Each candidate has a record keyed by fallow's stable `finding_id`. A verdict is tied to a
fingerprint of the evidence it was made on. Run again and only new candidates, changed code, and
earlier errors are judged. Candidates fallow stops reporting become `resolved`. Budget caps stop
at a safe point; the next run continues.

## Documentation

- [Architecture](docs/architecture.md): pipeline, state layout, design decisions
- [Configuration](docs/configuration.md): config file and policy thresholds
- [Questions and policy](docs/questions.md): the question set and how answers become verdicts
- [Evaluation](docs/evaluation.md): labels format and the metrics that matter
- [Privacy](docs/privacy.md): what is sent, what is stored
- [CI](docs/ci.md): running on pull requests

## License

MIT
