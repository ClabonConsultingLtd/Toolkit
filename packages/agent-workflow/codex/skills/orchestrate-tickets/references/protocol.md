# Helper protocol

Node 24+, authenticated `gh`, a persistent Toolkit checkout, and Paseo MCP are required.

`node <skill>/scripts/orchestrate.mjs COMMAND /absolute/state.json [request.json|-]`

Input is JSON from a file, or stdin with `-`; output is JSON. Pass arguments as separate shell arguments, never interpolate ticket text into commands. Every mutation except init/init-next/acquire requires the acquired `token`. `status` is read-only. Nonzero exit means no new action is authorized; external GitHub operations may have partially succeeded, so reconcile before retrying.

| Command | Request fields beyond token | Result / purpose |
| --- | --- | --- |
| select-next | repository, batchId, cwd, baseBranch, codexModel, count, models; optional concurrency, excludeTickets | Read-only next-N eligibility preview; no token required. |
| init-next | Same as select-next | Select under directory lock and initialize one fixed batch; initialized:false if none eligible. |
| init | repository, batchId, cwd, baseBranch, codexModel, tickets; optional concurrency (1–3) | Create state; refuses overwrite and tickets claimed by another batch in the state directory. tickets are issue numbers or strings. |
| status | none | Full durable state. |
| acquire | none | acquired:false if busy; otherwise token and expiresAt. |
| renew / release | none | Extend ten-minute lease / release. Release accepts the saved owner's matching token even after expiry, but cannot clear a successor's lease. |
| sync | none | Reconcile GitHub and return issues, launchable IDs, slots, pauseSchedule. |
| reserve | number, models (raw Paseo Claude models array with `thinkingOptions`) | Recheck readiness/dependencies, resolve model/effort, persist branch/launchKey and reserve slot. |
| attach | number, workspaceId and/or agentId; workerActive:true for a confirmed externally restarted saved agent | Persist identifiers immediately after each Paseo creation, or restore capacity accounting without leaving blocked. Existing different IDs are rejected. |
| link-pr | number, pr | Fetch and verify same-repository branch/base before attaching PR. |
| review | number, evidence | Record completed worker output; begin Codex review. |
| fix | number, reason | Increment fix count and reserve worker; third request blocks without launching. |
| ready | number, evidence, reviewedHead | Verify open PR and check results; record awaiting_merge. |
| block | number, reason; workerStopped:true only with evidence of stop | Human blocker; uncertain/running workers still consume a slot. |
| resume | number, evidence; resetFixCycles:true if explicitly authorized | Recover human blocker; cannot bypass an uncertain launch. |
| schedule | scheduleId | Persist scheduler identity; refuses replacement. |

Example initialization manifest:

```json
{
  "repository": "example/project",
  "batchId": "exports",
  "cwd": "/persistent/project",
  "baseBranch": "main",
  "codexModel": "<model from initiating Paseo session>",
  "tickets": [7, 8, 9],
  "concurrency": 3
}
```

Use the same shape whether the user supplies a manifest or explicit issue numbers. Do not store tokens in issue comments or tracked files. State and temporary request files belong under the ignored .toolkit directory. Add that ignore entry in a consuming repo if absent.

## Recovery

A lease timeout permits another orchestrator to reconcile, not to repeat an uncertain external creation. Reservations and stable branch/launchKey values are the recovery evidence. A reservation with an existing agent can be attached, then explicitly resumed. Restart blocked workers through `resume`; if a saved agent is already running because it was restarted externally, reconcile it first with `attach` and `workerActive: true`. If no agent was ever created, an operator must prove the old orchestrator has stopped before repairing its reservation; do not automatically clear launchUncertain.

The short-lived `<state>.mutex` directory serializes file transactions. If a process is killed while holding it, no automatic stealing occurs: stop the schedule, establish that no helper writer is alive, remove only that mutex directory, and resume. Atomic rename ensures the state file remains complete. A leftover `*.tmp` file is not the source of truth.

Partial completion writes are retry-safe: sync verifies PR merge and current labels/state on every attempt. A previously closed issue that still has ready-for-agent gets repaired after merge. Without a matching merged PR, it is blocked, never launched.

Automatic selection details and invocation examples: [selection.md](selection.md). All batches for a checkout must use the canonical state directory so overlap detection sees them. Initialization is serialized by `.selection.lock`; after a crash, verify no initializer is alive before removing this directory. Preview is read-only and not a reservation: `init-next` rechecks eligibility.

When an intake policy exists, reserve/resume/fix operations also enforce its repository-wide active-ticket limit under the shared selection lock. A capacity rejection is temporary: retain the queued/blocked state and wait; do not create another batch or agent to bypass it. See [intake.md](intake.md) for the recurring controller protocol.
