# Claude token optimisation

Claude Code integration assets for keeping broad reads and routine successful command output from consuming the primary session's context.

## Included assets

- `agents/bulk-reader.md`: a read-only subagent for factual exploration of large files or file groups.
- `hooks/guard-large-read.mjs`: asks the primary agent to delegate an untargeted large read, while allowing subagents and targeted reads.
- `hooks/summarize-bash.mjs`: runs a deliberately narrow allowlist of commands, retains full output in a local log, and returns only a summary on success. It never summarizes a failure.

## Install

Run `node install.mjs <target-repository>`. It copies the agent and hooks into the target’s `.claude` directory and writes a non-overwriting `settings.toolkit-token-optimisation.json` fragment for the project owner to merge into its Claude settings.

Set `BULK_READER_MIN_LINES` to change the large-read threshold; it defaults to 350 lines.

The bash summary hook writes raw successful-command logs under `.toolkit/claude-token-optimisation/bash-summary-logs` in the current repository by default. Set `TOOLKIT_STATE_DIR` to relocate runtime state.

Set `TOOLKIT_BASH_SUMMARY_SURVEY=on` to additionally log a `{command, at}` line to `.toolkit/claude-token-optimisation/bash-summary-survey.jsonl` for every command that misses the allowlist, without running or otherwise touching that command. Off by default. Use it to mine your own project's real usage for candidate additions to the allowlist above.
