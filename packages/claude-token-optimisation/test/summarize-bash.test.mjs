import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(
	new URL("../hooks/summarize-bash.mjs", import.meta.url),
);

function runHook(toolInput, cwd, env = {}) {
	const r = spawnSync(process.execPath, [hook], {
		input: JSON.stringify({ tool_input: toolInput }),
		encoding: "utf8",
		cwd,
		env: { ...process.env, ...env },
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

test("survey is off by default: an unmatched command leaves no log", () => {
	const cwd = mkdtempSync(join(tmpdir(), "toolkit-"));
	const output = runHook({ command: "echo hello" }, cwd);
	assert.equal(output, undefined);
	assert.equal(existsSync(join(cwd, ".toolkit")), false);
});

test("TOOLKIT_BASH_SUMMARY_SURVEY=on records an unmatched command without running it", () => {
	const cwd = mkdtempSync(join(tmpdir(), "toolkit-"));
	const marker = join(cwd, "should-not-exist");
	const output = runHook({ command: `touch "${marker}"` }, cwd, {
		TOOLKIT_BASH_SUMMARY_SURVEY: "on",
	});
	assert.equal(output, undefined, "an unmatched command still passes through");
	assert.equal(
		existsSync(marker),
		false,
		"the survey must not execute the command",
	);
	const logPath = join(
		cwd,
		".toolkit",
		"claude-token-optimisation",
		"bash-summary-survey.jsonl",
	);
	const entries = readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].command, `touch "${marker}"`);
});
