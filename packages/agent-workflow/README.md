# Agent workflow

Provider-aware developer automation with project-defined policy. `pnpm handoff <task-directory> --dry-run` previews a bounded handoff; set `TOOLKIT_HANDOFF_ENABLED=on` plus provider credentials to execute it. `pnpm ticket <ticket> --dry-run` validates a ticket before launching the command supplied in `TOOLKIT_TICKET_COMMAND`.

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
