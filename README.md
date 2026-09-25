# Toolkit

[![Verify](https://github.com/ClabonConsultingLtd/Toolkit/actions/workflows/verify.yml/badge.svg)](https://github.com/ClabonConsultingLtd/Toolkit/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Safety-first developer tooling for agent workflows, Claude Code context optimisation, image generation, and image-to-3D conversion.

Toolkit is a collection of small, reusable packages—not a framework that takes over a repository. Every package keeps its paths, policies, credentials, and runtime state explicit.

## Choose a tool

| Need | Package | Outcome |
| --- | --- | --- |
| Keep Claude or Codex context focused | [`claude-token-optimisation`](packages/claude-token-optimisation/README.md) | Broad reads and routine passing command output are compressed without hiding failures. |
| Delegate a mechanical edit safely | [`agent-workflow`](packages/agent-workflow/README.md) | Provider handoffs are limited to declared files, transcripted, and reviewable. |
| Run a queue of implementation tickets | [`agent-workflow`](packages/agent-workflow/README.md#ticket-batches) | Tickets run serially, require a completion status, and resume from recorded state. |
| Generate a batch of images | [`image-generation`](packages/image-generation/README.md) | A caller-chosen runner gains retries, quota stops, logs, and resumable state. |
| Turn reference images into GLBs | [`image-to-3d`](packages/image-to-3d/README.md) | Explicit queues become auditable image-to-model batches through a Gradio-compatible service. |
| Track a vendored Toolkit package's version | [`toolkit-sync`](packages/toolkit-sync/README.md) | A consuming repo pins a release, detects drift, and re-syncs updates instead of an untracked copy-paste. |
| Set up a repository for Claude Code | [`setup-wizard`](packages/setup-wizard/README.md) | One command vendors the packages, installs token optimisation, and configures the Claude ticket runner. |

## Quick starts

### Set up a repository for Claude Code

```bash
node path/to/Toolkit/packages/setup-wizard/setup.mjs path/to/your-repository
```

The [Windows guide](docs/guides/claude-windows-setup.md) covers the same setup step by step, from a fresh machine through the `/grill-with-docs` → `/to-spec` → `/to-tickets` workflow.

### Claude Code context optimisation

```bash
node packages/claude-token-optimisation/install.mjs path/to/your-repository
```

The installer writes a settings fragment for the repository owner to review and merge.

### Ticket batches

```bash
pnpm --dir packages/agent-workflow ticket-batch ticket-batch.json --dry-run
pnpm --dir packages/agent-workflow ticket-batch ticket-batch.json
```

The ticket tools are compatible with Markdown tickets created by Matt Pocock's `/grill-with-docs` → `/to-spec` → `/to-tickets` workflow. They use the ticket's `**Status:**` field as the launch and completion contract; they do not invoke those skills themselves.

### Image generation

```bash
toolkit-image-generate prompts.txt --output-dir generated \
  --runner image-runner --runner-arg run --runner-arg "{instruction}"
```

### Image to 3D

```bash
toolkit-image-to-3d queue.json --source-root . --dry-run
```

## Prerequisites

| Component | Requirement |
| --- | --- |
| Node packages | Node.js 24+, Corepack, and pnpm 11 |
| Python packages | Python 3.11+ and [uv](https://docs.astral.sh/uv/) |
| Claude integration | Claude Code, only when using the optional `.claude` assets |
| Image-to-3D conversion | A user-supplied token, normally `HF_TOKEN` |
| Provider handoff | Explicit opt-in, an OpenAI-compatible endpoint and model; a key for remote endpoints |
| Worktree helper | Git, only when deliberately creating a worktree |

Install Node dependencies from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Use `uv sync` from either Python package directory when installing its dependencies.

## Safety model

- Credentials are supplied through environment variables and never written to source-controlled state.
- Tools do not embed personal paths, network shares, project taxonomy, or hidden defaults.
- Hooks fail open: an optimisation failure must not stop ordinary work.
- Model handoffs require an explicit enable switch and may edit only task-declared files.
- Image batches verify output before recording success and stop on quota or rate-limit signals.

## Guides

- [Toolkit with Claude Code on Windows](docs/guides/claude-windows-setup.md): set up a repository from a fresh machine with `toolkit-sync`, token optimisation and the ticket workflow.

## Project standards

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Architecture](docs/architecture.md)
- [Release process](docs/release.md)
- [Changelog](CHANGELOG.md)
- [MIT licence](LICENSE)

## Status

Toolkit is pre-1.0. Command and manifest contracts may evolve. Pin revisions when adopting it in another project, and read package-level README files for the precise interface and safety boundaries.
