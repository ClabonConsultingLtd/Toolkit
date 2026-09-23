# Release process

1. Run the full offline verification commands from `.github/workflows/verify.yml`.
2. Regenerate `pnpm-lock.yaml` with Corepack when Node dependencies change.
3. Run `uv lock` inside each Python package when its dependencies change.
4. Add exactly one release label to a product PR before merging it into `main`:
   `release:patch`, `release:minor`, or `release:major`. Unlabelled changes do
   not create a release candidate.
5. After the merge, GitHub Actions creates or updates one `release/next` pull
   request. It updates all distributable package versions and Python lockfiles in
   lockstep, and records the merged PR number and title in `CHANGELOG.md`. If
   several labelled PRs merge first, it keeps the greatest requested bump.
6. Review and merge that generated release PR. GitHub Actions then creates the
   immutable `vX.Y.Z` tag on its merge commit and refuses to move an existing tag.
   This repo-wide tag is the reference a consuming repo pins with
   `packages/toolkit-sync` (`node cli.mjs pin <package> vX.Y.Z`; see that
   package's README).
7. Publish only packages whose tests and documentation describe their current behavior.

If `Prepare release` fails while rebasing an existing `release/next` candidate,
review the failed run and confirm the candidate branch and pull request are still
open. After fixing the workflow, rerun the failed workflow run for the merged
labelled PR that triggered it. Review the updated candidate diff and changelog
before merging the release PR; do not hand-edit package versions to recover it.

No release should include runtime artifacts, credentials, generated images, models, provider transcripts, or local state.

## Consuming-repo version tracking

A repo that vendors a Toolkit package (e.g. `agent-workflow`) as a directory
copy should track the release it copied from with `packages/toolkit-sync`
rather than an untracked, undated copy-paste. See
`packages/toolkit-sync/README.md` for the pin/check/sync contract.
