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
