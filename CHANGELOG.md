# Changelog

## 0.4.4 - 2026-09-24

- #59: Document shared context policy for Claude and Codex

- #56: Enforce intake required checks before controller merges

- #53: Add Codex fallback for Claude-limited ticket workers

- #50: Allow scheduled Codex orchestrator to merge reviewed PRs

- #48: feat: support tracked per-repository intake settings

## 0.3.7 - 2026-09-24

- #46: Harden ticket intake catalog, ordering, and lease cleanup

- #42: fix: skip parent specs during ticket selection

- #41: Configure Git identity before release rebase

- #39: Retry empty ticket intake ticks safely and report schedule drift

- #36: Fix intake PR identity verification and expose helper source

- #33: fix: reconcile interrupted orchestration workers

- #31: fix: use full access for controller schedules

- #27: Fix intake exclusion for generic PR references

- #25: Handle malformed intake dependency metadata per ticket

- #21: Feed back generic hook/skill improvements from a consumer project

- #18: Add eligible ticket selection and capacity-limited hourly intake

- Initial standalone packages for Claude context optimisation, bounded agent workflow, image generation, and image-to-3D conversion.
- Add `toolkit-sync`, a dependency-free script consuming repos use to pin a Toolkit release, detect local drift from that pin, and re-sync vendored package files from it (`packages/toolkit-sync`). Each vendorable package now declares its vendorable surface in a `toolkit-manifest.json`. Releases are tagged going forward (see `docs/release.md`); pin to a tag with `node packages/toolkit-sync/src/cli.mjs pin <package> <tag>`.
- Add `AGENTS.md` and `docs/agents/` (issue tracker, triage labels, domain docs) documenting how agent skills should use this repo's GitHub-issue tracker and package-scoped domain docs.
- Add `codex/skills/triage-tickets` to `agent-workflow`: a Codex+Paseo skill that sweeps unlabeled, `needs-triage`, and stale-`needs-info` issues into `ready-for-agent`, independent of and lighter than `orchestrate-tickets`.
- Add `codex/skills/report-tickets` to `agent-workflow`: a read-only reporting digest that summarizes `orchestrate-tickets` batch state and Paseo agent activity into `digest.json`/`digest.md` on its own schedule.
