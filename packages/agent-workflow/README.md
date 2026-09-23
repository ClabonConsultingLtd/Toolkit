# Agent workflow

Provider-aware developer automation with project-defined policy. `pnpm handoff <task-directory> --dry-run` previews a bounded handoff; set `TOOLKIT_HANDOFF_ENABLED=on` plus provider credentials to execute it. `pnpm ticket <ticket> --config ticket-config.json --dry-run` validates a ticket before launching the command declared in that configuration file.

## Ticket workflow compatibility

`ticket` and `ticket-batch` read ticket status through a pluggable provider, declared as `"provider"` in the ticket config file. A ticket reference (a manifest entry, or the argument to `pnpm ticket`) is resolved and its status compared against `readyStatus` (to launch) and `completeStatus` (to mark done). Toolkit does not bundle or invoke any ticket-authoring workflow; a project remains free to produce compatible tickets by whatever means it likes.

### `local-markdown` (default)

Built for Markdown tickets, such as those produced by Matt Pocock's `/grill-with-docs` → `/to-spec` → `/to-tickets` workflow. A ticket reference is a file path, resolved relative to the manifest (or the current directory for a bare `pnpm ticket` call). Status is read from a top-level `**Status:** <value>` declaration by default; override the pattern with `statusPattern` (a regex string with one capture group) for projects that use a different convention, e.g. `"statusPattern": "^Status:\\s*(.+)$"`.

```json
{ "provider": "local-markdown", "readyStatus": "ready", "command": "your-agent-launch-command" }
```

### `github`

GitHub issues don't carry status in the body; repos track it as a triage label (see e.g. a repo's `docs/agents/triage-labels.md`). A ticket reference is a GitHub issue number (a leading `#` is stripped). Status is read via `gh issue view --json labels,state`: it's whichever entry of the required `statusLabels` array is present on the issue (list every triage label this repo actually uses, e.g. `needs-triage`, `ready-for-agent`, `wontfix`); a closed issue takes precedence over labels and resolves to `closedStatus` (default `"closed"`, set it to match your `completeStatus` if the agent closes the issue on completion instead of relabeling it). `gh` must be authenticated and run inside a clone of the target repo.

```json
{
	"provider": "github",
	"readyStatus": "ready-for-agent",
	"command": "your-agent-launch-command",
	"statusLabels": ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix", "done"],
	"closedStatus": "done"
}
```

```bash
pnpm ticket 42 --config ticket-config.github.json --dry-run
```

A manifest for `ticket-batch` mixes providers only per-manifest (one `ticketConfig` per manifest), and lists issue numbers instead of paths:

```json
{ "ticketConfig": "ticket-config.github.json", "completeStatus": "done", "tickets": ["41", "42"] }
```

## Planned modules

- `deepseek-handoff`: submits a bounded mechanical change to an OpenAI-compatible DeepSeek endpoint, accepts only declared editable files, saves the provider response, and applies validated SEARCH/REPLACE blocks atomically.
- `implement-ticket`: validates a user-defined ticket schema and launches an isolated implementation session using project-supplied prompt and worktree policy.

## Non-negotiable boundaries

The package will require an explicit task directory, editable-file list, and opt-in provider credential. It will not assume a ticket location, documentation filenames, source control host, pull-request policy, model, pricing schedule, or repository layout.

## Configuration direction

```toml
[handoff]
enabled = false
provider = "deepseek"
model = ""

[tickets]
root = "tasks"
ready_status = "ready"
```

The final schema will be validated before any network call or worktree operation.

## Task format

```markdown
Editable:
- src/example.ts

## Instruction

Make the bounded mechanical change.
```

Provider edits are limited to declared files and must use file-qualified SEARCH/REPLACE blocks. Review every resulting diff.

## Optional worktrees

`pnpm worktree <ticket> <worktree-root> --dry-run` previews a branch and worktree name derived from the ticket filename. Omit `--dry-run` only when the calling repository deliberately wants Git state created; ticket launching itself never creates a worktree.

## Ticket batches

Use `ticket-batch` to implement an explicitly ordered queue of independent tickets. The manifest names the ticket-launch configuration, completion status, optional state location, and tickets:

```json
{
  "ticketConfig": "ticket-config.json",
  "completeStatus": "done",
  "tickets": ["tasks/01-setup.md", "tasks/02-import.md"]
}
```

Preview before launching:

```bash
pnpm ticket-batch ticket-batch.json --dry-run
```

Normal execution launches one ticket, waits for its command to exit, re-reads its status, and proceeds only when it equals `completeStatus` (default: `done`). It writes a resumable `.toolkit/ticket-batch-state.json` beside the manifest by default. The batch stops at the first launch failure or unchanged status; `--continue-on-failure` and `--max N` are explicit opt-ins.

## Codex orchestration with Paseo

The `codex/skills/orchestrate-tickets` integration coordinates an explicit batch of
GitHub issues using Claude workers and Codex review. It retains the existing
Markdown and GitHub command launchers. Prerequisites are Node 24+, authenticated
`gh`, a persistent Toolkit checkout, and Paseo MCP connected to Codex with both
Codex and Claude available.

Install the skill by symlinking it from your persistent Toolkit checkout:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s /absolute/Toolkit/packages/agent-workflow/codex/skills/orchestrate-tickets \
  "${CODEX_HOME:-$HOME/.codex}/skills/orchestrate-tickets"
```

Keep that checkout in place: the skill's helper imports the package's source.
Restart your Codex session to discover a newly installed skill, or explicitly
provide its absolute SKILL.md path to an existing session.

To update after a Toolkit release, resolve the installed skill symlink and update
the checkout it actually points into to the release tag (with a clean checkout):

```bash
node -p 'require("node:fs").realpathSync(process.argv[1])' \
  "${CODEX_HOME:-$HOME/.codex}/skills/orchestrate-tickets"
git -C /absolute/Toolkit fetch origin tag vX.Y.Z
git -C /absolute/Toolkit switch --detach vX.Y.Z
node /absolute/Toolkit/packages/agent-workflow/codex/skills/orchestrate-tickets/scripts/intake.mjs status /absolute/consuming-repo
```

The `status` response shows `activeHelper.version`, `activeHelper.source`, and
`activeHelper.sourceSha256`; `lastTick.helper` records what the last hourly run
used. Check these against the checkout and tag before resuming a schedule. A
consuming repo that vendors this package should also update its pin to the same
tag with `node cli.mjs pin agent-workflow vX.Y.Z`, then run
`node cli.mjs sync agent-workflow` from its installed `toolkit-sync` copy (see
`packages/toolkit-sync/README.md`). A vendored update does not update a separate
global skill symlink. Restart the Codex session or refresh the schedule prompt so
it resolves the updated skill and helper paths.

Example requests:

```text
Use $orchestrate-tickets for example/project issues 7, 8, 9 as batch exports.
Use $orchestrate-tickets to resume batch exports in /absolute/project.
```

Alternatively supply a manifest shaped like `examples/orchestration-batch.json`.
The skill fills checkout, base branch and initiating Codex model from the live
session. State lives at `.toolkit/orchestration/<batch-id>.json` in the stable
consuming checkout; keep this directory ignored. Run `pnpm orchestrate` from this
package, or `node src/orchestration-cli.mjs`, for the helper protocol documented in
the skill's `references/protocol.md`. Commands use JSON request files or stdin;
Paseo tool calls remain the Codex skill's responsibility.

Defaults: three isolated Claude worktrees, Auto permission mode, two review/fix
cycles per ticket, and hourly UTC Codex reconciliation. You merge PRs. Only a
verified merged PR lets orchestration replace `ready-for-agent` with `done` and
close the issue. Closed issues without a linked merged PR need reconciliation;
readiness labels do not make a closed issue launchable. Independent work continues
while PRs await your merge. Schedules pause on completion or when only human
blockers remain, and can be resumed explicitly after recovery.

The state helper reserves before launching and fences writes with a renewable
lease. After interruptions the skill locates existing workspaces, agents and PRs
before dispatching. Uncertain launches remain blocked rather than being repeated.
Schedules require the host, checkout, skill installation and credentials to remain
available; this is not a hosted queue or an automatic merge service.

## Triage-only sweeps with Paseo

`orchestrate-tickets` only ever acts on issues already labeled `ready-for-agent`.
`codex/skills/triage-tickets` is the lighter, independent counterpart that sweeps
unlabeled, `needs-triage`, and stale-`needs-info` issues into that state to begin
with, applying the interactive mattpocock `triage` skill's judgment. It runs on
its own schedule (default daily, `0 8 * * *` UTC), against the same persistent
checkout, and never opens a Paseo worktree or launches an implementation agent —
that boundary stays `orchestrate-tickets`'s job once an issue reaches
`ready-for-agent`. Install it the same way:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s /absolute/Toolkit/packages/agent-workflow/codex/skills/triage-tickets \
  "${CODEX_HOME:-$HOME/.codex}/skills/triage-tickets"
```

It reads the label vocabulary from the consuming repo's own
`docs/agents/triage-labels.md` rather than hardcoding the five canonical label
strings, and its only durable state is a short-lived run lock under
`.toolkit/triage/` that guards against two overlapping sweeps — the issue
tracker's own labels and comments remain the source of truth for what has
already been triaged, so there is no per-issue ledger to reconcile. Run
`pnpm triage` from this package, or `node src/triage-cli.mjs`, for the helper
protocol documented in the skill's `references/protocol.md`.

An issue found to already be implemented is closed autonomously as `wontfix`
with a pointer to where the behavior lives — the one outcome this skill both
recommends and applies unattended, because it's mechanically verifiable. A
recommended-but-rejected bug or enhancement only gets a comment; the issue's
label and open/closed state are left for a human to confirm. This skill never
grills and never launches implementation.

## Reporting digest for human review

`orchestrate-tickets` writes rich state — fix-cycle counts, blocked reasons,
now a per-transition `updatedAt` timestamp — but nothing previously
summarized it for a human between the real-time blocker surfacing that
happens mid-run. `codex/skills/report-tickets` is a separate, read-only
skill that turns that state, plus Paseo's `get_agent_activity`/`list_agents`,
into a periodic digest: tickets completed/in-flight/blocked-on-you since the
last digest, fix cycles nearing the two-cycle cap, token/turn cost per
ticket compared against the ticket's own `**Claude:** \`Model / effort\``
recommendation, and any ticket stuck longer than a configurable hour
threshold (default 24h). It never mutates `orchestrate-tickets`'s batch
state, creates a worktree, or launches a worker, and it runs on its own
schedule (default daily, `30 8 * * *` UTC), independent of both
`orchestrate-tickets` and `triage-tickets`. Install it the same way:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s /absolute/Toolkit/packages/agent-workflow/codex/skills/report-tickets \
  "${CODEX_HOME:-$HOME/.codex}/skills/report-tickets"
```

Run `pnpm report-tickets /absolute/checkout` from this package, or
`node src/digest-cli.mjs /absolute/checkout`, for the helper protocol
documented in the skill's `references/protocol.md`. The helper discovers
every batch file under `.toolkit/orchestration/` in the given checkout,
reads its own cursor at `.toolkit/report-tickets/cursor.json`, and writes
`digest.json` and `digest.md` beside it before advancing that cursor.
Paseo activity data and each ticket's parsed recommendation are gathered by
the calling skill session and the helper itself respectively — the helper
never calls Paseo directly.

This skill produces content only; it does not deliver anywhere. Point your
own Slack/email/push automation at the written `digest.md` (or parse
`digest.json` for anything richer than copy-pasting the Markdown) — whatever
delivery mechanism your host project already has wired up.

### Schedule the next N eligible tickets

```text
Use $orchestrate-tickets to schedule the next 5 eligible tickets in this project.
```

The skill selects a **fixed batch of up to N** open, unassigned `ready-for-agent`
issues, oldest first, with completed blockers and supported Claude recommendations.
It skips tickets in existing batches, known active work, conflicting status labels,
and issues with open or merged same-repository implementation PRs on a matching
ticket branch. It then starts the usual workers and hourly reconciliation schedule.
N is the batch size; at most three workers run at once. No new tickets are added
as the batch finishes. If none qualify, no schedule is created; a smaller
eligible set runs with its shortfall reported.

For a read-only preview, use the helper's `select-next` command with the normal
initialization fields, `count` instead of `tickets`, and the current Paseo Claude
`models` array. `init-next` rechecks and persists the batch under a shared selection
lock. See the skill's `references/selection.md` for details and exclusions. Keep
all batch state in the same checkout's `.toolkit/orchestration/` directory so
automatic and explicit batches share overlap protection.

### Admit more work every hour

```text
Use $orchestrate-tickets to select up to 3 new eligible tickets every hour,
with at most 3 tickets in progress across this project.
```

Hourly intake creates additional bounded batches as capacity becomes available.
The same N limits both new tickets per hour and active implementation/review work
across batches. Awaiting-merge PRs do not consume active slots; uncertain launches
and permission-waiting workers do. Queued work reserves admission capacity. Worker
reservations and resumptions enforce the shared cap, so overlapping batch schedules
cannot exceed it. Existing per-batch concurrency still caps each batch at three.

The intake schedule may use hourly UTC or a deliberately chosen cron and timezone.
Runs between UTC hour boundaries can reconcile existing work and retry a zero-admission
evaluation after readiness or capacity changes. Once a batch is admitted, later
ticks in that UTC hour replay it without adding tickets. Reconfiguration preserves
the saved schedule cadence unless a new one is supplied. Compare the saved policy
with the live Paseo schedule before describing it as enabled; preserve user pauses.
An enabled intake schedule keeps running when no work qualifies or capacity is full.
It never merges PRs. Use `scripts/intake.mjs` (or the package's `ticket-intake`
command) for configure/status/tick/pause/resume, as documented in the skill's
`references/intake.md`. Tick output distinguishes admissions, empty evaluations,
capacity waits, and replays, and includes the current shared capacity. Policies
live under `.toolkit/orchestration/.intake/`, with normal batch
files beside that directory; all runners must use the updated helper from one
stable checkout. Installing this capability does not activate a live intake job.
