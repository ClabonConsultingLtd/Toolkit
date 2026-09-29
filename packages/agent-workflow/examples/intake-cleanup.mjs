// Example `cleanupCommand` for toolkit-intake.json: removes the Docker Compose
// project a ticket worktree starts under its default name. Copy it into the
// repository (for example scripts/intake-cleanup.mjs) and add any explicit
// `-p` project names your own scripts use to `projects`.
//
// Called as: node intake-cleanup.mjs <worktreePath> <branch> <ticketNumber>
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const [worktree] = process.argv.slice(2);
if (!worktree) {
	console.error("usage: intake-cleanup.mjs WORKTREE BRANCH TICKET");
	process.exit(2);
}
// Compose's default project name: the directory name, lowercased, keeping
// only letters, digits, dashes and underscores.
const projects = [basename(worktree).toLowerCase().replace(/[^a-z0-9_-]/g, "")];
for (const project of projects) {
	const result = spawnSync(
		"docker",
		["compose", "-p", project, "down", "--volumes", "--remove-orphans"],
		{ cwd: worktree, encoding: "utf8" },
	);
	// No Docker on this machine means nothing to clean up.
	if (result.error?.code === "ENOENT") process.exit(0);
	if (result.status !== 0) {
		console.error(`${project}: ${(result.stderr || "").trim()}`);
		process.exitCode = 1;
	}
}
