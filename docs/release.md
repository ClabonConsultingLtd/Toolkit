# Release process

1. Run the full offline verification commands from `.github/workflows/verify.yml`.
2. Regenerate `pnpm-lock.yaml` with Corepack when Node dependencies change.
3. Run `uv lock` inside each Python package when its dependencies change.
4. Update `CHANGELOG.md` and package versions together.
5. Tag the release (`git tag vX.Y.Z && git push origin vX.Y.Z`). Toolkit's packages version in lockstep, so one tag covers the whole repo — this is the reference a consuming repo pins to with `packages/toolkit-sync` (`node cli.mjs pin <package> vX.Y.Z`; see that package's README).
6. Publish only packages whose tests and documentation describe their current behavior.

No release should include runtime artifacts, credentials, generated images, models, provider transcripts, or local state.

## Consuming-repo version tracking

A repo that vendors a Toolkit package (e.g. `agent-workflow`) as a directory
copy should track the release it copied from with `packages/toolkit-sync`
rather than an untracked, undated copy-paste. See
`packages/toolkit-sync/README.md` for the pin/check/sync contract.
