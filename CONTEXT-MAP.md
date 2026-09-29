# Context Map

## Contexts

- [toolkit-sync](./packages/toolkit-sync/CONTEXT.md): pins, checks and re-syncs vendored Toolkit packages in consumer repositories
- [security-gates](./packages/security-gates/CONTEXT.md): the security checks consumer repositories run in CI, supplied by Toolkit

Other packages have no glossary yet; add a `CONTEXT.md` when a term needs pinning down.

## Relationships

- **toolkit-sync → security-gates**: consumers vendor the security-gates starter configuration with toolkit-sync; the Gates themselves are called, not vendored
