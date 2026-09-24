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
  "count": 3,
  "cron": "*/30 8-19 * * *",
  "timezone": "UTC"
}
```

Discover repository/base/model normally. The helper stores policy under
`.toolkit/orchestration/.intake/policy.json`, separate from batch reports.
It refuses a limit below current active work; let that work finish before lowering
N. Choose `cron` and `timezone` with the user; these fields default to every 30
minutes from 08:00 through 19:30 UTC when omitted. Reconfiguring without them
preserves the saved cadence. Every worker reservation/resume uses a shared lock
and enforces this policy,
including existing manually selected batches. Pausing intake stops new admission,
not already authorized implementation or the shared execution limit.

Ensure exactly one Paseo schedule named `ticket-intake:<owner/repo>`; list existing
schedules before creating to recover interrupted configuration. Use the saved
`cron` and `timezone`, stable checkout cwd, local isolation, `codex/gpt-6-sol`
with medium reasoning, and `full-access` (`danger-full-access`) permissions.
Pass `--provider codex/gpt-6-sol --thinking medium --mode full-access` to
`paseo schedule create` so the effort is explicit. Inspect the new schedule to
confirm its model and thinking option. Keep a recovered schedule's settings unless
the user explicitly requests a change. Register its ID with `intake ... schedule`
(request `{"scheduleId":"..."}`). The second run in an hour can reconcile workers
and PRs or retry an empty evaluation. Admission still uses a UTC hour key and
never refills an hour after a nonempty batch. Do not change an existing
schedule's cadence implicitly.

Its prompt must include the absolute paths to this skill, this reference, the
intake helper and checkout, and instruct the run to:

1. Read saved policy and fetch the current Paseo schedule by saved ID. Compare
   its paused state, cron, and timezone with the policy and report any difference,
   missing schedule, or ID/name mismatch. A paused schedule with a false
   `policy.paused` value is still paused; never resume it merely because policy
   says enabled. If the two pause states disagree, stop before `tick` and ask the
   user which state to keep; do not infer consent to resume from a routine run.
   If policy is paused and the schedule is running, pause the schedule and report
   the drift. Resolve a missing or mismatched schedule before new admission;
   preserve explicit user pauses. Do not claim the controller is enabled without
   checking both states, including after a zero-selection run. Then read all
   existing batches. Reconcile worker/PR progress using
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
   and blockers. Say whether this was a new admission, an empty evaluation,
   a capacity wait, a replay, or a reconciliation-only run; report the actual
   Paseo schedule state and next run from that schedule.

Keep an already enabled intake schedule running when capacity is full, no eligible
issues exist, or one batch finishes: a later run may admit more. Pause it on
explicit user request or systemic errors preventing safe reconciliation, recording
the reason.
Do not pause it just because an individual ticket requires human input.

## Helper commands

`node <skill>/scripts/intake.mjs COMMAND CHECKOUT [request.json|-]`

- `configure`: required repository, baseBranch, codexModel, count; optional cron
  and timezone. Persist the chosen cadence across later configurations.
- `status`: read-only policy, including schedule ID and last hourly result.
- `schedule`: persist scheduleId; rejects replacement by a different schedule.
- `tick`: current models array and optional excludeTickets; admits at most once
  per UTC hour. A zero-admission result may be evaluated again in that hour after
  capacity or readiness changes. A nonempty batch is replayed on later ticks.
  An overlapping tick is rejected by the shared lock. If a crash occurs after
  batch creation, the next tick recovers that batch rather than creating more.
  The tick's `status` distinguishes `admitted`, `recovered`, `replayed`, `empty`,
  `capacity-full`, and `paused`; `capacity` is the current shared limit snapshot,
  and `skipped` explains excluded candidates or a capacity wait.
- `pause` / `resume`: toggle admission. Also pause/resume the saved Paseo schedule
  using its tools. Do not automatically bypass a user's paused policy.

Every response includes `activeHelper` with the running package version, source
path, and SHA-256 of the GitHub identity helper. `status.lastTick.helper` records
the helper used for the most recent admission. Compare these when a scheduled run
appears to use stale code; the global skill symlink and schedule must resolve to
the intended tagged Toolkit checkout. See the package README for update steps.

Each hourly admission creates a bounded batch; the recurring controller creates
additional batches on later hours. Example with N=3: 9am admits three. At 10am,
if two are still implementing/reviewing and one awaits merge, admit at most one.
If all three await merge, admit up to three. The same hour is never refilled a
second time, even if a slot becomes free later during that run. A 9am evaluation
with no admissions may retry at 9:30 if the schedule runs twice per hour.

Update the schedule prompt with these instructions, not merely "select next N".
Do not configure a live intake schedule when the user only asks to install or
update this capability; activation requires their repository and numerical N.
