# Changelog

## 0.11.0 - 2026-09-27

- #118: feat(agent-workflow): add Claude entrypoints for ticket orchestration skills

## 0.10.2 - 2026-09-27

- #114: fix(agent-workflow): stop ready from requiring checks that only run once a PR leaves draft

## 0.10.1 - 2026-09-27

- #113: Get pnpm lint and typecheck passing on main, run them in CI, split the changelog

## 0.10.0 - 2026-09-27

- #110: Fix run-as-script check, allowedHours arrays, and handoff --env-file

## 0.9.1 - 2026-09-27

- #107: fix(release): rebuild the release candidate from every labelled PR

## 0.9.0 - 2026-09-27

- #103: feat(toolkit-sync): add its own toolkit-manifest.json

- #102: feat(image-to-3d): document TRELLIS traps, close two CLI gaps

- #101: feat(agent-workflow): overlay convention and handoff CLI parity

- #97: fix(agent-workflow): warn scheduled controllers off loop-only wakeup tools

## 0.8.0 - 2026-09-26

- #95: feat(agent-workflow): opt-in comment review for self-authored controller merges

## 0.7.1 - 2026-09-26

- #92: fix(agent-workflow): report plan-gated branch protection clearly

## 0.7.0 - 2026-09-26

- #86: docs(agent-workflow): guidance for running handoff on a small local model

## 0.6.0 - 2026-09-25

- #78: orchestrate-tickets: worker prompt, spec selection and reporting refinements

- #81: intake: canonical schedule prompt, drift check, and Codex sandbox preflight

- #79: claude-token-optimisation: portable hook commands, wrapped command summaries, context policy

- #76: Gate orchestration on PR merge state and route base updates to workers

- #77: toolkit-sync: record dest and sync baseline; add toolkit-upgrade skill

- #75: Parse Claude weekly limits and auto-resume provider-limit blocks after reset

## 0.5.2 - 2026-09-25

- #66: Gate ticket merges on repository local verification
- #67: Document local verification gate and prepare patch release

## 0.5.1 - 2026-09-25

- #64: fix: make Paseo schedule authoritative for intake pause

## 0.5.0 - 2026-09-25

- #61: Add Codex handoff and context skills with configurable model endpoints

## 0.4.4 - 2026-09-24

- #59: Document shared context policy for Claude and Codex

## 0.4.3 - 2026-09-24

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
