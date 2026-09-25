import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("installs agent, hooks and settings fragment", () => {
	const root = mkdtempSync(join(tmpdir(), "toolkit-")),
		cli = fileURLToPath(new URL("../install.mjs", import.meta.url)),
		r = spawnSync(process.execPath, [cli, root], { encoding: "utf8" });
	assert.equal(r.status, 0);
	for (const file of [
		"CONTEXT-POLICY.md",
		"agents/bulk-reader.md",
		"hooks/guard-large-read.mjs",
		"hooks/summarize-bash.mjs",
		"hooks/command-summary.mjs",
		"settings.toolkit-token-optimisation.json",
	])
		assert.ok(existsSync(join(root, ".claude", file)));
	const fragment = readFileSync(
		join(root, ".claude", "settings.toolkit-token-optimisation.json"),
		"utf8",
	);
	assert.match(
		fragment,
		/"command": "node \\"\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/guard-large-read\.mjs\\""/,
	);
	assert.doesNotMatch(fragment, /"args"/);
});

test("reinstalls idempotently and replaces exec-form hook entries", () => {
	const root = mkdtempSync(join(tmpdir(), "toolkit-")),
		claude = join(root, ".claude"),
		cli = fileURLToPath(new URL("../install.mjs", import.meta.url));
	mkdirSync(claude);
	const other = { type: "command", command: "echo other" };
	writeFileSync(
		join(claude, "settings.json"),
		JSON.stringify(
			{
				model: "example",
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash",
							hooks: [
								{
									type: "command",
									command: "node",
									args: ["C:/old/path/.claude/hooks/summarize-bash.mjs"],
									timeout: 30,
								},
								other,
							],
						},
					],
				},
			},
			null,
			2,
		),
	);
	for (let run = 0; run < 2; run += 1)
		assert.equal(
			spawnSync(process.execPath, [cli, root], { encoding: "utf8" }).status,
			0,
		);
	const text = readFileSync(join(claude, "settings.json"), "utf8");
	assert.match(text, /^ {2}"model"/m);
	const settings = JSON.parse(text);
	assert.equal(settings.model, "example");
	assert.deepEqual(settings.hooks.PreToolUse[0].hooks, [
		{
			type: "command",
			command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/summarize-bash.mjs"',
			timeout: 30,
		},
		other,
	]);
});
