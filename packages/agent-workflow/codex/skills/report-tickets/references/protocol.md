# Helper protocol

Node 24+, authenticated `gh`, and a persistent Toolkit checkout are required. Paseo is used by the calling skill session to gather agent activity before invoking the helper; the helper itself never calls Paseo.

`node <skill>/scripts/digest.mjs /absolute/checkout [request.json|-]`

Input is JSON from a file, or stdin with `-`; output is JSON with a `markdown` field appended, printed to stdout and written to disk. Nonzero exit means no digest was produced or the cursor was not advanced.

## What it reads

- Every `*.json` file directly under `<checkout>/.toolkit/orchestration/` (mutex directories and `*.tmp` write-in-progress files are ignored automatically). Each is treated as an `orchestrate-tickets` batch state file; a file without `updatedAt` on some or all of its tickets is read normally — those tickets are treated as having no known update time, not as an error.
- `<checkout>/.toolkit/report-tickets/cursor.json`, this skill's own persistent cursor, shaped `{ "lastDigestAt": <ISO timestamp or null> }`. Distinct from `orchestrate-tickets`'s batch state; never shared with it.
- Each ticket's issue body, fetched via `gh issue view --json body` against the batch's `repository`, parsed with the same `**Claude:** \`Model / effort\`` convention `orchestrate-tickets` uses, to compare against the ticket's persisted `provider`/`thinkingOptionId` (the model/effort actually used).
- An `activity` map supplied in the request, keyed by `agentId`, with `{ tokenCost, turnCost }` per entry — gathered by the calling skill session from Paseo's `get_agent_activity`/`list_agents` before invoking the helper.

## What it writes

- `<checkout>/.toolkit/report-tickets/digest.json` — the structured digest.
- `<checkout>/.toolkit/report-tickets/digest.md` — a Markdown rendering of the same data.
- `<checkout>/.toolkit/report-tickets/cursor.json` — updated to the current run's `generatedAt`, only after both output files are written successfully.

It never writes to `orchestrate-tickets`'s batch state file.

## Request fields

| Field | Default | Purpose |
| --- | --- | --- |
| `stuckHours` | `24` | Non-completed tickets whose `updatedAt` is older than this many hours are flagged `anomalous`. Missing `updatedAt` is never flagged. |
| `activity` | `{}` | Map of `agentId` to `{ tokenCost, turnCost }`, gathered from Paseo by the caller. A ticket with no `agentId`, or no matching entry, reports `null` cost. |
| `now` | current time | Override for reproducible runs (e.g. tests); omit in normal use. |

## Digest JSON shape

```json
{
  "generatedAt": "<ISO timestamp>",
  "since": "<ISO timestamp or null — the previous cursor>",
  "batches": [
    {
      "batchId": "exports",
      "repository": "example/project",
      "summary": {
        "completed": 2,
        "inFlight": 1,
        "blockedOnYou": 1
      },
      "tickets": [
        {
          "number": "7",
          "status": "blocked",
          "blockKind": "human",
          "fixCycles": 2,
          "updatedAt": "<ISO timestamp or null>",
          "tokenCost": 12000,
          "turnCost": 8,
          "recommendation": { "model": "Sonnet", "effort": "medium" },
          "actual": { "model": "claude-sonnet-5", "effort": "high" },
          "fixCycleCapped": true,
          "recommendationMismatch": true,
          "anomalous": false
        }
      ]
    }
  ]
}
```

`summary` counts only tickets whose `updatedAt` is newer than the previous cursor (every ticket if there is no previous cursor). The `tickets` array always lists every ticket in the batch, regardless of cursor, so fix-cycle-cap and stuck-ticket flags stay visible even when a ticket hasn't moved since the last digest. `fixCycleCapped` is `fixCycles >= 2`. A recommendation is only fetched, and `recommendationMismatch` only computed, for a ticket that already has an actual runtime (i.e. was reserved) — a still-queued ticket has nothing to compare against, so it is skipped. Model comparison mirrors `resolveRuntime`'s own matching: an exact id/label match, or a bare family name (`Sonnet`/`Opus`/`Haiku`) matching any numbered model in that family, since the digest has no model catalog to resolve a family recommendation to the exact id that was actually launched. `anomalous` is the fixed-hour-threshold stuck-ticket flag only (a non-completed ticket whose `updatedAt` is older than `stuckHours`); it is never true when `updatedAt` is unknown.

## Recovery

Cursor writes are atomic; a run that fails partway (a crashed process, a `gh` outage) never advances the cursor, so the next run recomputes from the same `since` point. There is no lease or mutex here — this skill never contends with `orchestrate-tickets` for the batch state file, since it only reads it.
