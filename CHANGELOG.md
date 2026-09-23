# Changelog

## 0.3.5 - 2026-09-23

- #41: Configure Git identity before release rebase

- #36: Fix intake PR identity verification and expose helper source

- #33: fix: reconcile interrupted orchestration workers

- #31: fix: use full access for controller schedules

- #27: Fix intake exclusion for generic PR references

- #25: Handle malformed intake dependency metadata per ticket

- #21: Feed back generic hook/skill improvements from ProjectTriArch

- #18: Add eligible ticket selection and capacity-limited hourly intake

- Initial standalone packages for Claude context optimisation, bounded agent workflow, image generation, and image-to-3D conversion.
- Add `toolkit-sync`, a dependency-free script consuming repos use to pin a Toolkit release, detect local drift from that pin, and re-sync vendored package files from it (`packages/toolkit-sync`). Each vendorable package now declares its vendorable surface in a `toolkit-manifest.json`. Releases are tagged going forward (see `docs/release.md`); pin to a tag with `node packages/toolkit-sync/src/cli.mjs pin <package> <tag>`.
- Add `AGENTS.md` and `docs/agents/` (issue tracker, triage labels, domain docs) documenting how agent skills should use this repo's GitHub-issue tracker and package-scoped domain docs.
- Add `codex/skills/triage-tickets` to `agent-workflow`: a Codex+Paseo skill that sweeps unlabeled, `needs-triage`, and stale-`needs-info` issues into `ready-for-agent`, independent of and lighter than `orchestrate-tickets`.
- Add `codex/skills/report-tickets` to `agent-workflow`: a read-only reporting digest that summarizes `orchestrate-tickets` batch state and Paseo agent activity into `digest.json`/`digest.md` on its own schedule.
