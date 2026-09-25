# Context optimisation for Claude and Codex

Integration assets for keeping broad reads and routine successful command output from consuming the primary session's context. Claude Code and Codex use host-specific hooks around shared summary logic; Codex also has an explicit skill and command wrapper.

The agent-neutral rules for reads and command output live in [CONTEXT-POLICY.md](CONTEXT-POLICY.md). Installation copies it to `.claude/CONTEXT-POLICY.md`; consuming repositories can point both `AGENTS.md` and `CLAUDE.md` there instead of maintaining two versions of the guidance. The hooks below are Claude Code adapters.

## Included assets

- `agents/bulk-reader.md`: a read-only subagent for factual exploration of large files or file groups.
- `hooks/guard-large-read.mjs`: asks the primary agent to delegate an untargeted large read, while allowing subagents and targeted reads.
- `hooks/summarize-bash.mjs`: runs a deliberately narrow allowlist of commands, retains full output in a local log, and returns only a summary on success. It never summarizes a failure.

## Install

Run `node install.mjs <target-repository>`. It copies the agent and hooks into the target’s `.claude` directory and writes a non-overwriting `settings.toolkit-token-optimisation.json` fragment for the project owner to merge into its Claude settings.

For Codex, symlink `codex/skills/context-optimisation` from a persistent Toolkit checkout into `${CODEX_HOME:-$HOME/.codex}/skills/context-optimisation`. The skill uses the same bulk-reader guidance and the `summarize-command.mjs` wrapper. For an allowlisted command, run `node /absolute/Toolkit/packages/claude-token-optimisation/summarize-command.mjs git status` (or `pnpm -r list --depth -1`, or a single-file `vitest run` command). The wrapper writes full successful output to `.toolkit/claude-token-optimisation/bash-summary-logs`; failures print full output and retain their exit status.

For automatic command summarization in Codex, copy the `PreToolUse` entry from [`codex/hooks.example.json`](codex/hooks.example.json) into a trusted repository's `.codex/hooks.json` (or your user-level `~/.codex/hooks.json`). Replace `YOUR_TOOLKIT_DIRECTORY` with this package's absolute directory; retain other hooks already in the file. Codex requires review and trust of the new hook definition through `/hooks` before it runs. The hook rewrites only the shared narrow command allowlist to the wrapper, so the command executes once. It does not intercept broad reads or alter failed command output. The skill works without the hook.

Set `BULK_READER_MIN_LINES` to change the large-read threshold; it defaults to 350 lines.

The bash summary hook writes raw successful-command logs under `.toolkit/claude-token-optimisation/bash-summary-logs` in the current repository by default. Set `TOOLKIT_STATE_DIR` to relocate runtime state.

Set `TOOLKIT_BASH_SUMMARY_SURVEY=on` to additionally log a `{command, at}` line to `.toolkit/claude-token-optimisation/bash-summary-survey.jsonl` for every command that misses the allowlist, without running or otherwise touching that command. Off by default. Use it to mine your own project's real usage for candidate additions to the allowlist above.

The summary allowlist is intentionally small: exact `git status`, `pnpm -r list --depth -1`, and one-file `vitest run` commands. When a command does not match, the hook does nothing. Do not broaden it to arbitrary test pipelines or background tasks; prefer a command that runs once, keeps its exit status, and stores the full log. In particular, `test-command | tail` without `pipefail` can report success when the test failed.
