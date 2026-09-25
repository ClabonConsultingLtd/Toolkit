import assert from "node:assert/strict";
import test from "node:test";
import {
	ensureLines,
	ensureSection,
	formatJson,
	mergeClaudeSettings,
	mergeScripts,
} from "../src/merge.mjs";

test("ensureLines appends only missing lines and adds a final newline", () => {
	assert.deepEqual(ensureLines("", [".toolkit/"]), {
		text: ".toolkit/\n",
		changed: true,
	});
	assert.deepEqual(ensureLines("node_modules", [".toolkit/"]), {
		text: "node_modules\n.toolkit/\n",
		changed: true,
	});
	assert.equal(ensureLines("a\r\n.toolkit/\r\n", [".toolkit/"]).changed, false);
});

test("ensureSection appends a section once", () => {
	const first = ensureSection("# Project\n", "## Context use", "Follow it.");
	assert.equal(first.text, "# Project\n\n## Context use\n\nFollow it.\n");
	assert.equal(
		ensureSection(first.text, "## Context use", "Other").changed,
		false,
	);
	assert.equal(
		ensureSection("", "## Context use", "Follow it.").text,
		"## Context use\n\nFollow it.\n",
	);
	// A heading at another level with the same text counts as present.
	assert.equal(
		ensureSection("### Context use\n", "## Context use", "x").changed,
		false,
	);
});

const readHook = {
	matcher: "Read",
	hooks: [{ type: "command", command: "node guard.mjs" }],
};

test("mergeClaudeSettings adds hooks and rules without duplicating them", () => {
	const existing = {
		model: "opus",
		permissions: { allow: ["Bash(git status)"] },
		hooks: {
			PreToolUse: [
				{
					matcher: "Edit",
					hooks: [{ type: "command", command: "node other.mjs" }],
				},
			],
		},
	};
	const first = mergeClaudeSettings(existing, {
		hooks: { PreToolUse: [readHook] },
		allow: ["Bash(git status)", "Bash(git diff:*)"],
	});
	assert.equal(first.changed, true);
	assert.equal(first.settings.model, "opus");
	assert.deepEqual(first.settings.permissions.allow, [
		"Bash(git status)",
		"Bash(git diff:*)",
	]);
	assert.equal(first.settings.hooks.PreToolUse.length, 2);
	assert.equal(existing.hooks.PreToolUse.length, 1, "input is not mutated");

	const second = mergeClaudeSettings(first.settings, {
		hooks: { PreToolUse: [readHook] },
		allow: ["Bash(git diff:*)"],
	});
	assert.equal(second.changed, false);
});

test("mergeClaudeSettings recognises a hook command under another matcher", () => {
	const settings = {
		hooks: {
			PreToolUse: [
				{
					matcher: "Read|Grep",
					hooks: [{ type: "command", command: "node guard.mjs" }],
				},
			],
		},
	};
	assert.equal(
		mergeClaudeSettings(settings, { hooks: { PreToolUse: [readHook] } })
			.changed,
		false,
	);
});

test("mergeScripts adds new scripts and reports conflicts", () => {
	const result = mergeScripts(
		{ name: "app", scripts: { test: "vitest", "implement-batch": "custom" } },
		{
			"implement-ticket": "node a.mjs",
			"implement-batch": "node b.mjs",
			test: "vitest",
		},
	);
	assert.deepEqual(result.added, ["implement-ticket"]);
	assert.deepEqual(result.conflicts, ["implement-batch"]);
	assert.equal(result.pkg.scripts["implement-batch"], "custom");
	assert.deepEqual(mergeScripts(undefined, { a: "b" }).pkg, {
		scripts: { a: "b" },
	});
});

test("formatJson keeps the file's indentation", () => {
	assert.equal(formatJson({ a: 1 }), '{\n\t"a": 1\n}\n');
	assert.equal(formatJson({ a: 1 }, '{\n  "b": 2\n}\n'), '{\n  "a": 1\n}\n');
});
