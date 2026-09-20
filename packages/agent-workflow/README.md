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
