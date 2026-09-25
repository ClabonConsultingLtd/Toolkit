---
name: toolkit-upgrade
description: Upgrade a Toolkit package vendored with toolkit-sync to a new release tag, on a branch, through a reviewed pull request.
---

# Toolkit upgrade

Upgrade one vendored Toolkit package to a release tag. Stop and ask the user whenever a step fails or needs a destructive choice.

1. Fetch and branch from the consumer repo's up-to-date default branch: `git fetch origin && git switch -c toolkit/<package>-<tag> origin/<default>`. Never commit on the default branch.
2. Locate the CLI: `cli.mjs` from a Toolkit checkout (`packages/toolkit-sync/src/cli.mjs`) or the consumer's vendored `toolkit-sync` copy. Run commands from the repo root that holds `toolkit-pins.json`; `node <cli> --help` lists options.
3. Pin: `node <cli> pin <package> <tag>`. Add `--dest <dir>` if the pin has no recorded `dest` and the package is not vendored at `<package>/`.
4. Check: `node <cli> check`. `upstream-change` and `missing-local` need no action. For `local-edit` or `modified`, show the user how each file differs from the tag's version (`git show <tag>:packages/<package>/<path>` in a Toolkit checkout) before any `--force`. Prefer upstreaming a local patch to Toolkit over keeping it only in the vendored copy.
5. Sync: `node <cli> sync <package>`. Use `--force` only after the user has reviewed the listed files and agreed to overwrite them.
6. Verify: run the vendored package's tests, if vendored, and the consumer's relevant checks.
7. Refresh installed copies that point at the old version: copied or symlinked skills (for example `.claude/skills/*`, `${CODEX_HOME:-$HOME/.codex}/skills/*`) and any helper paths in schedules or prompts.
8. Run any post-sync step the package README names, for example `agent-workflow` intake `sync-config` when the consumer tracks `toolkit-intake.json`.
9. Commit `toolkit-pins.json` and the synced files, push, and open a PR listing the tag, the local edits found, and the checks run.
10. Wait for CI to pass. Ask the user to confirm the merge unless they already authorised merging.
