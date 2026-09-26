# Hourly intake with a shared execution limit

Use when the user asks to select more eligible work every hour. Read N from the
repository's tracked `toolkit-intake.json` when present; otherwise ask for N if
not specified. N is both the maximum new selections per hourly tick and the maximum
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

For a tracked, reviewable repository configuration, commit `toolkit-intake.json`
at the checkout root (see `examples/toolkit-intake.json`). It supports `version: 1`,
`repository`, `baseBranch`, `codexModel`, `count`, and optional `cron`, `timezone`,
`excludeTickets` issue numbers, `requiredChecks` check-run names or status
contexts, `localVerificationCommand`, a relative `.mjs` path,
`codexWorkerFullAccess` (see [Codex sandbox preflight](#codex-sandbox-preflight)),
and `schedulePromptAppend`, a string or array of lines appended to the generated
schedule prompt. Set `count`
to the desired shared cap. List every check that must run before a controller
merge; a missing, skipped, or neutral required check blocks it. `merge-ready`
verifies the list against the PR's `statusCheckRollup` (as `gh pr checks` shows),
so treat `requiredChecks` as required for any repository where the controller
merges. Without it, `merge-ready` reads branch protection's required status checks
instead. GitHub denies that API with HTTP 403 for private repositories on plans
without protected branches; `merge-ready` then reports that retrying will not help
and every controller merge stays blocked until the list is set. `status` and
`configure` return a `warnings` entry while it is missing. The local
verification command receives the PR number and current head SHA and must exit
zero only for a complete trusted pass. It runs at `ready` and `merge-ready`, so
a stale result blocks both. Failure or timeout blocks the controller. An empty list explicitly
requires none, while every reported pending or failing check still blocks it. Do not
put pause state, schedule IDs, paths, or tick history in this file. Run
`node <skill>/scripts/intake.mjs configure CHECKOUT` to initialize the local
runtime policy from it. Existing repositories without the tracked file can keep
using `node <skill>/scripts/intake.mjs configure CHECKOUT request.json` with:

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

Discover repository/base/model normally. The helper stores runtime policy under
`.toolkit/orchestration/.intake/policy.json`, separate from batch reports.
When a tracked config exists, it is authoritative over those stable policy
fields. `sync-config` applies edits under the shared lock, preserving the schedule
ID, last tick, and cached pause state; `tick` also syncs it before admission. Invalid config
or a reduction below active work stops the tick without overwriting the policy.
The saved `excludeTickets` are always passed to selection, alongside any dynamic
exclusions in the tick request. A hard-coded N in a schedule prompt can become
stale; instruct the controller to read the saved policy instead.
It refuses a limit below current active work; let that work finish before lowering
N. Choose `cron` and `timezone` with the user; these fields default to every 30
minutes from 08:00 through 19:30 UTC when omitted. Reconfiguring without them
preserves the saved cadence. Every worker reservation/resume uses a shared lock
and enforces this policy,
including existing manually selected batches. The live Paseo schedule is the pause
source of truth. Its paused state stops new admission, not already authorized
implementation or the shared execution limit.

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

Generate its prompt with `node <skill>/scripts/intake.mjs schedule-prompt CHECKOUT`
instead of writing it by hand. The output is deterministic for a checkout and
helper installation: it names the absolute paths to this skill, this reference,
both helpers, the checkout, batch state directory and intake policy, and
summarizes the steps below. It excludes N, cadence and other runtime values, so
changing them does not change the prompt. Put repository-specific authorizations,
such as scheduled approval and merging or implementation-metadata repair, in
`schedulePromptAppend` rather than editing the saved prompt. After a Toolkit
update or config change, the operator regenerates the prompt and applies it
with `update_schedule`; scheduled runs only report drift. The prompt instructs
the run to:

1. If `toolkit-intake.json` exists, run `sync-config` before reading policy;
   stop on invalid settings or a limit below active work. Then read saved policy
   and fetch the current Paseo schedule by saved ID. Read only the fields the run
   needs: id, name, status/paused, cron, timezone, provider/model, mode and
   prompt. Do not read its run history, which grows with every run. Prefer
   `paseo schedule inspect ID --json | node <skill>/scripts/intake.mjs schedule-summary CHECKOUT -`,
   which prints only those fields and `promptMatches`; otherwise extract them
   from `inspect_schedule` without echoing `runs`. Compare the live prompt with
   the generated one (`promptMatches`, or `schedule-prompt CHECKOUT --check -`)
   and report any drift with the regenerate command. Do not rewrite the prompt
   from the controller; an operator applies the regenerated prompt. Check its ID and name against
   the policy, and read its paused state explicitly. A missing schedule, ID/name
   mismatch, or unreadable state stops new admission. Compare cron, timezone, and
   model with the policy and report any difference. If the cached `policy.paused`
   differs from Paseo, report the drift; the Paseo state wins and `tick` will
   reconcile the cache. An Active schedule must not be paused because of a stale
   policy flag. For a committed cadence or model change, explicitly update the
   Paseo schedule to match the tracked config before admission; never change its
   paused state as a side effect. Resolve a missing or mismatched schedule before new admission;
   preserve explicit user pauses. Do not claim the controller is enabled without
   checking the live schedule, including after a zero-selection run. Then read all
   existing batches. Reconcile worker/PR progress using normal orchestration
   leases; skip a batch owned by another run. Review completed workers and PRs
   before new admission. Where the user has explicitly authorized scheduled Codex approval and
   merging, submit an approval review when GitHub permits it. Then run
   `orchestrate merge-ready STATE.json` with the ticket number and current lease
   token immediately before each merge. Merge only when it returns `mergeReady: true`,
   using the returned head SHA as the merge command's head match. Leave PRs awaiting
   merge when the controller cannot approve its own PR or branch protection requires
   another reviewer. Then `sync` their exact batches so
   verified merges close their issues and release dependencies. Otherwise only
   reconcile PRs already merged outside the controller. Renew each held lease at
   least every five minutes during long reviews or tests and immediately before
   external mutations. Release it in a cleanup step even after a failed review;
   report a failed release rather than claiming success. Resume queued work in
   older batches first. Stop launching if the shared cap rejects a reservation.
   Never mark a capacity wait as a human blocker.
2. Check shared `claude-cooldown`, then discover current Claude models and active work. Pass the raw `models` array
   from Paseo `list_models({provider: "claude"})`, preserving each model's
   `thinkingOptions: [{id, ...}]`. The helper also accepts a validated
   `thinkingOptionIds: ["high", ...]` array (the `paseo provider models --json`
   shape, whose `thinkingOptions` is a display string), and treats entries with
   neither field as unselectable rather than rejecting the catalog. Never
   synthesize unsupported options. During an active cooldown, also pass the raw `codexModels` array
   from Paseo `list_models({provider: "codex"})`. If a Claude worker fails with
   an explicit usage-limit error during reconciliation or creation, record that
   error with `record-claude-limit` before launching another worker. The next
   reservation will use Codex; block the failed worker with
   `blockKind: "provider-limit"` and the returned `resetAt`. Once `sync` lists it
   in `resumable`, resume it without evidence and continue the saved worker.
   If the schedule prompt authorizes implementation-metadata repair, run a
   read-only `select-next` preview with the valid catalog. For an issue skipped
   solely because its recommendation is absent, malformed or unsupported,
   re-read that issue and correct only its Implementation recommendation using
   its existing requirements and a supported model/effort. Leave issues needing
   a product decision unchanged and report them. Never edit a ticket to
   compensate for a malformed catalog. Immediately before `tick`, re-fetch the
   saved Paseo schedule by ID. Refuse admission if the fetch fails, its ID/name
   differs, or its paused state is unknown. Pass `schedule: {id, name, paused}`
   from that live result with `models` and `codexModels` during a cooldown,
   and optional `excludeTickets` for work outside saved batches. This
   atomically admits up to `min(N, available capacity)` eligible tickets using the
   same readiness/dependency/model/PR exclusions as [selection.md](selection.md).
3. If initialized, process the returned batch using the normal orchestration
   workflow. Its `managedByIntake: true` flag means **do not create a per-batch
   schedule** and **do not pause the shared intake schedule when it completes**.
   Per-batch execution concurrency stays at most three; the shared N cap applies
   across them all. Existing independent batch schedules can coexist because the
   shared reservation limit and per-batch leases prevent over-dispatch/duplicate
   review, provided they use this helper version.
4. Review any worker that finishes during this run with the same rules as step 1.
   The user alone merges unless they explicitly authorize automated merging.
   Close/relabel only the exact issue after verifying its linked PR merge. If a
   catalog validation fails, correct the input and retry in the same UTC hour;
   a nonempty admission must replay and cannot be refilled. Report new
   selections, active count, PR links and blockers. Say whether this was a new
   admission, an empty evaluation, a capacity wait, a replay, or a
   reconciliation-only run; report the actual Paseo schedule state and next run.

Keep an already enabled intake schedule running when capacity is full, no eligible
issues exist, or one batch finishes: a later run may admit more. Pause it on
explicit user request or systemic errors preventing safe reconciliation, recording
the reason.
Do not pause it just because an individual ticket requires human input.

## Codex sandbox preflight

Codex workers launch in `auto-review`, which relies on the Codex command sandbox.
On a host where it cannot start, every worker command escalates to a guardian
review. Before launching a Codex worker in `auto-review`, check once per run
that the sandbox works by running a trivial command through it, such as
`codex sandbox true`. A non-zero exit or an error such as
`bwrap: No permissions to create a new namespace` means it is unavailable.

If it is unavailable, block each Codex reservation before creating its
workspace or agent: call `block` with the sandbox error as the reason and
`workerStopped: true`, since no worker exists. Claude reservations are
unaffected. The blocked reservation keeps its slot until an operator
reconciles it, so after the first such block stop reserving further tickets
that could be routed to Codex in this run. Only when `toolkit-intake.json` sets `codexWorkerFullAccess: true`
(surfaced in the generated schedule prompt) may the controller launch that
Codex worker with `modeId: full-access` instead; record the sandbox error and
the fallback in the run report. Never change a running worker's mode.

## Helper commands

`node <skill>/scripts/intake.mjs COMMAND CHECKOUT [request.json|-]`

- `configure`: when `toolkit-intake.json` exists, use it with no request. Otherwise
  pass a request with repository, baseBranch, codexModel, count and optional cron,
  timezone, and excludeTickets. Persist the chosen cadence across later configurations.
- `sync-config`: apply the tracked file to runtime policy, retaining schedule ID,
  last tick, and cached pause state. Requires `toolkit-intake.json`. It also copies
  `requiredChecks`; removing the field removes the saved list.
- `status`: read-only policy, including schedule ID, cached pause state, and last hourly result.
- `schedule`: persist scheduleId; rejects replacement by a different schedule.
- `tick`: current models array, fresh `schedule: {id, name, paused}` from Paseo,
  and optional excludeTickets; admits at most once
  per UTC hour. A zero-admission result may be evaluated again in that hour after
  capacity or readiness changes. A nonempty batch is replayed on later ticks.
  An overlapping tick is rejected by the shared lock. If a crash occurs after
  batch creation, the next tick recovers that batch rather than creating more.
  The tick's `status` distinguishes `admitted`, `recovered`, `replayed`, `empty`,
  `capacity-full`, and `paused`; `capacity` is the current shared limit snapshot,
  and `skipped` explains excluded candidates or a capacity wait.
- `schedule-prompt`: print the canonical schedule prompt for CHECKOUT from
  `toolkit-intake.json` (or the saved policy). With `--check FILE|-`, compare a
  live prompt, given as raw text or Paseo schedule JSON, ignoring line endings
  and trailing whitespace. It exits non-zero with a short summary of missing and
  unexpected lines when they differ.
- `schedule-summary`: read Paseo schedule JSON from FILE or `-` and print only
  id, name, status, paused, cron, timezone, provider, model, thinking option,
  mode, cwd, next run and `promptMatches` (with `promptDrift` on mismatch).
- `pause` / `resume`: compatibility commands that only copy a matching live
  schedule state into policy. Pause or resume the Paseo schedule first and pass
  its fresh `schedule` object; neither command changes admission independently.

Existing policies may contain a stale `paused` value. Keep their schedule ID and
hourly history, inspect the live Paseo schedule, and pass its state to the next
`tick`; the helper rewrites the cached pause fields before deciding admission.
An Active schedule resumes admission without `intake resume`. If the saved ID is
missing, register the verified schedule with `intake schedule` before ticking.
If it points to another schedule, stop and reconcile the ID with the operator;
do not guess from a matching name or clear hourly history.

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

Use the generated schedule prompt, not merely "select next N".
Do not configure a live intake schedule when the user only asks to install or
update this capability; activation requires their repository and numerical N.
