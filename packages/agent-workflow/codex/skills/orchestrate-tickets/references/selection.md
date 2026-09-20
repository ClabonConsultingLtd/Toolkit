# Automatically select the next N tickets

Use this mode only when the user requests a bounded number of eligible tickets,
for example: `Use $orchestrate-tickets to schedule the next 5 eligible tickets`.
A one-off request authorizes this fixed batch. For recurring hourly selection, use [intake.md](intake.md), which reuses this selector with a shared capacity limit.
Resolve the repository from the current project, and ask for N only if absent.
Generate a unique lowercase batch ID such as `next-5-20260920-120000` unless the
user names one. A reference to an existing batch means resume, not reselection.

Read repository guidance and discover Claude models as usual. Inspect current
Paseo agents/workspaces for this repository; place issue numbers already being
worked on outside known batch state in `excludeTickets`. If discovery is
unavailable or truncated such that ownership cannot be determined, resolve it
before initializing. All batch state belongs under the stable checkout's
`.toolkit/orchestration/` directory, including manually selected batches.

Pass an initialization request with `count: N` instead of `tickets`, plus `models`
(the current Paseo Claude model catalog array), repository, batchId, cwd,
baseBranch and initiating codexModel. Optional `excludeTickets` accepts issue
numbers; concurrency remains 1–3 and is independent of batch size.

`select-next` is a read-only preview. `init-next` repeats discovery under a shared
selection lock, persists the resulting ticket list, and returns `initialized`,
`tickets`, `shortfall`, and `skipped` entries with reasons. No GitHub mutations,
agent launches or schedule creation happen inside either helper command.

Eligibility and order:

- Paginate open `ready-for-agent` issues, oldest creation date first, then issue
  number. Re-read each issue before selecting. Pull requests are never tickets.
- Skip assigned issues, conflicting triage/done labels, and tickets in another
  local batch or the supplied active-work exclusion list.
- Require all native/fallback blockers closed, and no unfinished local batch
  owning a blocker. An open blocker is never included speculatively in the batch.
- Skip issues referenced by an open or merged PR. GitHub timeline cross-references
  are used conservatively; even a related PR can cause a skip. An unlinked PR
  cannot be inferred reliably, so retain explicit issue references in worker PRs.
- Require a Claude recommendation supported by the discovered model catalog.
  Missing or unsupported recommendations are reported and skipped.
- GitHub/authentication errors and unreadable batch state abort selection rather
  than treating unknown work as eligible. Review skipped reasons in the summary.

After `init-next`, report the selected issues and any shortfall; don't ask for a
second confirmation of work the user just requested. If none qualify, create no
schedule and explain why. If fewer than N qualify, run that smaller fixed batch;
do not wait for future issues to fill the original count.

For a nonempty batch, continue the normal acquire/sync/dispatch/review workflow,
and automatically ensure its hourly Paseo schedule as described in SKILL.md.
Its prompt must reference the saved state and resume it, not repeat `init-next`
or discover replacements. No replenishment after merges, failures or blockers.
A later explicit next-N request creates a separate batch and excludes tickets
already owned by existing batches. Readiness and dependencies are rechecked at
launch, so a ticket can become blocked after selection without being replaced.

Locks cover batches in the same canonical checkout directory. They are not a
distributed lock across machines or independent clones. Use one orchestration
checkout per repository; human assignees and linked PRs remain additional signals.
