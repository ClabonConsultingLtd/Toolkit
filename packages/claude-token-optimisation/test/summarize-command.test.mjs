import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../summarize-command.mjs", import.meta.url);

test("Codex command wrapper keeps full output on command failure", () => {
	const root = mkdtempSync(join(tmpdir(), "summary-command-"));
	const result = spawnSync(
		process.execPath,
		[script.pathname, "git", "status"],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(result.status, 128);
	assert.match(result.stdout, /fatal: not a git repository/);
});

test("Codex command wrapper drops a tail pipeline so failure keeps its exit status", () => {
	const root = mkdtempSync(join(tmpdir(), "summary-command-"));
	const result = spawnSync(
		process.execPath,
		[script.pathname, "git status 2>&1 | tail -1"],
		{
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
		},
	);
	assert.equal(result.status, 128);
	assert.match(result.stdout, /not a git repository/);
	const log = /Full raw output: (.+)/.exec(result.stderr)?.[1];
	assert.ok(log && existsSync(log));
});

test("Codex command wrapper summarizes success and saves raw output", () => {
	const root = mkdtempSync(join(tmpdir(), "summary-command-"));
	assert.equal(
		spawnSync("git", ["init", root], { encoding: "utf8" }).status,
		0,
	);
	const result = spawnSync(
		process.execPath,
		[script.pathname, "git", "status"],
		{ cwd: root, encoding: "utf8" },
	);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /working tree clean/);
	const log = /Full raw output: (.+)/.exec(result.stdout)?.[1];
	assert.ok(log && existsSync(log));
});

test("Codex command wrapper rejects commands outside the shared allowlist", () => {
	const result = spawnSync(
		process.execPath,
		[script.pathname, "echo", "hello"],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /allowlist/);
});
