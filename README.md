# fallow-verdict

[`fallow security`](https://github.com/fallow-rs/fallow) flags JavaScript and TypeScript code
that might be vulnerable. `fallow-verdict` asks [Jev](https://docs.typesafe.ai) to
assess each finding using the surrounding code, then gives you a report with a
reason for each verdict. Uncertain findings stay in the report for you to review.

## Try the preview

The development preview is available from this repository. You need Node.js 22.18
or newer and a Jev API key to request assessments.

Clone and build the package:

```bash
git clone https://github.com/fallow-rs/fallow-verdict.git
cd fallow-verdict
npm ci
npm run build
verdict_source="$PWD"
```

In the same terminal, install it in the project you want to review:

```bash
cd /path/to/project
npm install --save-dev "$verdict_source" fallow
npx fallow-verdict init
npx fallow-verdict run --dry-run
```

The installation links to your source checkout, so keep that directory available.
`init` creates the config and adds the review data directory to `.gitignore`.
The dry run scans the project and estimates the cost without contacting Jev.

Set `TYPESAFE_API_KEY` through your shell or secret manager, keeping the value out
of the config file. Then run:

```bash
npx fallow-verdict run --show-dismissed
```

Results appear in the terminal and in `.fallow-verdict/report.md`, with a JSON
export at `.fallow-verdict/verdicts.json`. A completed run can exit with code `1`
when it finds a likely vulnerability.

## Read the results

| Verdict              | Meaning                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `survivor`           | The supplied evidence supports a likely vulnerability. Check the code before acting on a suggested fix.  |
| `dismissed`          | The assessment meets the dismissal rules and gives a reason, such as a protection that blocks the input. |
| `needs-human-review` | The assessment is uncertain, evidence is missing, or a rule requires human review.                       |

Each finding includes its file and line. Percentages are Jev's estimates of
exploitability; expand a finding in the Markdown report to inspect its recorded
decision. See an [example report](docs/examples/category-report.md).

## How decisions are made

Jev answers fixed questions about whether an attacker can exploit the code in each
finding. Rules in this package turn those answers into a verdict. Dismissing a
real vulnerability would hide it from the main review list, so dismissal requires:

- An estimated chance of exploitation below the threshold for the finding's
  severity. High-severity findings have a stricter threshold.
- Answers that support a specific reason for dismissal.
- Readable evidence at every requested source location, without shortening it to
  fit the request budget.
- No flag from Jev that the code contains text trying to influence the assessment.

Jev can misread a protection or miss a misleading comment. Relevant code may also
sit outside the supplied excerpts. The [questions and decision rules](docs/questions.md)
document how these answers are used.

The export uses `fallow-security-verdicts/v1` and keeps Fallow's finding IDs.
`fallow security survivors` validates the exported verdicts.

## What goes to Jev

An assessment sends Fallow's finding metadata and numbered code excerpts to Jev.
The excerpts include the flagged operation and checks Fallow found in related
files. The evidence collector refuses paths
outside the project root, including paths reached through symlinks.

Local state in `.fallow-verdict/` contains finding evidence and raw answers.
Evidence can include literals from your code, so keep this directory out of Git.
The configured API key is read from the environment and is never written to config
or state. There is no telemetry.

For untrusted repositories, pass a JSON config with `--config`; JavaScript and
TypeScript config files execute code locally. See [privacy](docs/privacy.md) for
what is sent and stored, and check Jev's terms before sending proprietary code.

## Costs and repeat runs

To limit the estimated spend and duration of a run:

```bash
npx fallow-verdict run --max-cost-usd 0.10 --max-duration 60
```

The cost limit includes requests already in progress. Actual charges can differ
from estimates, including when a request finishes after a timeout. Use the
provider's limits for a hard billing cap.

Run the command again to continue unfinished work. Completed assessments are
reused while the evidence and questions match and the requested model and endpoint
remain unchanged. Pin a model version in the [configuration](docs/configuration.md)
when comparing runs; fresh calls can still give different answers.

Changing decision thresholds reuses stored answers without another Jev call.
`report` and `eval` recheck the collected evidence before applying the policy.
Changes outside those excerpts may require `--rejudge` and a larger
`packet.radius`. Findings that Fallow no longer reports become `resolved`.

## Commands

| Command  | What it does                                                      | Can call Jev? |
| -------- | ----------------------------------------------------------------- | ------------- |
| `init`   | Create a config file and add the state directory to `.gitignore`. | No            |
| `scan`   | Find security candidates with Fallow and save the scan.           | No            |
| `judge`  | Assess pending candidates and reuse current answers.              | Yes           |
| `report` | Write reports from saved results and validate the verdict export. | No            |
| `run`    | Run the scan and assessment, then write reports.                  | Yes           |
| `status` | Show saved results.                                               | No            |
| `eval`   | Compare saved results with labels supplied through `--labels`.    | No            |

Use `report --format json` for a JSON report. Run `npx fallow-verdict --help`
for all options, including `--changed-since` to scan changes since a Git reference.

| Exit code | Meaning                                                                  |
| --------- | ------------------------------------------------------------------------ |
| `0`       | The command completed without a failing verdict.                         |
| `1`       | Results meet `--fail-on`, or evaluation found a dismissed vulnerability. |
| `2`       | Invalid input, an execution failure, or incomplete assessments.          |
| `130`     | The command was interrupted.                                             |

By default, `run` and `report` exit with `1` on likely vulnerabilities.
Set `--fail-on needs-human-review` to also fail when review is needed.
Incomplete reports exit with `2`, even with `--fail-on off`. The `scan` and
`status` commands do not fail because of findings. See the [CI guide](docs/ci.md).

## What has been tested

Live Jev runs have covered public Fallow fixtures and OWASP NodeGoat. In the
[initial evaluation](docs/validation.md), safe fixed-origin fetches and same-origin
redirects still required human review.

The default question profile is `generic`. The experimental `category` profile
adds questions for SSRF and open redirects. The
[question-profile comparison](docs/evaluation-v2.md) records where it dismissed
safe examples and where it still required review.

A vulnerability Fallow misses never reaches Jev. These runs also do not establish
accuracy on production projects. Use the [evaluation guide](docs/evaluation.md)
to measure which safe findings are dismissed and which vulnerabilities remain
visible in your own labeled examples.

## Further reading

- [Configuration](docs/configuration.md): model settings and decision thresholds.
- [Responsibilities](docs/responsibilities.md): what belongs in Fallow and in this package.
- [Architecture](docs/architecture.md): evidence collection and stored records.
- [Roadmap](docs/roadmap.md): planned work and release requirements.

## License

[MIT](LICENSE)
