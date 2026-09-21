import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(
	new URL("../hooks/summarize-bash.mjs", import.meta.url),
);

function runHook(toolInput, cwd) {
	const r = spawnSync(process.execPath, [hook], {
		input: JSON.stringify({ tool_input: toolInput }),
		encoding: "utf8",
		cwd,
	});
	return r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
}

test("summarizes an allowlisted command prefixed with a worktree cd", () => {
	const repo = mkdtempSync(join(tmpdir(), "toolkit-"));
	spawnSync("git", ["init"], { cwd: repo });
	const output = runHook({ command: `cd "${repo}" && git status` }, repo);
	assert.ok(output, "expected the hook to deny and summarize the command");
	assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
	assert.match(
		output.hookSpecificOutput.permissionDecisionReason,
		/branch|working tree clean/,
	);
});

test("passes through an unrecognised command unchanged", () => {
	const output = runHook({ command: "echo hello" }, process.cwd());
	assert.equal(output, undefined);
});
