# Helper protocol

Node 24+, authenticated `gh`, and a persistent Toolkit checkout are required.
Paseo MCP is required only for the scheduling step; nothing in this skill uses
Paseo to launch an agent.

`node <skill>/scripts/triage.mjs COMMAND [request.json|-]`

Input is JSON from a file, or stdin with `-`; output is JSON. Pass arguments as
separate shell arguments, never interpolate issue text into commands. Nonzero
exit means no action is authorized.

Unlike `orchestrate-tickets`'s helper, this one holds no durable per-issue
state and issues no lease token: the issue tracker's own labels and comment
history are the sole source of truth for what has already been triaged, and
bucket membership is recomputed fresh every run. There is no `init`,
`status`, `acquire`/`renew`/`release` lease cycle, or ticket-shaped command
set — only label-mapping resolution and a same-process-agnostic run lock.

| Command | Request fields | Result / purpose |
| --- | --- | --- |
| labels | path (absolute path to the repo's `docs/agents/triage-labels.md`) | `{ mapping, statusLabels }`: the canonical-role → repo-label mapping, and `statusLabels` as the five mapped label strings in canonical order (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). Throws if any canonical role is unmapped. |
| lock | lockDir (absolute, e.g. `<stable-checkout>/.toolkit/triage`); optional ttlMs (default 1,800,000 / 30 min) | `{ acquired, lockPath, ... }`. `acquired:false` means another run currently holds the lock (started within `ttlMs`); do not proceed. A lock older than `ttlMs` is treated as abandoned by a crashed run and reclaimed automatically — there is no manual-recovery step, because the lock only fences the race between two overlapping runs, not any state this helper owns. |
| unlock | lockDir | `{ released }`. Best-effort; release even after an error, before the run ends. |

Every issue-tracker read and write (listing buckets, reading an issue's body
and comments, applying labels, posting comments, closing an issue) goes
through `gh` directly, per this repo's `docs/agents/issue-tracker.md`
conventions — the helper does not wrap the tracker. The helper's only job is
the two pieces of state that a bare `gh` call can't safely express on its
own: resolving this repo's label vocabulary, and fencing overlapping runs.

Example: resolve labels, then acquire the lock, before building the bucket.

```bash
node scripts/triage.mjs labels <<'JSON'
{ "path": "/absolute/project/docs/agents/triage-labels.md" }
JSON

node scripts/triage.mjs lock <<'JSON'
{ "lockDir": "/absolute/project/.toolkit/triage" }
JSON
```

Release the lock unconditionally at the end of the run, success or failure:

```bash
node scripts/triage.mjs unlock <<'JSON'
{ "lockDir": "/absolute/project/.toolkit/triage" }
JSON
```

## Recovery

A stale lock (its `startedAt` older than `ttlMs`) is reclaimed by the next
run automatically — this is safe because the lock protects only the race
between two overlapping sweeps, never a partially-written state file. There
is nothing else to reconcile: a run that dies partway through the bucket
simply leaves some issues in whatever label state it last applied, and the
next scheduled run picks them back up from the tracker's live labels, exactly
as if it were the first run.
