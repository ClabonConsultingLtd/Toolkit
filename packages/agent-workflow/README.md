# Agent workflow

Provider-aware developer automation with project-defined policy. `pnpm handoff <task-directory> --dry-run` previews a bounded handoff; set `TOOLKIT_HANDOFF_ENABLED=on` plus provider credentials to execute it. `pnpm ticket <ticket> --config ticket-config.json --dry-run` validates a ticket before launching the command declared in that configuration file.

## Ticket workflow compatibility

`ticket` and `ticket-batch` are built for Markdown tickets produced by Matt Pocock's `/grill-with-docs` → `/to-spec` → `/to-tickets` workflow. They expect a top-level `**Status:** <value>` declaration and use it as the launch gate and completion check. Toolkit does not bundle or invoke those skills; a project remains free to create compatible tickets by another means.

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
