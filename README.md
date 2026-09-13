# Toolkit

Toolkit is a clean, reusable collection of developer and creative-production tools. Each package is independently usable: it has no embedded project paths, asset taxonomy, infrastructure names, or product workflow assumptions.

Use the tools selectively. Toolkit is not a framework that takes ownership of a repository.

## What is included

| Package | What it does | Why it exists |
| --- | --- | --- |
| `@toolkit/claude-token-optimisation` | Claude Code agent, hooks, and installer for large reads and routine command output. | Keeps primary-agent context focused without suppressing failure diagnostics. |
| `@toolkit/agent-workflow` | Bounded model handoff, configurable ticket launcher, and optional worktree helper. | Makes mechanical delegation reviewable and opt-in instead of giving a provider unrestricted repository access. |
| `toolkit-image-generation` | Resumable prompt-file image batch runner around a caller-supplied executable. | Runs large image batches reliably without binding the toolkit to one model, art style, CLI, or storage system. |
| `toolkit-image-to-3d` | Explicit image-reference to GLB queue conversion, initially for TRELLIS-compatible Gradio APIs. | Turns a repeatable API sequence into an auditable, resumable batch process. |

## Design principles

- Configuration is supplied through command-line options, environment variables, or checked-in project configuration—not hidden defaults.
- Credentials are never generated, read from source files, or written to reports.
- Runtime state, logs, generated images, model outputs, and provider transcripts belong outside source control.
- Hooks fail open: a broken context-saving integration must not prevent normal work.
- Model-assisted edits are bounded by an explicit editable-file list and require human diff review.

## Claude token optimisation

Location: [`packages/claude-token-optimisation`](packages/claude-token-optimisation/README.md)

This package is for repositories that use Claude Code and want to spend context where it matters.

- **Bulk reader agent**: a read-only factual analyst for broad exploration of large files or file groups. It reports evidence and paths rather than pulling raw source into the primary session.
- **Large-read guard**: detects an untargeted file read above a configurable line threshold (350 by default) and suggests delegating it to the bulk reader. Targeted reads and subagent reads remain available.
- **Bash summarizer**: captures and summarizes a narrow allowlist of successful, routine commands such as a clean `git status` or a single passing test file. Any failed command keeps its raw output intact.

Install it into a repository:

```bash
node packages/claude-token-optimisation/install.mjs path/to/your-repository
```

The installer copies the agent and hooks to `.claude/`, then writes a settings fragment for a project owner to merge deliberately. Set `BULK_READER_MIN_LINES` to adjust the broad-read threshold; set `TOOLKIT_STATE_DIR` to relocate the hook log directory.

## Agent workflow

Location: [`packages/agent-workflow`](packages/agent-workflow/README.md)

This package separates helpful delegation from unreviewable delegation.

### Bounded provider handoff

Create a task directory containing `task.md`:

```markdown
Editable:
- src/example.ts

## Instruction

Add the already-specified mechanical change.
```

Preview the exact repository context and prompt before any external call:

```bash
pnpm --dir packages/agent-workflow handoff path/to/task --dry-run
```

For a real call, explicitly set `TOOLKIT_HANDOFF_ENABLED=on`, `DEEPSEEK_API_KEY`, and `DEEPSEEK_MODEL`. The tool sends only the declared editable files, writes `request.json` and `response.md` in the task directory, accepts only file-qualified SEARCH/REPLACE blocks for declared files, and prepares all edits before writing. Review the completed diff every time.

Use this for repetitive changes, established test cases, scaffolding, or direct format translation. Do not use it for architecture, API design, acceptance decisions, comments that carry reasoning, or anything you cannot independently review.

### Ticket launcher and worktrees

The ticket launcher uses a portable JSON file rather than assuming an issue tracker or repository layout:

```json
{"readyStatus":"ready","command":"your-agent-launch-command"}
```

```bash
pnpm --dir packages/agent-workflow ticket path/to/ticket.md --config ticket-config.json --dry-run
```

The optional worktree helper is separate, so a normal ticket launch never creates Git state implicitly:

```bash
pnpm --dir packages/agent-workflow worktree path/to/ticket.md .worktrees --dry-run
```

## Image generation

Location: [`packages/image-generation`](packages/image-generation/README.md)

This runner takes a simple blank-line-separated prompt file. The first line is a safe output identifier; the remaining lines are the prompt. The runner executable is supplied by the caller, so Toolkit works with whichever generation system a project approves.

```text
sample-image
A neutral product image of a ceramic cup on a plain backdrop.
```

Install or run the package with a Python package manager, then provide the executable and its arguments:

```bash
toolkit-image-generate prompts.txt --output-dir generated \
  --runner image-runner --runner-arg run --runner-arg "{instruction}"
```

Runner arguments may use `{instruction}`, `{prompt}`, and `{output}`. Toolkit builds an argument vector directly rather than constructing a shell command.

Why use it: it records progress after each item, checks that a non-empty output was produced, retries ordinary failures, stops on quota/rate-limit messages, and resumes later without regenerating completed images. `--staging-dir` supports a local generation location followed by a copy to the final output directory. Use `--dry-run`, `--limit`, `--timeout`, `--log-dir`, and `--retry-failed` to control a batch.

## Image to 3D

Location: [`packages/image-to-3d`](packages/image-to-3d/README.md)

This package converts a caller-defined JSON queue of reference images into GLB models through a Gradio-compatible service. Its first API preset targets TRELLIS, but queues and paths remain generic:

```json
[
  {
    "id": "sample-object",
    "reference": "references/sample-object.png",
    "model": "models/sample-object.glb"
  }
]
```

Validate the queue before spending service quota:

```bash
toolkit-image-to-3d queue.json --source-root . --dry-run
```

Then convert with a user-supplied service token (default environment variable: `HF_TOKEN`):

```bash
toolkit-image-to-3d queue.json --source-root . --results results.json --ledger ledger.json
```

Why use it: it normalizes queue records, rejects relative path traversal, skips existing models by default, retries transient failures, stops on quota exhaustion, writes a per-run report, and can maintain a cumulative ledger. `--overwrite` is explicit because replacing a generated model is a meaningful action. The optional Claude skill lives under `packages/image-to-3d/claude/`.

## Development and verification

The repository includes offline tests for every package, a GitHub Actions workflow, `pnpm-lock.yaml`, and a `uv.lock` per Python package.

Run the same checks locally:

```bash
node --test "packages/agent-workflow/test/*.test.mjs"
node --test "packages/claude-token-optimisation/test/*.test.mjs"
python -m unittest discover -s packages/image-generation/tests -v
python -m unittest discover -s packages/image-to-3d/tests -v
```

See [architecture](docs/architecture.md), [security boundaries](docs/security.md), and the [release process](docs/release.md) for the remaining maintenance details.
