## Agent skills

### Issue tracker

Issues live as GitHub issues on `ClabonConsultingLtd/Toolkit`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: a root `CONTEXT-MAP.md` points to a `CONTEXT.md` per package under `packages/*`. See `docs/agents/domain.md`.

### Context use

Follow [`packages/claude-token-optimisation/CONTEXT-POLICY.md`](packages/claude-token-optimisation/CONTEXT-POLICY.md)
for targeted reads and command output. Its read and output rules apply to Codex;
the Claude hook scripts remain Claude-specific.
