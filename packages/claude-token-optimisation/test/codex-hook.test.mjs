import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rewrite } from "../codex/hooks/pre-tool-use.mjs";

test("Codex hook rewrites an allowlisted command once and preserves tool options", () => {
	const input = {
		tool_name: "Bash",
		tool_input: { command: "git status", workdir: "/tmp/project" },
	};
	const result = rewrite(input);
	assert.equal(result.hookSpecificOutput.permissionDecision, "allow");
	assert.equal(result.hookSpecificOutput.updatedInput.workdir, "/tmp/project");
	assert.match(
		result.hookSpecificOutput.updatedInput.command,
		/summarize-command\.mjs/,
	);
	assert.equal(
		rewrite({ ...input, tool_input: result.hookSpecificOutput.updatedInput }),
		null,
	);
});

test("Codex hook leaves other tools and commands unchanged", () => {
	assert.equal(
		rewrite({ tool_name: "Bash", tool_input: { command: "git diff" } }),
		null,
	);
	assert.equal(
		rewrite({
			tool_name: "apply_patch",
			tool_input: { command: "git status" },
		}),
		null,
	);
});

test("rewritten Codex command retains a failed command's full output and exit status", () => {
	const root = mkdtempSync(join(tmpdir(), "codex-hook-"));
	const command = rewrite({
		tool_name: "Bash",
		tool_input: { command: "git status" },
	}).hookSpecificOutput.updatedInput.command;
	const result = spawnSync(command, {
		shell: true,
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 128);
	assert.match(result.stdout, /fatal: not a git repository/);
});
