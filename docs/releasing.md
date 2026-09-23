# Releasing fallow-verdict

Releases follow Fallow's tag-last flow. GitHub Actions builds and tests one npm tarball,
then submits it with `npm stage publish`. A maintainer checks that staged file and approves
it with npm 2FA. The workflow checks the public download before you sign the Git tag.

## Once per repository

The npm trusted publisher for `fallow-verdict` must name:

- Repository: `fallow-rs/fallow-verdict`
- Workflow: `release.yml`
- Environment: `release`
- Permission: stage publish only

The GitHub `release` environment permits the `main` branch only. Release immutability is enabled,
so attach all evidence before publishing the GitHub release. Do not add an `NPM_TOKEN`
secret or give the trusted publisher direct publish permission. CI does not need a Jev key.

To configure npm while signed in as a package maintainer:

```sh
npm trust github fallow-verdict --repo fallow-rs/fallow-verdict \
  --file release.yml --env release --allow-stage-publish
npm trust list fallow-verdict --json
```

Use npm 11.19.0, the version pinned in the workflow. Maintainer login and 2FA belong on your
machine. If you use 1Password, read credentials with `op` into the login process; never copy
values into a command, repository file, workflow secret, or log.

## Prepare the release

Run **Release Validation** on `main` before changing versions. It runs the ordinary CI checks
and installs the package on macOS and Windows. Its weekly run also catches changes in runners
and dependencies between releases.

```sh
gh workflow run release-validation.yml --ref main
```

Wait for that run to pass. Update the version with `npm version X.Y.Z --no-git-tag-version`.
Write a dated `## X.Y.Z (YYYY-MM-DD)` section in `CHANGELOG.md`. If saved state needs a
migration, explain it in the release notes. Versions must be stable `X.Y.Z` values. Check the release metadata locally:

```sh
npm run release:check -- --tag vX.Y.Z
npm run verify
npm run verify:package
```

Commit with `git commit -S`, merge through a PR with green checks, and record the resulting
`main` commit. Leave the version tag absent. The release workflow checks the commit's GitHub
signature verification and requires the manifest, lockfile, and changelog to agree.

## Build and stage

The workflow defaults to a dry run. It runs validation and creates the tested artifact without
calling npm staging. A dry run may use an already released version to exercise the pipeline.

```sh
gh workflow run release.yml --ref main -f tag=vX.Y.Z -F dry_run=true
```

For the release itself, dispatch explicitly with staging enabled:

```sh
gh workflow run release.yml --ref main -f tag=vX.Y.Z -F dry_run=false
```

Record the run ID and its commit from Actions. Download its `npm-release` artifact into an
empty directory; it contains the tarball, `release.json`, and `SHA256SUMS`.

```sh
gh run download RUN_ID --name npm-release --dir /tmp/verdict-release
```

The preparation job runs without publishing permissions. The staging job has no repository
checkout and runs no package lifecycle scripts. It checks the downloaded tarball's digest
against the preparation job before staging it with provenance.

## Check and approve the staged package

Find the stage for this version and inspect its details. Download it into a separate directory:

```sh
npm stage list fallow-verdict@X.Y.Z --json
npm stage view STAGE_ID --json
mkdir -p /tmp/verdict-stage
(cd /tmp/verdict-stage && npm stage download STAGE_ID)
```

Confirm the name and version match the intended release. Compare the staged file with the
artifact from the recorded run; `cmp` must exit successfully:

```sh
cmp /tmp/verdict-release/fallow-verdict-X.Y.Z.tgz \
  /tmp/verdict-stage/fallow-verdict-X.Y.Z-STAGE_ID.tgz
npm stage approve STAGE_ID
```

Approval requires npm 2FA and makes that version public with the `latest` tag. A mismatch must
stop approval. CI cannot approve on your behalf because its trusted publisher is stage-only.
See [npm's staged publishing documentation](https://docs.npmjs.com/staged-publishing/).

## Verify, then tag

The running workflow waits for approval, compares the public tarball with its original digest,
and installs the exact version from npm in a clean project. It checks the CLI and public imports,
then scans the evaluation corpus and runs a dry assessment without contacting Jev.

After the entire run passes, confirm its commit and create the signed tag at that exact commit.
Use the artifact downloaded from the same run, without rebuilding it. Write release notes that
explain what changed and any compatibility limits.

```sh
gh run view RUN_ID --json headSha,conclusion

git tag -s vX.Y.Z RELEASE_COMMIT -m 'vX.Y.Z'
git push origin refs/tags/vX.Y.Z

gh release create vX.Y.Z --verify-tag --draft --title 'vX.Y.Z' \
  --notes-file /tmp/release-notes.md \
  /tmp/verdict-release/fallow-verdict-X.Y.Z.tgz \
  /tmp/verdict-release/release.json /tmp/verdict-release/SHA256SUMS

gh release view vX.Y.Z --json name,body,assets,isDraft
# Check the notes and attachments before publishing.
gh release edit vX.Y.Z --draft=false
```

Use `--prerelease` for a development preview. The **Release Published** workflow checks the
signed tag and attached evidence against the public package. Keep the GitHub release unpublished
until the npm verification passes, especially when repository release immutability is enabled.

## Recover an interrupted release

If the approval wait times out, approve the matching stage and rerun failed jobs of the original
run. This preserves the original artifact and commit. Do not start by rebuilding or moving tags.

If staging reports `E409`, a stage already exists. The workflow still waits for a public package;
that response does not prove the existing stage has the expected bytes. Download and compare it
before approving. A public version is accepted on retry only when its integrity and bytes match.

If a check fails after approval, the npm version is already public. Repair the check if it is
wrong, or prepare a new version if the package is wrong. Never overwrite a release tag or assume
that deleting a GitHub release reverses an npm publication.

The existing `0.1.0` release predates this workflow and its evidence attachments. Do not rerun
new release checks against it by recreating its tag or GitHub release.
