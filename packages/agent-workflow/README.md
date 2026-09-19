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

Reads status from an issue's labels via the `gh` CLI. A ticket reference is a GitHub issue number (a leading `#` is stripped). Status is the suffix of whichever label starts with `statusLabelPrefix` (default `"status:"`, so a label `status:ready` yields status `ready`); a closed issue with no matching label falls back to `closedStatus` (default `"closed"`). `gh` must be authenticated and run inside a clone of the target repo.

```json
{
	"provider": "github",
	"readyStatus": "ready",
	"command": "your-agent-launch-command",
	"statusLabelPrefix": "status:",
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
