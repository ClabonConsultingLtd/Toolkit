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
test("parses declared read-only context files alongside editable", () => {
	const t = parseTask(
		"Editable:\n- src/a.ts\n\nContext:\n- docs/template.ts\n\n## Instruction\nFollow the template.",
		"C:/workspace",
	);
	assert.deepEqual([...t.editable], ["src/a.ts"]);
	assert.deepEqual([...t.context], ["docs/template.ts"]);
});
test("rejects a path listed as both editable and context", () =>
	assert.throws(
		() =>
			parseTask(
				"Editable:\n- src/a.ts\n\nContext:\n- src/a.ts\n\n## Instruction\nx",
				"C:/workspace",
			),
		/both Editable and Context/,
	));
test("context defaults to empty when the section is absent", () => {
	const t = parseTask(
		"Editable:\n- src/a.ts\n\n## Instruction\nx",
		"C:/workspace",
	);
	assert.equal(t.context.size, 0);
});
