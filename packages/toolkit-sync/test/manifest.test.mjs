import assert from "node:assert/strict";
import test from "node:test";
import {
	globToRegExp,
	matchManifest,
	parseManifest,
} from "../src/manifest.mjs";

test("globToRegExp matches a single-star segment but not across slashes", () => {
	const re = globToRegExp("src/*.mjs");
	assert.equal(re.test("src/index.mjs"), true);
	assert.equal(re.test("src/nested/index.mjs"), false);
});

test("globToRegExp ** matches across directories", () => {
	const re = globToRegExp("src/**");
	assert.equal(re.test("src/index.mjs"), true);
	assert.equal(re.test("src/nested/deep/index.mjs"), true);
	assert.equal(re.test("test/index.mjs"), false);
});

test("globToRegExp anchors **/ to a path-segment boundary before the following literal", () => {
	const re = globToRegExp("src/**/vendor.mjs");
	assert.equal(re.test("src/vendor.mjs"), true);
	assert.equal(re.test("src/a/vendor.mjs"), true);
	assert.equal(re.test("src/notvendor.mjs"), false);
	assert.equal(re.test("src/a/xvendor.mjs"), false);
});

test("matchManifest returns only files under the declared surface", () => {
	const paths = [
		"README.md",
		"src/index.mjs",
		"test/index.test.mjs",
		"package.json",
	];
	const matched = matchManifest(paths, ["README.md", "src/**"]);
	assert.deepEqual(matched, ["README.md", "src/index.mjs"]);
});

test("parseManifest rejects a manifest with no include globs", () => {
	assert.throws(() => parseManifest("{}"), /include/);
	assert.throws(() => parseManifest('{"include":[]}'), /include/);
});

test("parseManifest accepts a well-formed manifest", () => {
	const manifest = parseManifest('{"include":["README.md"]}');
	assert.deepEqual(manifest.include, ["README.md"]);
});

test("toolkit-sync's own manifest is valid and matches its real, vendorable files", async () => {
	const { readFileSync, readdirSync, statSync } = await import("node:fs");
	const { join, relative } = await import("node:path");
	const root = new URL("..", import.meta.url).pathname;
	const manifest = parseManifest(
		readFileSync(join(root, "toolkit-manifest.json"), "utf8"),
	);
	const walk = (dir) =>
		readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = join(dir, entry.name);
			return entry.isDirectory() ? walk(full) : [relative(root, full)];
		});
	const matched = matchManifest(walk(root), manifest.include);
	assert.ok(matched.includes("README.md"));
	assert.ok(matched.includes("package.json"));
	assert.ok(matched.includes("src/cli.mjs"));
	assert.ok(matched.includes("claude/skills/toolkit-upgrade/SKILL.md"));
	assert.ok(matched.includes("codex/skills/toolkit-upgrade/SKILL.md"));
	assert.ok(
		matched.every((path) => !path.startsWith("test/")),
		"manifest must not vendor this package's own tests",
	);
	assert.ok(statSync(join(root, "src", "cli.mjs")).isFile());
});
