import assert from "node:assert/strict";
import test from "node:test";
import {
	declaredFiles,
	displayPath,
	overlappingPaths,
} from "../src/ticket-files.mjs";

const paths = (body) => declaredFiles(body)?.map(displayPath) ?? null;

test("reads a Files or Touches section, list items and backticks", () => {
	assert.deepEqual(
		paths(
			"## Problem\nx\n\n## Files\n- `src/core/a.mjs` (parser)\n- ./src/b.mjs — the CLI\n* docs/\n\n## Notes\n`src/other.mjs`",
		),
		["src/core/a.mjs", "src/b.mjs", "docs/**"],
	);
	assert.deepEqual(paths("## Touches\nsrc/a.mjs, src/lib/**/*.mjs"), [
		"src/a.mjs",
		"src/lib/**",
	]);
	assert.deepEqual(paths("Intro\n**Files:** `a.json`, `b/c.md`\n"), [
		"a.json",
		"b/c.md",
	]);
});
test("accepts a Files line written as a list item", () => {
	assert.deepEqual(
		paths(
			"## Implementation recommendation\n- **Claude:** `Sonnet / medium`\n- **Files:** `a/b.ts`, `c/d.ts`\n",
		),
		["a/b.ts", "c/d.ts"],
	);
	assert.deepEqual(paths("* Touches: src/x.mjs"), ["src/x.mjs"]);
});
test("a None declaration is declared and empty, not blind", () => {
	assert.deepEqual(paths("## Files\nNone"), []);
});
test("falls back to backticked paths in acceptance criteria", () => {
	assert.deepEqual(
		paths(
			"## Acceptance criteria\n- [ ] `src/core/a.mjs` parses `api.issue` output\n- run `pnpm test`; see `https://example.com/x`\n\n## Other\n`src/z.mjs`",
		),
		["src/core/a.mjs"],
	);
	assert.equal(paths("## Acceptance criteria\n- `api.issue` works"), null);
	assert.equal(paths("No declaration here, only `src/a.mjs`."), null);
	assert.equal(paths(undefined), null);
});
test("overlap compares files and directory prefixes on segment boundaries", () => {
	const of = (body) => declaredFiles(`## Files\n${body}`);
	assert.deepEqual(
		overlappingPaths(of("src/a.mjs\nsrc/b.mjs"), of("src/b.mjs")),
		["src/b.mjs"],
	);
	assert.deepEqual(overlappingPaths(of("src/core/"), of("src/core/x.mjs")), [
		"src/core/**",
	]);
	assert.deepEqual(overlappingPaths(of("src/core/x.mjs"), of("src/**")), [
		"src/core/x.mjs",
	]);
	assert.deepEqual(
		overlappingPaths(of("src/core/"), of("src/corex/a.mjs")),
		[],
	);
	assert.deepEqual(overlappingPaths(of("src/a.mjs"), of("src/a.mjsx")), []);
	assert.deepEqual(overlappingPaths(of("src/a.mjs"), of("**/*.md")), [
		"src/a.mjs",
	]);
});
