# Release process

1. Run the full offline verification commands from `.github/workflows/verify.yml`.
2. Regenerate `pnpm-lock.yaml` with Corepack when Node dependencies change.
3. Run `uv lock` inside each Python package when its dependencies change.
4. Update `CHANGELOG.md` and package versions together.
5. Publish only packages whose tests and documentation describe their current behavior.

No release should include runtime artifacts, credentials, generated images, models, provider transcripts, or local state.
