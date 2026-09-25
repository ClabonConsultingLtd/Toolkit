# Context optimisation for Claude and Codex

Integration assets for keeping broad reads and routine successful command output from consuming the primary session's context. Claude Code and Codex use host-specific hooks around shared summary logic; Codex also has an explicit skill and command wrapper.

The agent-neutral rules for reads and command output live in [CONTEXT-POLICY.md](CONTEXT-POLICY.md). Installation copies it to `.claude/CONTEXT-POLICY.md`; consuming repositories can point both `AGENTS.md` and `CLAUDE.md` there instead of maintaining two versions of the guidance. The hooks below are Claude Code adapters.

## Included assets

- `agents/bulk-reader.md`: a read-only subagent for factual exploration of large files or file groups.
- `hooks/guard-large-read.mjs`: asks the primary agent to delegate an untargeted large read, while allowing subagents and targeted reads. It also asks for a cropped or downscaled copy of a large image.
- `hooks/summarize-bash.mjs`: runs a deliberately narrow allowlist of commands, retains full output in a local log, and returns only a summary on success. It never summarizes a failure.

## Install

Run `node install.mjs <target-repository>`. It copies the agent and hooks into the target’s `.claude/hooks` directory and writes a `settings.toolkit-token-optimisation.json` fragment, if one does not exist, for the project owner to merge into its Claude settings. Its hook entries use the shell command form, `"command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/<hook>.mjs\""`, so the settings stay portable across checkouts and operating systems. Re-running the installer is safe: it refreshes the copied assets and, in the fragment, `.claude/settings.json` and `.claude/settings.local.json`, replaces older exec-form entries (`"command": "node", "args": [".../<hook>.mjs"]`) for these hooks with the shell form. Other settings are left unchanged.

For Codex, symlink `codex/skills/context-optimisation` from a persistent Toolkit checkout into `${CODEX_HOME:-$HOME/.codex}/skills/context-optimisation`. The skill uses the same bulk-reader guidance and the `summarize-command.mjs` wrapper. For an allowlisted command, run `node /absolute/Toolkit/packages/claude-token-optimisation/summarize-command.mjs git status` (or another command from the allowlist below). The wrapper writes full successful output to `.toolkit/claude-token-optimisation/bash-summary-logs`; failures print full output, or the requested `tail`/`head` lines with a log path, and retain their exit status.

For automatic command summarization in Codex, copy the `PreToolUse` entry from [`codex/hooks.example.json`](codex/hooks.example.json) into a trusted repository's `.codex/hooks.json` (or your user-level `~/.codex/hooks.json`). Replace `YOUR_TOOLKIT_DIRECTORY` with this package's absolute directory; retain other hooks already in the file. Codex requires review and trust of the new hook definition through `/hooks` before it runs. The hook rewrites only the shared narrow command allowlist to the wrapper, so the command executes once. It does not intercept broad reads or alter failed command output. The skill works without the hook.

Set `BULK_READER_MIN_LINES` to change the large-read threshold; it defaults to 350 lines. Set `READ_GUARD_MAX_IMAGE_BYTES` to change the image threshold for `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` and `.bmp` files; it defaults to 524288 bytes (512 KiB), and `0` disables the image check. File size is only a rough proxy for an image's context cost.

The bash summary hook writes raw successful-command logs under `.toolkit/claude-token-optimisation/bash-summary-logs` in the current repository by default. Set `TOOLKIT_STATE_DIR` to relocate runtime state.

Set `TOOLKIT_BASH_SUMMARY_SURVEY=on` to additionally log a `{command, at}` line to `.toolkit/claude-token-optimisation/bash-summary-survey.jsonl` for every command that misses the allowlist, without running or otherwise touching that command. Off by default. Use it to mine your own project's real usage for candidate additions to the allowlist above.

The summary allowlist is intentionally small: exact `git status`, `pnpm -r list --depth -1`, one-file `vitest run` commands (optionally with `-t <name>`), and `tsc --noEmit` (optionally via `npx` or `pnpm exec`, with `-p <path>`). Before matching, the hooks strip common wrappers: a `cd <dir> &&` or `set -o pipefail;` prefix, a leading `timeout N` (or `Ns`), and a trailing `2>&1`, `| tail -N` or `| head -N`. The `cd` and `timeout` are kept when the command runs, but the pipeline is dropped, so a failing exit status cannot be masked; on failure the output is cut to the requested `tail`/`head` lines, with the exit status and a path to the full log. When a command does not match, the hook does nothing. Do not broaden it to arbitrary test pipelines or background tasks; prefer a command that runs once, keeps its exit status, and stores the full log. In particular, `test-command | tail` without `pipefail` can report success when the test failed.
