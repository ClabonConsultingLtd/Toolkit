---
name: bounded-handoff
description: Delegate a mechanical, reviewable edit through the Toolkit bounded-handoff CLI. Use only when the parent agent can independently verify every changed line.
---

# Bounded handoff

The CLI does the typing; you keep the understanding. The handoff is only worth making when you could have written the change yourself and chose not to.

## The gate, before anything else

**If you could not have written it unaided, you cannot delegate it** — you would not catch it being wrong, and an unreviewable diff is worse than no help. This gate is the whole skill; the lists below only apply it.

## Delegable

- Repetitive mechanical edits across several files that already look alike
- Test bodies for cases you have already enumerated
- Direct format translation
- Boilerplate that follows an existing file as a template — cite the template in the instruction

## Never delegable

- Architectural decisions or interface changes
- Documentation arguments, ADR-style reasoning, or any comment whose job is to argue rather than describe
- Acceptance checks: confirming a test fails against the old code, or that a ticket's criteria are actually met, is yours
- Anything you could not review line-by-line in the time it would have taken to write it

## Making a handoff

1. Say what you're delegating and why in one line before the call, e.g. "Handing off: test bodies for the three enumerated cases, 2 files." Don't make it silent.
2. Write a task file with the smallest possible `Editable` list and a precise `Instruction`:

   ```markdown
   Editable:
   - src/example.ts

   ## Instruction

   Make the bounded mechanical change.
   ```

   The `Editable:` list is the entire blast radius — list the fewest files the change actually needs.
3. Preview the exact prompt first:

   ```bash
   pnpm handoff path/to/task --dry-run
   ```

   A dry run needs no credential and makes no network call.
4. An actual call requires an explicit enable switch (`TOOLKIT_HANDOFF_ENABLED=on`) and a user-provided credential.

## Reviewing what comes back

Read the complete diff. A green command result is not approval of the change.

- Comments that describe rather than argue for the change are the reliable tell of generated code — rewrite or delete them.
- Invented imports, helpers, or APIs.
- Files outside the `Editable:` set — the applier should have refused these; one reaching you is a finding about the applier, not something to wave through.
- Whether the result actually satisfies what you asked for, rather than something adjacent to it.

## Limits

- Keep handoffs to a small number per session. Needing many in a row is a sign the work was not as mechanical as it looked — stop delegating and write it yourself.
- Record what was delegated somewhere reviewable (a ticket's notes, a PR description) so a later reader knows which lines came from the handoff.
