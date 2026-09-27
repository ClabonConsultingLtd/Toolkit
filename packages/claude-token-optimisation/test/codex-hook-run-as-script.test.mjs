import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("Codex pre-tool-use hook runs as a script from a directory whose path contains a space", () => {
	const root = mkdtempSync(join(tmpdir(), "codex-hook-"));
	const spaced = join(root, "has space");
	mkdirSync(join(spaced, "codex", "hooks"), { recursive: true });
	mkdirSync(join(spaced, "hooks"), { recursive: true });
	cpSync(
		join(packageRoot, "codex", "hooks", "pre-tool-use.mjs"),
		join(spaced, "codex", "hooks", "pre-tool-use.mjs"),
	);
	cpSync(
		join(packageRoot, "hooks", "command-summary.mjs"),
		join(spaced, "hooks", "command-summary.mjs"),
	);
	const result = spawnSync(
		process.execPath,
		[join(spaced, "codex", "hooks", "pre-tool-use.mjs")],
		{
			encoding: "utf8",
			input: JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: "git status" },
			}),
		},
	);
	// A previously-matched exit(0)-silent-no-op never reads stdin and prints
	// nothing; this proves main() actually ran and rewrote the command.
	assert.equal(result.status, 0);
	assert.match(result.stdout, /summarize-command\.mjs/);
});
