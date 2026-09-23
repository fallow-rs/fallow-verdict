# Release workflows

- Keep building and testing in jobs with read-only permissions.
- The staging job downloads the tested artifact. It must not check out code, install project dependencies, or run package scripts.
- Keep actions and publishing tools pinned. Only the staging job needs `id-token: write`.
- Keep `release.yml` and the `release` environment names aligned with npm's stage-only trusted publisher.
- Never add direct npm publication or a long-lived npm token as a staging fallback.
- Releases start from `main` by manual dispatch. Create the signed tag only after public artifact verification.
- Preserve dry-run behavior: build and verify without contacting npm staging.
- Check workflow changes with actionlint, zizmor, and the release tests. Use the hosted dry run before calling a release-flow change verified.
