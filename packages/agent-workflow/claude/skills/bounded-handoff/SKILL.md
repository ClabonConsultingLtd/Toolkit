---
name: bounded-handoff
description: Delegate a mechanical, reviewable edit through the Toolkit bounded-handoff CLI. Use only when the parent agent can independently verify every changed line.
---

# Bounded handoff

Use only for repetitive mechanical edits, established test cases, or direct format translation. Do not delegate architectural decisions, interface changes, documentation arguments, or acceptance checks.

Write a task file with the smallest possible `Editable` list and a precise `Instruction`. Preview the exact prompt first:

```bash
pnpm handoff path/to/task --dry-run
```

An actual call requires an explicit enable switch and a user-provided credential. After it returns, read the complete diff. A green command result is not approval of the change.
