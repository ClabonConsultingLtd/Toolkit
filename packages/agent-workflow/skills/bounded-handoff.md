# Bounded handoff procedure

Delegate only a small, mechanical edit whose every changed line you can verify yourself. Suitable work includes repeated edits following an existing template, direct format translation, or test cases you have already specified. Keep architecture, interface decisions, acceptance checks, and reasoning-heavy documentation with the primary agent.

1. State what you are delegating. Write `task.md` with a minimal `Editable:` file list and a precise `## Instruction` section.
2. Preview with `pnpm --dir /path/to/agent-workflow handoff /path/to/task --dry-run`. Inspect the prompt and file contents before sending them to the configured endpoint.
3. Run only with `TOOLKIT_HANDOFF_ENABLED=on` and an endpoint/model configured as described in the package README. A local unauthenticated endpoint is supported; remote endpoints require a key.
4. Read the full diff, run appropriate checks, and record the delegated work in the ticket or PR. Check for invented imports and changes beyond the requested behavior. A successful CLI exit is not acceptance.

Task example:

```markdown
Editable:
- src/example.ts

## Instruction

Apply the specified mechanical change.
```

Keep the number of handoffs small. If the edit becomes hard to review, finish it directly.
