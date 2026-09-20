---
name: report-tickets
description: Produce a periodic digest of orchestrate-tickets batches for human review — completed/in-flight/blocked tickets, fix-cycle counts nearing the cap, token/turn cost versus the ticket's model/effort recommendation, and stuck-ticket anomalies. Read-only: never mutates ticket state, creates a worktree, or launches a worker. Use for scheduled reporting, not real-time blocker surfacing.
---

# Report tickets

Use the helper alongside Paseo MCP tools; the helper does not itself call Paseo or GitHub for agent activity.
Read [the helper protocol](references/protocol.md) before running a digest.
Run the helper at this skill's `scripts/digest.mjs` (installed by symlink to its Toolkit checkout).

## Scope

This skill only reads. It never writes to `orchestrate-tickets`'s batch state file, never creates a Paseo worktree, and never launches a worker. Real-time blocker/permission surfacing stays inside `orchestrate-tickets`, immediate rather than batched here.

It runs on its own repo-wide schedule, independent of both `orchestrate-tickets`'s hourly reconciliation and any triage schedule. One run sweeps every batch state file under `<checkout>/.toolkit/orchestration/`, not one schedule per batch.

## Gather inputs

Resolve the same stable checkout `orchestrate-tickets` uses. Call Paseo's `list_agents` and `get_agent_activity` for every `agentId` referenced by a discovered batch's tickets; build an `activity` map keyed by agent ID with `{ tokenCost, turnCost }` (name the fields however Paseo reports them — the helper only reads `tokenCost`/`turnCost`). The helper fetches each ticket's own recommendation from its issue body itself (via `gh`), so you do not need to pass that in.

## Run the helper

```
node <skill>/scripts/digest.mjs /absolute/checkout [request.json|-]
```

Request is optional JSON: `{ "stuckHours": 24, "activity": { "<agentId>": { "tokenCost": 12000, "turnCost": 8 } } }`. Omit `stuckHours` to use the default 24-hour threshold; a repo may override it. Output is the digest JSON (with a `markdown` field appended) printed to stdout, and also written to `<checkout>/.toolkit/report-tickets/digest.json` and `digest.md`. The helper advances its own cursor (`<checkout>/.toolkit/report-tickets/cursor.json`) only after successfully writing both output files.

## Delivery

This skill produces content only. Delivery (Slack, email, push notification, or any other channel) is the host project's responsibility — hand the Markdown file to whatever automation the project already has wired up, or use the JSON as a contract for anything beyond copy-pasting the Markdown. Document per-project delivery configuration outside this skill.

## Schedule

Ensure exactly one schedule per repository, distinct from `orchestrate-tickets`'s and any triage schedule. Use `list_schedules` to recover a previously created one before creating a new one. Default cadence `cron: "30 8 * * *"`, `timezone: "UTC"`; a repo may override this cadence. Use `isolation: "local"` and the stable checkout as `cwd`. The schedule prompt must name this skill's absolute SKILL.md path and the absolute checkout path, and instruct: sweep every batch state file under `.toolkit/orchestration/`, gather Paseo agent activity for referenced agents, run the helper, and never mutate `orchestrate-tickets` state.

Finish by reporting the digest's summary counts and a link to the written Markdown file, not by pasting the full table unless asked.
