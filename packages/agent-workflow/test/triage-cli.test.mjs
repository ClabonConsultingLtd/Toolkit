import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute } from "../src/triage-cli.mjs";

const TABLE = `
| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| \`needs-triage\` | \`needs-triage\` | x |
| \`needs-info\` | \`needs-info\` | x |
| \`ready-for-agent\` | \`ready-for-agent\` | x |
| \`ready-for-human\` | \`ready-for-human\` | x |
| \`wontfix\` | \`wontfix\` | x |
`;

test("labels command resolves a repo's triage-labels.md", () => {
	const root = mkdtempSync(join(tmpdir(), "triage-cli-"));
	const path = join(root, "triage-labels.md");
	writeFileSync(path, TABLE);
	const result = execute("labels", { path });
	assert.deepEqual(result.mapping["ready-for-agent"], "ready-for-agent");
	assert.deepEqual(result.statusLabels, [
		"needs-triage",
		"needs-info",
		"ready-for-agent",
		"ready-for-human",
		"wontfix",
	]);
});

test("labels command requires a path", () => {
	assert.throws(
		() => execute("labels", {}),
		/path to the repo's triage-labels/,
	);
});

test("lock and unlock round-trip through the CLI", () => {
	const root = mkdtempSync(join(tmpdir(), "triage-cli-"));
	const lockDir = join(root, ".toolkit", "triage");
	const acquired = execute("lock", { lockDir });
	assert.equal(acquired.acquired, true);
	const contended = execute("lock", { lockDir });
	assert.equal(contended.acquired, false);
	const released = execute("unlock", { lockDir });
	assert.equal(released.released, true);
	assert.equal(execute("lock", { lockDir }).acquired, true);
});

test("unknown command is rejected", () => {
	assert.throws(() => execute("bogus", {}), /unknown command: bogus/);
});
