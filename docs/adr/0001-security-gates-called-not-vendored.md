# security-gates are called as a reusable workflow, not vendored

Every other Toolkit package reaches consumers as files vendored with toolkit-sync. security-gates doesn't. The Gates live in a reusable workflow in Toolkit, and consumers call it from a small caller workflow pinned to a commit SHA, with Dependabot proposing bumps. Only the starter configuration is vendored.

We chose this because toolkit-sync copies a package into a single destination directory, while CI workflows and pre-commit configuration must live at fixed paths (`.github/workflows/`, the repository root). Calling the workflow also keeps the Gate logic in one place, so a fix reaches every consumer as a one-line pin bump instead of a re-sync of copied YAML.

## Considered options

- **Vendor the workflow files.** This needs toolkit-sync to write outside its destination directory, which changes its model, and every consumer carries its own copy of the Gate logic.
- **Composite actions per scanner.** Consumers would assemble their own workflow, which brings back the per-repository drift this package exists to remove.

## Consequences

- The reusable workflow's inputs are a public interface. Changing them incompatibly is a major release.
- A Suppression lives in the consumer repository, in the tool's own ignore file. Toolkit never writes it.
