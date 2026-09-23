# CI

```yaml
name: security-verdicts
on: pull_request
permissions:
  contents: read
jobs:
  verdicts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx fallow-verdict run --changed-since "origin/${BASE_REF}" --max-cost-usd 1
        env:
          BASE_REF: ${{ github.base_ref }}
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: fallow-verdict
          path: .fallow-verdict/report.md
```

The base ref is passed through `env`, not interpolated into the command. Pin third-party actions
to a commit SHA in your own workflow.

Persist `.fallow-verdict/findings/` between runs (a cache keyed on the branch works) so unchanged
candidates are not judged again. Secrets are not available to pull requests from forks; the
`judge` step then fails with `engine_auth_failed`, exit code 2.

Incomplete judgment (including a budget stop) exits 2 even with `--fail-on off`. Exit 1 means
judgment completed and retained findings crossed the chosen threshold. `eval` also exits 2 when
labels lack current judgments. Reports and evaluation are scoped to the latest candidate set.

The repository workflow runs the built CLI against a real Fallow binary and a local HTTP engine;
no API secret is required for CI. Live model evaluation is an explicit maintainer operation with
`npm run eval:live`. Before scanning untrusted code, inspect configuration and install scripts:
JavaScript and TypeScript config files execute locally.

`npm run verify:package` installs the actual tarball in a temporary consumer project and checks
its public TypeScript imports. The installed CLI scans the development corpus and prepares a
dry run without credentials. State stays in the temporary directory. To check a public project,
use `npm run verify:package -- --project /path/to/project --scope src`; the scope must contain
at least one security candidate. CI runs this check in its Node matrix.

## Package releases

Maintainers use [the release procedure](releasing.md) for staged npm publication.
`release-validation.yml` reuses CI and checks clean installs on macOS and Windows.
`release.yml` builds one tarball, stages it through OIDC, and verifies the public download
after npm approval. The signed version tag and GitHub release come last.

To test an existing artifact, use `npm run verify:package -- --tarball /path/to/package.tgz`.
To test a registry version, use `npm run verify:package -- --published 0.1.0`.
Both checks install Fallow in the temporary consumer and send no Jev requests.
