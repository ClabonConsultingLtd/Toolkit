# Release process

1. Run the full offline verification commands from `.github/workflows/verify.yml`.
2. Regenerate `pnpm-lock.yaml` with Corepack when Node dependencies change.
3. Run `uv lock` inside each Python package when its dependencies change.
4. Add exactly one release label to a product PR before merging it into `main`:
   `release:patch`, `release:minor`, or `release:major`. Unlabelled changes do
   not create a release candidate.
5. After every merge into `main`, GitHub Actions rebuilds one `release/next`
   pull request from `main`. The candidate lists every labelled PR merged since
   the last `vX.Y.Z` tag that `CHANGELOG.md` does not already record, newest
   first, and takes the greatest requested bump. It updates all distributable
   package versions and Python lockfiles in lockstep. Because each run rebuilds
   the whole candidate, a cancelled or skipped run loses nothing: the next run
   picks the PR up, and rerunning adds no duplicate entries.
6. Review and merge that generated release PR. GitHub Actions then creates the
   immutable `vX.Y.Z` tag on its merge commit; it never moves an existing tag.
   This repo-wide tag is the reference a consuming repo pins with
   `packages/toolkit-sync` (`node cli.mjs pin <package> vX.Y.Z`; see that
   package's README). The same run builds a deterministic source archive of
   the tagged tree, a `SHA256SUMS` file, and a CycloneDX SBOM, attests build
   provenance for the archive, and publishes all three to the tag's GitHub
   Release with notes taken from the matching `CHANGELOG.md` entry. Rerunning
   this workflow for a tag that already has a Release re-uploads the same
   assets in place rather than duplicating them.
7. Publish only packages whose tests and documentation describe their current behavior.

If `Prepare release` fails, fix the cause on `main`. The next merge into `main`
rebuilds the candidate from scratch. Do not rerun the old workflow run:
GitHub reruns it with the original event's commit, ref, and workflow version.
The candidate is regenerated on every run, so edits pushed to `release/next` by
hand are discarded. Review the updated candidate diff and changelog before
merging the release PR; do not hand-edit package versions to recover it. See
GitHub's
[rerun documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

No release should include runtime artifacts, credentials, generated images, models, provider transcripts, or local state.

## Verifying a release

Download a release's archive and `SHA256SUMS`, then check the archive against
its provenance attestation and its checksum:

```sh
gh attestation verify toolkit-vX.Y.Z.tar.gz -R ClabonConsultingLtd/Toolkit
sha256sum -c SHA256SUMS
```

Both must pass before treating the archive as the tagged tree.

## Consuming-repo version tracking

A repo that vendors a Toolkit package (e.g. `agent-workflow`) as a directory
copy should track the release it copied from with `packages/toolkit-sync`
rather than an untracked, undated copy-paste. See
`packages/toolkit-sync/README.md` for the pin/check/sync contract.
