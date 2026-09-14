import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyEdits, parseBlocks, prepareEdits } from "../src/blocks.mjs";

test("declared file is applied", () => {
	const root = mkdtempSync(join(tmpdir(), "workflow-"));
	writeFileSync(join(root, "a.txt"), "old");
	const b = parseBlocks(
		"@@ a.txt @@\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE",
		new Set(["a.txt"]),
	);
	applyEdits(prepareEdits(root, b));
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "new");
});
test("undeclared file rejected", () =>
	assert.throws(
		() =>
			parseBlocks(
				"@@ b.txt @@\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE",
				new Set(["a.txt"]),
			),
		/undeclared/,
	));
test("ambiguous search is rejected before any write", () => {
	const root = mkdtempSync(join(tmpdir(), "workflow-"));
	writeFileSync(join(root, "a.txt"), "old old");
	const b = parseBlocks(
		"@@ a.txt @@\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE",
		new Set(["a.txt"]),
	);
	assert.throws(() => prepareEdits(root, b), /ambiguous/);
	assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "old old");
});
