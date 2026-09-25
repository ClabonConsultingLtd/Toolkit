# Context use policy

This is the shared guidance for coding agents that consume Toolkit. It applies to Claude Code and Codex; runtime hooks are provider-specific.

## Reads

- Search for symbols and paths first. Read the smallest range that answers the current question.
- For broad factual exploration of a large file or a group of files, use a read-only helper when one is available. Ask it for an evidence-based map and exact follow-up ranges.
- Read those exact ranges in the primary session before changing code or verifying a result. Keep debugging, architecture, security review, edits, and acceptance decisions with the primary agent.
- Do not use an unrestricted `cat` or equivalent Bash command to bypass a large-read guard. A targeted shell read is fine when exact lines are needed.
- Reading a whole file in consecutive chunks after the large-read guard blocks it is still an untargeted read. Search for the section you need instead.
- Before viewing an image, read its dimensions or metadata, and crop or downscale it to the region you need. Avoid viewing many large images in one session.

## Command output

- Summarize routine successful output only when the command is known to be safe to run once and its full output is retained in a local log.
- Preserve exit status. On failure, show enough diagnostics to act and keep a path to the complete output. Avoid `test-command | tail` without `pipefail`, which can hide a failing test exit status.
- Leave interactive, background, and unrecognized commands alone. Never rerun a command just to obtain a shorter transcript.

## Long-running commands

- Wait with long intervals rather than polling frequently.
- Report to the user when the command starts, completes, or fails, not with each progress check.
- Ask before re-running a suite that takes more than about 20 minutes. Prefer the failing subset and the saved log.

## Runtime adapters

Claude Code can use the included `bulk-reader`, large-read guard, and narrow Bash summary hook. Its Bash hook executes an allowlisted command once, records the complete output, and returns a concise success result; unmatched commands pass through.

Codex should start with these same read and output practices in `AGENTS.md`. Codex already offers tool output limits and context compaction, and its hook input and result controls differ from Claude Code's. Do not install the Claude hook scripts as Codex hooks. Add a Codex hook only after session measurements show a repeated, safe target that the existing tool output limits do not address. If one is justified, share the command classifier and summary formatting as pure functions, with separate Claude and Codex hook adapters and tests for each provider's protocol.
