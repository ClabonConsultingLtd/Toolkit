# Contributing to Toolkit

Toolkit accepts focused changes that improve a package's reliability, portability, safety, or documentation. Keep a pull request scoped to one package or cross-cutting concern.

## Before changing code

1. Read the relevant package README and its tests.
2. Preserve the core rule: no project-specific paths, infrastructure names, credentials, asset taxonomy, or hidden operational assumptions.
3. Prefer explicit command-line options and configuration over new defaults.
4. Add or adjust an offline test when behavior changes.

## Local checks

```bash
pnpm lint
ruff check --select S packages/image-generation packages/image-to-3d
python -m unittest discover -s packages/image-generation/tests -v
python -m unittest discover -s packages/image-to-3d/tests -v
pnpm --dir packages/agent-workflow test
pnpm --dir packages/claude-token-optimisation test
pnpm --dir packages/toolkit-sync test
```

Use Black for Python and Biome for JavaScript, JSON, YAML, and Markdown. Do not commit generated images, model files, provider transcripts, credentials, `node_modules`, or local runtime state.

## Security Gates

Pull requests and pushes to `main` run Toolkit's own security Gates (secrets, dependencies, static analysis): see [`packages/security-gates/README.md`](packages/security-gates/README.md) for how they work, and how to fix or suppress a finding.

Install the pre-commit hooks to catch secrets and Python security findings before they're committed:

```bash
pipx install pre-commit  # or: pip install pre-commit
pre-commit install
```

Nothing enforces pre-commit locally; the Gates in CI still decide whether a change can merge.

## Pull requests

Explain the user-facing outcome, list tests run, and call out any changed prerequisites, environment variables, or CLI contracts. A contributor must be able to understand the proposed behavior without access to a private project.
