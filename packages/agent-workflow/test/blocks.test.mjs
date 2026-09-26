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
test("replacement text is inserted literally", () => {
	const root = mkdtempSync(join(tmpdir(), "workflow-"));
	writeFileSync(join(root, "a.sh"), "before\nold\nafter\n");
	const replacement = 'echo "$$ $& $` $\' $1"';
	const b = parseBlocks(
		`@@ a.sh @@\n<<<<<<< SEARCH\nold\n=======\n${replacement}\n>>>>>>> REPLACE`,
		new Set(["a.sh"]),
	);
	applyEdits(prepareEdits(root, b));
	assert.equal(
		readFileSync(join(root, "a.sh"), "utf8"),
		`before\n${replacement}\nafter\n`,
	);
});
test("a response with an incomplete block is rejected, not partially applied", () => {
	// Seen from a local model: the second block lost its ======= separator.
	// Applying only the first block would leave a half-done edit.
	const text = [
		"@@ a.ts @@",
		"<<<<<<< SEARCH",
		"  retries: number;",
		"=======",
		"  retries: number;",
		"  verbose: boolean;",
		">>>>>>> REPLACE",
		"@@ a.ts @@",
		"<<<<<<< SEARCH",
		"    retries: MAX_RETRIES,",
		"+    verbose: false,",
		">>>>>>> REPLACE",
	].join("\n");
	assert.throws(
		() => parseBlocks(text, new Set(["a.ts"])),
		/incomplete SEARCH\/REPLACE block/,
	);
});
test("a stray block terminator rejects the response", () => {
	// Real local-model output: a duplicated, lowercase terminator after the
	// first block. The blocks themselves parse, but the response is malformed
	// and its second edit was wrong, so none of it should be applied.
	const text = [
		"@@ a.ts @@",
		"<<<<<<< SEARCH",
		"  retries: number;",
		"=======",
		"  retries: number;",
		"  verbose?: boolean;",
		">>>>>>> REPLACE",
		">>>>>>> replace",
		"@@ a.ts @@",
		"<<<<<<< SEARCH",
		"export function f() {",
		"=======",
		"export function f() {",
		"  return 1;",
		">>>>>>> REPLACE",
	].join("\n");
	assert.throws(
		() => parseBlocks(text, new Set(["a.ts"])),
		/incomplete SEARCH\/REPLACE block/,
	);
});
