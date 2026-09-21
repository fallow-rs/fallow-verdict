# fallow-verdict

Verdicts for [`fallow security`](https://github.com/fallow-rs/fallow) candidates.

`fallow security` finds security candidates deterministically: syntactic sinks, ranked by
reachability over the module graph. It deliberately stops there. It does not decide whether a
candidate is exploitable. `fallow-verdict` adds that step. It builds a self-contained evidence
packet for every candidate, asks [Jev](https://docs.typesafe.ai) a fixed set of typed questions,
and maps the returned probabilities to one of fallow's three verdicts with a fixed, auditable
policy:

- `survivor`: the evidence supports a real exploit path
- `dismissed`: there is a named reason the candidate is not exploitable
- `needs-human-review`: everything else

The verdicts are written in the `fallow-security-verdict/v1` contract and post-validated by
`fallow security survivors`, so they plug into everything that already reads fallow output.

Development preview, requires Node 22.18 or newer. Install from this repository until an npm
release is available:

```bash
git clone https://github.com/fallow-rs/fallow-verdict.git
cd fallow-verdict
npm ci
npm run build
# Set TYPESAFE_API_KEY in your shell, then:
node bin/fallow-verdict.js run --cwd /path/to/project
```

The project being scanned needs `fallow` installed (`npm i -D fallow`), or available on `PATH`.
See [validation.md](docs/validation.md) for measured behavior and [roadmap.md](docs/roadmap.md)
for the next development gates. The optional category question profile removes safe examples
in the development corpus, but shows limited and variable improvement on a separately authored
pilot holdout. See the [paired evaluation](docs/evaluation-v2.md) and
[actual report output](docs/examples/category-report.md). The default remains `generic`.

## Scope

This package triages candidates that fallow already found. It does not discover vulnerabilities
outside fallow's catalogue or investigate with a shell. The decision engine sees a bounded
packet; code applies a deterministic policy to its answers. Reusing stored answers is
repeatable, while a fresh model call can return different probabilities.

[Vercel deepsec](https://github.com/vercel-labs/deepsec) performs broader agent-based vulnerability
investigation. [Sentry Warden](https://github.com/getsentry/warden) runs skill-based reviews locally
and on pull requests, with GitHub Checks and inline findings. Neither comparison establishes
accuracy parity. A shared, independently labeled evaluation is needed for that claim.

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
`--max-cost-usd`, `--max-duration`, `--rejudge`, `--changed-since <ref>`,
`--question-profile generic|category`. The category profile is experimental.

Exit codes: `0` nothing at or above `--fail-on`, `1` verdicts at or above `--fail-on`
(default `survivor`), `2` invalid input, execution error, or incomplete judgment, `130` interrupted.

## Why you can trust a dismissal

A wrong `survivor` costs a reviewer a few minutes. A wrong `dismissed` hides a vulnerability. The
policy is asymmetric for that reason. A candidate is dismissed only when all of this holds:

1. P(exploitable) is below the bar for its severity (stricter for `high`).
2. There is a named reason that is itself strong: not attacker-controlled, does not reach the
   sink, mitigated, or non-production code.
3. All requested source locations were readable and in range. Packets cut to fit the budget are never dismissed. Source windows still omit surrounding code.
4. The code does not argue for its own assessment. A canary question looks for comments or
   strings addressed at reviewers or tools; when it fires, the candidate goes to a human.

Everything that fails these checks is `needs-human-review`, never silently dropped. Each stored
decision records the rule that produced it, the probabilities behind it, the model version, and
an append-only history, so a verdict that flips stays visible.

Verdicts are triage results, not proof. Measure before you rely on them:
[docs/evaluation.md](docs/evaluation.md).

## Resumable and incremental

Each candidate has a record keyed by fallow's stable `finding_id`. A verdict is tied to a
fingerprint of the evidence it was made on and the requested model and endpoint. Run again and
only new candidates, changed evidence, changed questions, changed engine configuration, and earlier errors are judged. Candidates fallow stops reporting become `resolved`. Budget caps stop
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

## Cost and completeness

`--max-cost-usd` limits estimated request spend, including reservations for concurrent requests.
It is not a provider billing cap: token estimates, retries, timeouts after provider processing,
and future pricing changes can differ from the recorded successful-response usage. Configure
provider-side limits when a hard billing cap is required.

`report` and `eval` recheck source fingerprints and apply the current policy without engine calls.
Incomplete reports exit 2 even with `--fail-on off`. Changes outside collected source windows
may require `--rejudge` and a larger `packet.radius`. Correlated model errors and prompt injection
can still produce incorrect decisions; the canary is a routing heuristic, not a security boundary.
