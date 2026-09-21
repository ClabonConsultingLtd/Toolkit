# Changelog

## Unreleased

- `claude-token-optimisation`: `summarize-bash.mjs` now strips a leading `cd "<path>" && ` prefix before matching its allowlist, so an allowlisted command still gets summarized when a worktree-based session prefixes it with a directory change. Fed back from a consuming repo where every allowlist miss the hook logged carried this prefix.
- `claude-token-optimisation`: add an opt-in `TOOLKIT_BASH_SUMMARY_SURVEY=on` mode to `summarize-bash.mjs` that logs `{command, at}` for commands that miss the allowlist, without running or otherwise touching them, so a project can mine its own log for candidate allowlist additions to propose upstream. Off by default.
- `claude-token-optimisation`: clarify `bulk-reader`'s guidance to explicitly mention `Grep` for cheaper lookups and to name debugging/security/architecture/changes as the judgment-heavy tasks it should hand back to the parent.
- `agent-workflow`: expand the `bounded-handoff` skill with a delegable/never-delegable checklist, a diff-review checklist, and a session handoff limit, generalized from a consuming repo's several months of using the CLI.

## 0.2.0 - 2026-09-20

- Initial standalone packages for Claude context optimisation, bounded agent workflow, image generation, and image-to-3D conversion.
- Add `toolkit-sync`, a dependency-free script consuming repos use to pin a Toolkit release, detect local drift from that pin, and re-sync vendored package files from it (`packages/toolkit-sync`). Each vendorable package now declares its vendorable surface in a `toolkit-manifest.json`. Releases are tagged going forward (see `docs/release.md`); pin to a tag with `node packages/toolkit-sync/src/cli.mjs pin <package> <tag>`.
- Add `AGENTS.md` and `docs/agents/` (issue tracker, triage labels, domain docs) documenting how agent skills should use this repo's GitHub-issue tracker and package-scoped domain docs.
- Add `codex/skills/triage-tickets` to `agent-workflow`: a Codex+Paseo skill that sweeps unlabeled, `needs-triage`, and stale-`needs-info` issues into `ready-for-agent`, independent of and lighter than `orchestrate-tickets`.
- Add `codex/skills/report-tickets` to `agent-workflow`: a read-only reporting digest that summarizes `orchestrate-tickets` batch state and Paseo agent activity into `digest.json`/`digest.md` on its own schedule.
