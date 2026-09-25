---
name: context-optimisation
description: Keep broad repository reads and routine command output concise while preserving paths to full evidence. Use for large factual exploration or noisy successful checks.
---

# Context optimisation

For broad factual exploration, use targeted search and narrow file reads. If delegation is available and authorized, give a read-only agent a precise question and use the same evidence format as the [shared bulk-reader guidance](../../../agents/bulk-reader.md). Keep architecture, debugging, security judgments, and edits with the primary agent.

For routine successful commands, use the package's `summarize-command.mjs` wrapper when its narrow allowlist applies. It stores complete output locally and prints a concise summary; failures print full output. Read the saved log if detail is needed. Do not apply it to arbitrary commands or use it to hide verification evidence.

Claude Code's automatic hooks are host-specific and are not installed for Codex. This skill provides the equivalent workflow explicitly.
