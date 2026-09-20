# Hourly intake with a shared execution limit

Use when the user asks to select more eligible work every hour. Ask for N if not
specified. N is both the maximum new selections per hourly tick and the maximum
managed tickets in active implementation/review across this repository's batches.
Awaiting-merge PRs do not consume active slots. Uncertain launches and workers
waiting for permission do. Queued tickets reserve admission capacity so a delayed
batch does not cause a growing implementation queue.

Use one stable orchestration checkout per repository. All existing batch runners
must use this installed helper version; older copies do not enforce the shared
limit. Discover existing Paseo agents and schedules before configuring intake;
unknown/untracked work must be reconciled or explicitly excluded, not duplicated.
This is a local shared limit for managed tickets, not a distributed worker quota.

## Configure once

Run `node <skill>/scripts/intake.mjs configure CHECKOUT request.json` with:

```json
{
  "repository": "owner/repo",
  "baseBranch": "main",
  "codexModel": "<initiating Paseo model>",
  "count": 3
}
```

Discover repository/base/model normally. The helper stores policy under
`.toolkit/orchestration/.intake/policy.json`, separate from batch reports.
It refuses a limit below current active work; let that work finish before lowering
N. Every worker reservation/resume uses a shared lock and enforces this policy,
including existing manually selected batches. Pausing intake stops new admission,
not already authorized implementation or the shared execution limit.

Ensure exactly one Paseo schedule named `ticket-intake:<owner/repo>`; list existing
schedules before creating to recover interrupted configuration. Set hourly cron
`0 * * * *`, UTC, stable checkout cwd, local isolation, and the initiating Codex
model; use Auto-review permissions. Register its ID with `intake ... schedule`
(request `{"scheduleId":"..."}`). Preserve explicit user cadence/timezone if
provided; the hourly tick deduplication key itself uses UTC.

Its prompt must include the absolute paths to this skill, this reference, the
intake helper and checkout, and instruct the run to:

1. Read saved policy and all existing batches. Reconcile worker/PR progress using
   normal orchestration leases; skip a batch owned by another run. Resume queued
   work in older batches first. Stop launching if the shared cap rejects a
   reservation. Never mark a capacity wait as a human blocker.
2. Discover current Claude models and active work. Run `intake ... tick` with
   `models` and optional `excludeTickets` for work outside saved batches. This
   atomically admits up to `min(N, available capacity)` eligible tickets using the
   same readiness/dependency/model/PR exclusions as [selection.md](selection.md).
3. If initialized, process the returned batch using the normal orchestration
   workflow. Its `managedByIntake: true` flag means **do not create a per-batch
   schedule** and **do not pause the shared intake schedule when it completes**.
   Per-batch execution concurrency stays at most three; the shared N cap applies
   across them all. Existing independent batch schedules can coexist because the
   shared reservation limit and per-batch leases prevent over-dispatch/duplicate
   review, provided they use this helper version.
4. Review completed work, request up to two fixes, and ready qualifying PRs. The
   user alone merges. Close/relabel issues only after verifying PR merge. Release
   any held batch leases on exit. Report new selections, active count, PR links
   and blockers.

Keep the intake schedule enabled when capacity is full, no eligible issues exist,
or one batch finishes: the next hour may admit more. Pause it on explicit user
request or systemic errors preventing safe reconciliation, recording the reason.
Do not pause it just because an individual ticket requires human input.

## Helper commands

`node <skill>/scripts/intake.mjs COMMAND CHECKOUT [request.json|-]`

- `configure`: required repository, baseBranch, codexModel, count; persist policy.
- `status`: read-only policy, including schedule ID and last hourly result.
- `schedule`: persist scheduleId; rejects replacement by a different schedule.
- `tick`: current models array and optional excludeTickets; admits at most once
  per UTC hour. Repeated/overlapping ticks return the prior result. If a crash
  occurs after batch creation, it recovers that batch rather than creating more.
- `pause` / `resume`: toggle admission. Also pause/resume the saved Paseo schedule
  using its tools. Do not automatically bypass a user's paused policy.

Each hourly admission creates a bounded batch; the recurring controller creates
additional batches on later hours. Example with N=3: 9am admits three. At 10am,
if two are still implementing/reviewing and one awaits merge, admit at most one.
If all three await merge, admit up to three. The same hour is never refilled a
second time, even if a slot becomes free later during that run.

Update the schedule prompt with these instructions, not merely "select next N".
Do not configure a live intake schedule when the user only asks to install or
update this capability; activation requires their repository and numerical N.
