// Launched by tools/agent-workflow ticket-launch / ticket-batch with one
// argument: a ticket file path (local Markdown) or an issue number (GitHub).
// Runs Claude Code headless on that ticket. Edit the prompt to suit the
// repository; the runner only cares that the ticket ends up "done".
import { spawnSync } from "node:child_process";

const ticket = process.argv[2];
if (!ticket) {
	console.error("usage: node scripts/claude-ticket.mjs TICKET");
	process.exit(2);
}

const shared = `Follow AGENTS.md and the docs under docs/agents/. Work on the current git branch; do not switch branches, push, or merge.
Run the project's tests and checks. Commit your work with a message that names the ticket.
If you cannot finish, or a check fails that you cannot fix, leave the status unchanged, explain why in the ticket, and stop.`;

const prompt = /^\d+$/.test(ticket)
	? `Implement GitHub issue #${ticket}. Read it with: gh issue view ${ticket} --comments
${shared}
When every acceptance criterion is met and the checks pass, run:
gh issue edit ${ticket} --remove-label ready-for-agent --add-label done
and comment on the issue with a summary of the change.`
	: `Implement the ticket in this file: ${ticket}
Read the feature's spec.md (in the folder above this ticket's issues/ folder) first.
${shared}
When every acceptance criterion is met and the checks pass, tick its checkboxes and change its status line to exactly:
**Status:** done`;

const result = spawnSync("claude", ["-p", "--permission-mode", "acceptEdits"], {
	input: prompt,
	stdio: ["pipe", "inherit", "inherit"],
	// On Windows, claude may be a .cmd shim that needs a shell to resolve.
	shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
