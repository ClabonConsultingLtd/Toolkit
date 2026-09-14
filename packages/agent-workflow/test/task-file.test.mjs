import assert from "node:assert/strict";
import test from "node:test";
import { parseTask } from "../src/task-file.mjs";

test("parses declared editable files", () => {
	const t = parseTask(
		"# Task\n\nEditable:\n- src/a.ts\n\n## Instruction\nAdd a test.",
		"C:/workspace",
	);
	assert.deepEqual([...t.editable], ["src/a.ts"]);
	assert.equal(t.instruction, "Add a test.");
});
test("rejects path escape", () =>
	assert.throws(
		() =>
			parseTask("Editable:\n- ../x.ts\n\n## Instruction\nx", "C:/workspace"),
		/escapes/,
	));
