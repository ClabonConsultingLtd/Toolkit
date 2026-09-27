---
name: bounded-handoff
description: Delegate a small mechanical edit through Toolkit handoff when you can verify every changed line.
---

# Bounded handoff

Use the Toolkit agent-workflow package's `handoff` command; the provider is selected by environment configuration, not by this skill. This skill is self-contained so it still works when copied into a skills directory. If `.toolkit/overlays/bounded-handoff.md` exists in the project, read it first: its rules add to this skill's rules and win where they conflict (see `packages/toolkit-sync`'s README for the overlay convention).

If you could not have written it unaided, you cannot delegate it: you would not catch it being wrong, and an unreviewable diff is worse than no help. Delegate only a small, mechanical edit whose every changed line you can verify yourself. Suitable work includes repeated edits following an existing template, direct format translation, or test cases you have already specified. Keep architecture, interface decisions, acceptance checks, reasoning-heavy documentation, and anything whose product is a comment that argues rather than describes with the primary agent — a cheaper model writes fluent comments that look like arguments but aren't, and review is worst at catching that defect.

1. Announce the delegation in one line before calling `handoff`; don't ask permission first, and don't make it silent.
2. Write `task.md` with a minimal `Editable:` file list and a precise `## Instruction` section. Add an optional `Context:` list for files the model should read but never edit — a path listed in both is rejected. If the project config sets one or more allowed-hours windows, check the clock yourself before writing the task file; the CLI enforces them, so a run outside every window is refused regardless.
3. Preview with `pnpm --dir /path/to/agent-workflow handoff /path/to/task --dry-run`. Inspect the prompt and file contents before sending them to the configured endpoint.
4. Run only with `TOOLKIT_HANDOFF_ENABLED=on` and an endpoint/model configured as described in the package README, either as environment variables or in a `.env` file (`--env-file PATH` to use one outside the default location); values already in the environment win, and none of it is ever printed or written to a task file. A local unauthenticated endpoint is supported; remote endpoints require a key. A malformed or inapplicable response is retried once automatically with the applier's own error; a second failure returns the task to you.
5. If the project configures post-apply gates (for example a formatter or a focused typecheck), read `result.md` in the task directory. It is information, not acceptance — a gate result never substitutes for reading the diff yourself.
6. Read the full diff, run appropriate checks, and record the delegated work in the ticket or PR. Watch especially for invented imports, changes beyond the requested behavior, and comments that describe rather than argue. A green typecheck only proves the code compiles, which was never in doubt, and a successful CLI exit is not acceptance.

Task example:

```markdown
Editable:
- src/example.ts

Context:
- src/example.template.ts

## Instruction

Apply the specified mechanical change.
```

Keep the number of handoffs small. If the edit becomes hard to review, finish it directly.
