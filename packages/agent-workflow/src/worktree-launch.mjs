import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [ticket, rootArg, ...flags] = process.argv.slice(2);
if (!ticket || !rootArg)
	throw new Error(
		"usage: node worktree-launch.mjs TICKET WORKTREE_ROOT [--dry-run]",
	);
const root = resolve(rootArg),
	name = basename(ticket)
		.replace(/\.md$/, "")
		.replace(/[^\w.-]/g, "-"),
	destination = join(root, name);
if (existsSync(destination))
	throw new Error(`worktree already exists: ${destination}`);
if (flags.includes("--dry-run")) {
	console.log(`git worktree add -b ${name} ${destination}`);
	process.exit(0);
}
mkdirSync(root, { recursive: true });
const result = spawnSync("git", ["worktree", "add", "-b", name, destination], {
	stdio: "inherit",
});
if (result.status !== 0) process.exitCode = result.status ?? 1;
